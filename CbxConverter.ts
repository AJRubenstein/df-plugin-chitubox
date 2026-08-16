import * as THREE from 'three';
import {
  DragonfruitImportFormat,
  Roots,
  Trunk,
  Branch,
  Brace,
  Knot,
  Joint,
  Leaf,
  Segment,
  Vec3,
  Twig,
  Stick,
  ContactDisk,
} from '@/supports/types';
import { SupportSettings } from '@/supports/Settings';
import { getJointDiameter } from '@/supports/constants';
import { calculateDiskThickness } from '@/supports/SupportPrimitives/ContactDisk/contactDiskUtils';
import { recomputeLeafContactConeAxisAndLength } from '@/supports/state';
import { ContactCone } from '@/supports/SupportPrimitives/ContactCone/types';
import { createContactAssembly } from './converter/contactAssembly';
import { v4 as uuidv4 } from 'uuid';

/**
 * Converts parsed Cbx supports (CHAIN model) into DragonFruit's import
 * format. Each parsed support is a vertical chain — [base pad] → pillar → knot →
 * one-or-more tips — which maps onto DragonFruit anatomy as:
 *
 *     Roots (from base pad if present, else settings-sized; on the plate)
 *       → Trunk
 *           → segment 0: root → knot joint   (bottomJoint undefined = "on Root")
 *           → segment 1: knot joint → primary tip's socket joint
 *           → contactCone (primary/tallest tip, built by createContactAssembly)
 *     + per EXTRA tip: a Knot on the shaft + a Branch with its own contactCone
 *
 * Cone + socket construction is delegated to createContactAssembly — the SAME
 * helper convertLysData uses — so cone profile, socket placement, and disk
 * offset match the rest of the app. It is fed a synthesized `tipSettings`
 * carrying the AUTHORED tip diameters and length, routed through its geometric
 * path (Cbx stores no per-support contact normal; the model mesh, if
 * supplied, lets the helper raycast the true surface normal).
 *
 * Authored anatomy used (all verified against real data, see
 * chitubox-plugin-findings.md):
 *   pillar (sub-3): authored shaft diameter (paramA×2), top = knot center.
 *   knot   (sub-9): Joint at authored center Z, authored sphere diameter.
 *   tip    (sub-1): contactDiameter (small, on the model) = paramA×2;
 *                   bodyDiameter (larger socket) = paramB×2;
 *                   authored cone length = contactZ − attachZ (passed as
 *                   tipSettings.length — critical: prevents a default-length
 *                   cone from pushing the socket below the plate on short supports).
 *   base   (sub-4): Roots cone, bottom radius on the plate.
 *
 * Placement: the parser returns world-frame Z. This converter RAFT-NORMALIZES —
 * it subtracts the raft top (min pillar/base bottom across the model) so support
 * bases land on DragonFruit's plate at z = 0 and DF applies its own raft. modelId
 * is a placeholder; the host reassigns it via reassignModelId() after conversion.
 */

// Shared CBX types, constants, and the debug helper now live in converter/types.
// Re-exported here so existing importers of CbxConverter keep working unchanged.
import {
  LOG_PREFIX,
  CBX_DEBUG,
  cbxDebug,
  CBX_TIP_DEFAULTS,
  CBX_ROOT_DEFAULTS,
  CBX_SHAFT_DEFAULTS,
  CBX_BRACE_ATTACH_TOL_MM,
  CbxTip,
  CbxBasePad,
  CbxSupport,
  CbxTransform,
  CbxBrace,
  CbxTwig,
  CbxJunctionBranch,
  CbxModelInput,
} from './converter/types';
export type {
  CbxTip,
  CbxBasePad,
  CbxSupport,
  CbxTransform,
  CbxBrace,
  CbxTwig,
  CbxJunctionBranch,
  CbxModelInput,
} from './converter/types';

/**
 * The raft-top height (world frame) for a set of supports: the minimum base/
 * pillar bottom Z. Subtracting it raft-normalizes the scene so support bases
 * land on DragonFruit's plate at z = 0.
 *
 * Exported so the file-type bridge can apply the SAME offset to the model mesh's
 * transform — keeping geometry and supports in the same frame. Returns 0 when
 * there are no supports (nothing to anchor against).
 */
// computeRaftZ / computeModelLift live in converter/clusterTransform; re-exported
// here so existing importers of CbxConverter keep working.
export { computeRaftZ, computeModelLift } from './converter/clusterTransform';

/** Normalize a Vec3; returns a unit-Z fallback for a zero-length input. */
// Geometry helpers extracted to converter/geometryHelpers.
import {
  normalizeVec,
  synthSupportForTip,
  synthTipSettings,
  buildTipFromKnot,
  buildNativeBranch,
  applyTrunkDiameterProfile,
  computeLinearTLocal,
  LEAF_MAX_SHAFT_MM,
} from './converter/geometryHelpers';
import {
  applyZShift as clusterApplyZShift,
  applyXYShift as clusterApplyXYShift,
  seatRootsOnPlate as clusterSeatRootsOnPlate,
} from './converter/clusterTransform';
import { classifySupportTips, centerCoincidentKnots, collapseDegenerateJoints } from './converter/sanityPasses';

/** Output of converting one support: the entities it contributes. */
interface BuiltSupport {
  root: Roots;
  trunk: Trunk;
  knots: Knot[];
  branches: Branch[];
  leaves: Leaf[];
}

/**
 * Convert one parsed chain support into DragonFruit entities using AUTHORED
 * anatomy. `raftZ` is subtracted from all Z values so the support base lands on
 * DragonFruit's plate (z = 0) and DF applies its own raft.
 *
 *   base pad (sub-4)  → Roots (authored radii/heights when present)
 *   pillar (sub-3)    → Trunk shaft segment, authored diameter
 *   knot (sub-9)      → Joint at authored center Z, authored diameter
 *   primary tip       → trunk terminal cone (authored length)
 *   extra tips        → Knot on the shaft + Branch with its own cone
 */
/**
 * Build a Stick: a model-to-model support whose body spans between two contact
 * points on the model, rather than rising from the plate.
 *
 * The two cones are the authored downward tip and the LOWEST upward tip -- the
 * pair that actually bracket the pillar. Any further upward tips are extra
 * contacts on the hub and are returned as leaves/branches so nothing is lost.
 */
function buildStick(
  s: CbxSupport,
  modelId: string,
  raftZ: number,
  tipDefaults: typeof CBX_TIP_DEFAULTS,
  mesh?: THREE.Mesh,
): { stick: Stick; knots: Knot[]; branches: Branch[]; leaves: Leaf[] } | null {
  const down = s.downwardTip;
  if (!down || s.tips.length === 0) return null;

  const z = (worldZ: number) => worldZ - raftZ;
  const shaftDiameter = s.pillarDiameter;

  // Lowest upward tip pairs with the downward one; the rest hang off the hub.
  const sorted = [...s.tips].sort((a, b) => a.contactZ - b.contactZ);
  const [upTip, ...extraTips] = sorted;

  const contactA = new THREE.Vector3(upTip.x, upTip.y, z(upTip.contactZ));
  const contactB = new THREE.Vector3(down.x, down.y, z(down.contactZ));
  const hubTop: Vec3 = { x: s.pillarX, y: s.pillarY, z: z(s.pillarTopZ) };
  const hubBottom: Vec3 = { x: s.pillarX, y: s.pillarY, z: z(s.pillarBottomZ) };

  const assemblyA = createContactAssembly(
    synthSupportForTip(upTip, hubTop), contactA, hubTop,
    synthTipSettings(upTip, shaftDiameter), tipDefaults, mesh,
    false, false, null, true,
  );
  // The downward cone needs its AUTHORED axis. Left to infer one,
  // createContactAssembly solves the socket from the tip length and puts it
  // BELOW the contact -- correct for a cone reaching up to the model, inverted
  // here -- so the cone pointed the wrong way, the disk floated clear of the
  // surface, and the body was stretched and slanted to reach it.
  //
  // The record gives both endpoints exactly: the socket sits on the pillar
  // bottom (0.0000 away in XY and Z) and the contact is 26.8 degrees off
  // vertical from there. Pass that direction as the authored normal, with
  // preferAuthoredNormal on, so the body stays vertical and only the short cone
  // tilts -- matching how Chitubox draws it.
  const downAxis = new THREE.Vector3(
    down.socketX - down.x,
    down.socketY - down.y,
    z(down.attachZ) - z(down.contactZ),
  ).normalize();
  const assemblyB = createContactAssembly(
    { ...synthSupportForTip(down, hubBottom), tipNormal: { x: downAxis.x, y: downAxis.y, z: downAxis.z } },
    contactB, hubBottom,
    synthTipSettings(down, shaftDiameter), tipDefaults, mesh,
    true, false, null, false,
  );

  const jointA: Joint = { id: uuidv4(), pos: hubTop, diameter: getJointDiameter(shaftDiameter) };
  const jointB: Joint = { id: uuidv4(), pos: hubBottom, diameter: getJointDiameter(shaftDiameter) };

  const stick: Stick = {
    id: uuidv4(),
    modelId,
    segments: [
      {
        id: uuidv4(),
        type: 'straight',
        diameter: shaftDiameter,
        bottomJoint: jointB,
        topJoint: jointA,
      },
    ],
    contactConeA: assemblyA.contactCone,
    contactConeB: assemblyB.contactCone,
  };

  // Remaining upward contacts become leaves/branches on a hub knot, exactly as
  // extra tips do on a trunk.
  const knots: Knot[] = [];
  const branches: Branch[] = [];
  const leaves: Leaf[] = [];

  if (extraTips.length > 0) {
    const hubKnot: Knot = {
      id: uuidv4(),
      parentShaftId: stick.segments[0].id,
      pos: hubTop,
      diameter: getJointDiameter(shaftDiameter),
      _importHint: 'preserve',
    };
    knots.push(hubKnot);

    for (const tip of extraTips) {
      const { leaf, branch } = buildTipFromKnot(
        tip, hubKnot, hubTop,
        new THREE.Vector3(tip.x, tip.y, z(tip.contactZ)),
        shaftDiameter, modelId, tipDefaults, mesh,
      );
      if (leaf) leaves.push(leaf);
      if (branch) branches.push(branch);
    }
  }

  return { stick, knots, branches, leaves };
}

function buildSupport(
  s: CbxSupport,
  modelId: string,
  raftZ: number,
  tipDefaults: typeof CBX_TIP_DEFAULTS,
  rootDefaults: typeof CBX_ROOT_DEFAULTS,
  shaftDefaults: typeof CBX_SHAFT_DEFAULTS,
  mesh?: THREE.Mesh,
): BuiltSupport {
  const z = (worldZ: number) => worldZ - raftZ; // raft-normalize into plate frame

  const shaftDiameter = Number.isFinite(s.pillarDiameter) && s.pillarDiameter > 0
    ? s.pillarDiameter
    : shaftDefaults.diameterMm;

  const px = s.pillarX;
  const py = s.pillarY;
  const pillarBottom = z(s.pillarBottomZ); // ≈ 0 after normalization
  const knotCenter = z(s.knotCenterZ);

  // --- Roots: from authored base pad if present, else a settings-sized pad. ---
  const rootId = uuidv4();
  let root: Roots;
  if (s.isForkJunction) {
    // Fork junction: the pillar's base is mid-air at a brace convergence, held up
    // by the converging struts rather than the plate. It is NOT grounded, so it
    // must not render a base "cup". Emit a zero-size root at the convergence: the
    // shaft starts exactly there (the host begins the trunk at root.z + diskHeight
    // + coneHeight = the convergence) and the braces attaching to this shaft keep
    // the junction visually connected — but no disk/cone geometry is drawn.
    root = {
      id: rootId,
      modelId,
      transform: { pos: { x: px, y: py, z: pillarBottom }, rot: { x: 0, y: 0, z: 0, w: 1 } },
      diameter: 0,
      diskHeight: 0,
      coneHeight: 0,
    };
  } else if (s.base) {
    const padBottom = z(s.base.bottomZ);
    const padTop = z(s.base.topZ);
    root = {
      id: rootId,
      modelId,
      transform: { pos: { x: px, y: py, z: padBottom }, rot: { x: 0, y: 0, z: 0, w: 1 } },
      diameter: s.base.bottomRadius * 2, // wide end on the plate
      diskHeight: 0,
      coneHeight: Math.max(0, padTop - padBottom),
    };
  } else {
    root = {
      id: rootId,
      modelId,
      transform: { pos: { x: px, y: py, z: pillarBottom }, rot: { x: 0, y: 0, z: 0, w: 1 } },
      diameter: rootDefaults.diameterMm,
      diskHeight: rootDefaults.diskHeightMm,
      coneHeight: rootDefaults.coneHeightMm,
    };
  }

  // --- Knot joint: authored center Z + authored sphere diameter. ---
  const knotJoint: Joint = {
    id: uuidv4(),
    pos: { x: px, y: py, z: knotCenter },
    diameter: Number.isFinite(s.knotDiameter) && s.knotDiameter > 0
      ? s.knotDiameter
      : getJointDiameter(shaftDiameter),
  };

  // Tips are pre-sorted tallest-first by the parser; primary = first.
  // A support may have NO model tips: it is a grounded pillar that exists only to
  // host braces / pillar-to-pillar links (which never touch the model). Emit it as
  // a contactless trunk — shaft from root up to the knot, no contact cone — so the
  // braces have a real shaft to attach to. Without this the pillar would be dropped
  // and its braces orphaned.
  const hasModelTip = s.tips.length > 0;

  if (!hasModelTip) {
    const soloSegment: Segment = {
      id: uuidv4(),
      type: 'straight',
      diameter: shaftDiameter,
      bottomJoint: undefined, // on Root
      topJoint: knotJoint,
    };
    const trunk: Trunk = {
      id: uuidv4(),
      modelId,
      rootId,
      baseDiameterMm: shaftDiameter,
      segments: [soloSegment],
      contactCone: undefined,
    };
    return { root, trunk, knots: [], branches: [], leaves: [] };
  }

  const [primaryTip, ...extraTips] = s.tips;
  const isMultiTip = extraTips.length > 0;
  const rootTopZ = root.transform.pos.z + (root.diskHeight ?? 0) + (root.coneHeight ?? 0);
  const knotJointDiameter = Number.isFinite(s.knotDiameter) && s.knotDiameter > 0
    ? s.knotDiameter
    : getJointDiameter(shaftDiameter);
  const MIN_BASE_SEG_MM = 1.0;
  const MIN_TRANSITION_SEG_MM = 0.5;

  const knots: Knot[] = [];
  const branches: Branch[] = [];
  const leaves: Leaf[] = [];

  // --- Trunk for the PRIMARY tip (same for single- and multi-tip supports). ---
  // LYS-style trunk: root → joint0 (knee) → socket → contact cone. For multi-tip
  // supports the extra tips become native Branches off a knot on this trunk's shaft
  // (built below), each growing up to its own contact — the arrangement DF produces
  // when you place additional supports off a trunk. The trunk is always a normal,
  // cone-terminated trunk so the engine recognises it as a properly-formed support.
  const provisionalKneeZ = Math.max(rootTopZ + 0.05, knotCenter);
  const provisionalKnee: Vec3 = { x: px, y: py, z: provisionalKneeZ };
  const primary = createContactAssembly(
    synthSupportForTip(primaryTip, provisionalKnee),
    new THREE.Vector3(primaryTip.x, primaryTip.y, z(primaryTip.contactZ)),
    provisionalKnee,
    synthTipSettings(primaryTip, shaftDiameter),
    tipDefaults,
    mesh,
    false, false, null, true,
  );

  const socketZ = primary.socketJoint.pos.z;
  const segments: Segment[] = [];
  if (socketZ - rootTopZ > MIN_BASE_SEG_MM + MIN_TRANSITION_SEG_MM) {
    const minJointZ = rootTopZ + MIN_BASE_SEG_MM;
    const maxJointZ = socketZ - MIN_TRANSITION_SEG_MM;
    const jointZ = Math.max(minJointZ, Math.min(knotCenter, maxJointZ));
    const joint0: Joint = {
      id: uuidv4(),
      pos: { x: px, y: py, z: jointZ },
      diameter: knotJointDiameter,
    };
    segments.push(
      { id: uuidv4(), type: 'straight', diameter: shaftDiameter, bottomJoint: undefined, topJoint: joint0 },
      { id: uuidv4(), type: 'straight', diameter: shaftDiameter, bottomJoint: joint0, topJoint: primary.socketJoint },
    );
  } else {
    segments.push({
      id: uuidv4(),
      type: 'straight',
      diameter: shaftDiameter,
      bottomJoint: undefined, // on Root
      topJoint: primary.socketJoint,
    });
  }

  const trunk: Trunk = {
    id: uuidv4(),
    modelId,
    rootId,
    baseDiameterMm: shaftDiameter,
    segments,
    contactCone: primary.contactCone,
  };

  // --- Extra tips → native Leaves or Branches off a knot on the trunk shaft. ---
  // Use the LYS leaf-vs-branch decision per tip: shaftLength = dist(knot→contact) −
  // tipLen. If ≤ 0.2mm there's no room for a shaft → Leaf (cone straight from the
  // knot). Otherwise → Branch (single segment knot → socket + short native cone).
  // All extra tips share one knot on the shaft (Chitu roots them at the pillar top).
  if (extraTips.length > 0) {
    const topSegment = segments[segments.length - 1];
    // Place the shared knot at the AUTHORED knot height (knotCenter) — the LYS
    // "authored attach point" — not the primary cone's socket. Chitubox roots all
    // tips of a multi-tip support at this shared height; using it lowers the knot to
    // where the supports actually fan out, so leaves/branches approach their contacts
    // from below (vertical) instead of meeting the shaft side-on at a right angle.
    // Clamp to stay on the trunk's top segment (between its bottom joint and socket).
    const segBotZ = topSegment.bottomJoint?.pos.z ?? rootTopZ;
    const segTopZ = topSegment.topJoint?.pos.z ?? primary.socketJoint.pos.z;
    const knotZ = Math.max(segBotZ + 0.05, Math.min(knotCenter, segTopZ - 0.05));
    const sharedKnotPos: Vec3 = { x: px, y: py, z: knotZ };
    const sharedKnot: Knot = {
      id: uuidv4(),
      parentShaftId: topSegment.id,
      pos: sharedKnotPos,
      diameter: getJointDiameter(shaftDiameter),
      _importHint: 'preserve',
    };
    knots.push(sharedKnot);

    for (const tip of extraTips) {
      const { leaf, branch } = buildTipFromKnot(
        tip,
        sharedKnot,
        sharedKnotPos,
        new THREE.Vector3(tip.x, tip.y, z(tip.contactZ)),
        shaftDiameter,
        modelId,
        tipDefaults,
        mesh,
      );
      if (leaf) leaves.push(leaf);
      if (branch) branches.push(branch);
    }
  }

  // Apply the native trunk diameter profile to EVERY trunk (single- and multi-tip).
  // For multi-tip it splits the shaft at branch knots and thickens bottom-up. For
  // single-tip it still does the essential job of sizing the top socket joint to the
  // SHAFT diameter (not the narrow cone body) — without it the shaft (0.80) necks
  // down to a cone-body joint (0.60) then the cone (0.50), giving the abrupt
  // "capped"/collared look. This mirrors the host applying the profile on edit (the
  // recompute the mousewheel triggers), so the imported trunk renders correctly.
  applyTrunkDiameterProfile(trunk, rootTopZ, knots, branches);

  return { root, trunk, knots, branches, leaves };
}

/** Resolve tip defaults from live settings if provided, else module fallback. */
function resolveTipDefaults(settings?: SupportSettings): typeof CBX_TIP_DEFAULTS {
  const t = (settings as any)?.tip;
  if (!t) return CBX_TIP_DEFAULTS;
  return {
    lengthMm: Number.isFinite(t.lengthMm) ? t.lengthMm : CBX_TIP_DEFAULTS.lengthMm,
    bodyDiameterMm: Number.isFinite(t.bodyDiameterMm) ? t.bodyDiameterMm : CBX_TIP_DEFAULTS.bodyDiameterMm,
    contactDiameterMm: Number.isFinite(t.contactDiameterMm) ? t.contactDiameterMm : CBX_TIP_DEFAULTS.contactDiameterMm,
    diskThicknessMm: Number.isFinite(t.diskThicknessMm) ? t.diskThicknessMm : CBX_TIP_DEFAULTS.diskThicknessMm,
    maxStandoffMm: Number.isFinite(t.maxStandoffMm) ? t.maxStandoffMm : CBX_TIP_DEFAULTS.maxStandoffMm,
    standoffAngleThreshold: Number.isFinite(t.standoffAngleThreshold) ? t.standoffAngleThreshold : CBX_TIP_DEFAULTS.standoffAngleThreshold,
    penetrationMm: Number.isFinite(t.penetrationMm) ? t.penetrationMm : CBX_TIP_DEFAULTS.penetrationMm,
  };
}

function resolveRootDefaults(settings?: SupportSettings): typeof CBX_ROOT_DEFAULTS {
  const r = (settings as any)?.roots;
  if (!r) return CBX_ROOT_DEFAULTS;
  return {
    diameterMm: Number.isFinite(r.diameterMm) ? r.diameterMm : CBX_ROOT_DEFAULTS.diameterMm,
    diskHeightMm: Number.isFinite(r.diskHeightMm) ? r.diskHeightMm : CBX_ROOT_DEFAULTS.diskHeightMm,
    coneHeightMm: Number.isFinite(r.coneHeightMm) ? r.coneHeightMm : CBX_ROOT_DEFAULTS.coneHeightMm,
  };
}

function resolveShaftDefaults(settings?: SupportSettings): typeof CBX_SHAFT_DEFAULTS {
  const sh = (settings as any)?.shaft;
  if (!sh) return CBX_SHAFT_DEFAULTS;
  return {
    diameterMm: Number.isFinite(sh.diameterMm) ? sh.diameterMm : CBX_SHAFT_DEFAULTS.diameterMm,
  };
}

export class CbxConverter {
  /**
   * Converts one parsed Cbx model (geometry + supports) into DragonFruit's
   * import format. Mirrors LysConverter.convert's role and output type so the
   * file-type bridge can treat both identically.
   *
   * @param model    Parsed model bundle (supports already in world space).
   * @param settings Active support settings; supplies tip/root/shaft defaults
   *                 where Cbx doesn't author a value.
   * @param mesh     Optional model mesh; if present, createContactAssembly can
   *                 raycast the true surface normal for the contact point.
   */
  static convert(
    model: CbxModelInput,
    settings?: SupportSettings,
    mesh?: THREE.Mesh,
  ): DragonfruitImportFormat {
    const placeholderModelId = uuidv4();
    const supports = model.supports ?? [];

    const tipDefaults = resolveTipDefaults(settings);
    const rootDefaults = resolveRootDefaults(settings);
    const shaftDefaults = resolveShaftDefaults(settings);

    console.log(`${LOG_PREFIX} convert:start`, {
      modelIndex: model.index,
      filename: model.filename,
      supportCount: supports.length,
      hasMesh: !!mesh,
    });

    const roots: Roots[] = [];
    const trunks: Trunk[] = [];
    const knots: Knot[] = [];
    const branches: Branch[] = [];
    const sticks: Stick[] = [];
    const leaves: Leaf[] = [];
    const braces: Brace[] = [];

    // Supports are emitted in the SAME world frame as the model geometry (raw +
    // zOffset), i.e. raftZ = 0 here. This is deliberate: the file-type bridge
    // then shifts BOTH the supports (via applyZShift) and the model into the
    // host's render frame using a single offset (the geometry bbox center), so
    // they stay locked together. Raft-normalizing supports independently here
    // would put them in a different frame from the (non-normalized) geometry and
    // desync them by the raft thickness. The buildSupport raftZ parameter is kept
    // for flexibility but passed 0.
    const raftZ = 0;

    // Track each built pillar so braces can attach to the right shaft. A brace
    // endpoint lands on a pillar's XY; we match by nearest XY and reference that
    // trunk's lower shaft segment (root → knot), placing the brace knot at the
    // authored brace-endpoint Z.
    // Track each built pillar's segments (with world-space endpoints) so a brace
    // endpoint can attach to the CLOSEST segment in 3D — mirroring the host's
    // findClosestSegment — rather than always the lower segment. For most braces
    // the lower (root→knot) segment is correct, but an endpoint high on the pillar
    // can fall on the knot→tip segment; picking per-endpoint keeps our attachment
    // consistent with what the interactive snap would choose.
    interface SegRef {
      segmentId: string;
      start: Vec3; // world-space segment start (lower)
      end: Vec3; // world-space segment end (upper)
    }
    interface ShaftRef {
      px: number;
      py: number;
      segments: SegRef[];
    }
    const shaftRefs: ShaftRef[] = [];
    // Fork-junction trunks: built as normal trunks so all tip/branch/leaf logic
    // works, but their base is mid-air (held by converging braces, not the plate).
    // We record them here and, AFTER braces create the convergence knots, re-anchor
    // each to a convergence knot and drop its floating root — otherwise the host's
    // SmartPlacementV2 sees a root off the plate and re-routes it down, spiking
    // through the model.
    const forkJunctionTrunks: Array<{ trunk: Trunk; rootId: string; basePos: Vec3 }> = [];

    // Pre-pass: classify each support's tips into model-contact tips vs
    // support-to-support brace tips (a Chitubox cross-brace lands a tip on a
    // neighbouring shaft, not the model). Brace tips are collected and emitted as
    // DragonFruit Braces after the shafts exist; importing them as model cones would
    // tunnel through the model to reach empty space (the "arch through the foot").
    const pendingSupportBraces: Array<{
      sourcePillarX: number; sourcePillarY: number;
      targetPillarX: number; targetPillarY: number;
      contact: Vec3; diameter: number;
    }> = [];
    const supportsForBuild: CbxSupport[] = supports.map((s) => {
      const { modelTips, braceTips } = classifySupportTips(s, supports, mesh);
      for (const bt of braceTips) {
        pendingSupportBraces.push({
          sourcePillarX: s.pillarX,
          sourcePillarY: s.pillarY,
          targetPillarX: bt.targetPillarX,
          targetPillarY: bt.targetPillarY,
          contact: { x: bt.tip.x, y: bt.tip.y, z: bt.tip.contactZ - raftZ },
          diameter: Number.isFinite(bt.tip.bodyDiameter) && bt.tip.bodyDiameter > 0
            ? bt.tip.bodyDiameter
            : shaftDefaults.diameterMm,
        });
      }
      // A support must keep at least one tip to remain a valid support; if every
      // tip was a brace tip, leave it unchanged (its tips were genuine — the
      // classifier only diverts tips that clearly miss the model).
      if (braceTips.length === 0 || modelTips.length === 0) return s;
      return { ...s, tips: modelTips };
    });

    for (const s of supportsForBuild) {
      try {
        // A support with a downward contact spans between two parts of the
        // model rather than standing on the plate: DragonFruit models that as a
        // Stick, whose two contact cones are the downward tip and the lowest
        // upward tip, with the pillar as its body. Any remaining upward tips
        // become leaves/branches on the hub via the normal path below.
        if (s.downwardTip && s.tips.length > 0) {
          const stick = buildStick(s, placeholderModelId, raftZ, tipDefaults, mesh);
          if (stick) {
            sticks.push(stick.stick);
            knots.push(...stick.knots);
            branches.push(...stick.branches);
            leaves.push(...stick.leaves);
            continue;
          }
        }

        const built = buildSupport(
          s, placeholderModelId, raftZ, tipDefaults, rootDefaults, shaftDefaults, mesh,
        );
        roots.push(built.root);
        trunks.push(built.trunk);
        knots.push(...built.knots);
        branches.push(...built.branches);
        leaves.push(...built.leaves);

        if (s.isForkJunction) {
          forkJunctionTrunks.push({
            trunk: built.trunk,
            rootId: built.root.id,
            basePos: { x: s.pillarX, y: s.pillarY, z: built.root.transform.pos.z },
          });
        }

        // Reconstruct each segment's world endpoints from its joints, matching how
        // the host's getTrunkSegmentEndpoints derives them:
        //   - segment start: bottomJoint.pos, else (index 0) the root top, else
        //     the previous segment's topJoint.
        //   - segment end:   topJoint.pos, else the contact-cone socket.
        const px = s.pillarX;
        const py = s.pillarY;
        const rootTopZ = built.root.transform.pos.z
          + (built.root.diskHeight ?? 0) + (built.root.coneHeight ?? 0);
        const segRefs: SegRef[] = [];
        const segs = built.trunk.segments;
        for (let i = 0; i < segs.length; i++) {
          const seg = segs[i];
          const start: Vec3 = seg.bottomJoint?.pos
            ?? (i === 0
              ? { x: px, y: py, z: rootTopZ }
              : segs[i - 1].topJoint?.pos ?? { x: px, y: py, z: rootTopZ });
          const coneSocket = built.trunk.contactCone?.pos;
          // For a cone-less (multi-tip) trunk the shaft ends in the terminal knot,
          // so fall back to that knot's position for the top segment's end.
          const terminalKnotPos = built.knots.find((k) => k.parentShaftId === seg.id)?.pos;
          const end: Vec3 = seg.topJoint?.pos
            ?? coneSocket
            ?? terminalKnotPos
            ?? { x: start.x, y: start.y, z: start.z + 10 };
          segRefs.push({ segmentId: seg.id, start, end });
        }
        if (segRefs.length === 0) {
          segRefs.push({
            segmentId: built.trunk.id,
            start: { x: px, y: py, z: rootTopZ },
            end: { x: px, y: py, z: rootTopZ + 10 },
          });
        }
        shaftRefs.push({ px, py, segments: segRefs });
      } catch (err) {
        // Best-effort: skip a malformed support rather than failing the import.
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`${LOG_PREFIX} skipped a support: ${message}`);
      }
    }

    // --- Braces: diagonal struts between two pillar shafts. ---
    // For each brace endpoint, find the nearest pillar by XY, then the closest
    // segment of that pillar in 3D, drop a Knot there (parentShaftId + t), and link
    // the two knots with a DragonFruit Brace.
    const modelBraces = model.braces ?? [];
    let bracesAttached = 0;
    let bracesDropped = 0;
    const nearestShaft = (x: number, y: number): ShaftRef | null => {
      let best: ShaftRef | null = null;
      let bestD = Infinity;
      for (const r of shaftRefs) {
        const d = (r.px - x) ** 2 + (r.py - y) ** 2;
        if (d < bestD) { bestD = d; best = r; }
      }
      // Only accept a match within a small radius (endpoints sit on pillar XY).
      return best && bestD <= CBX_BRACE_ATTACH_TOL_MM * CBX_BRACE_ATTACH_TOL_MM ? best : null;
    };

    // Project a world point onto a pillar's segments and return the closest one,
    // with the fractional position t along that segment (0 = start, 1 = end).
    // This mirrors the host's findClosestSegment: the knot's parentShaftId + t make
    // it a true SLIDING attachment, so the brace tracks its pillars when they move.
    const projectToShaft = (
      ref: ShaftRef,
      p: Vec3,
    ): { segmentId: string; t: number; pos: Vec3 } => {
      let best: { segmentId: string; t: number; pos: Vec3; dist: number } | null = null;
      for (const seg of ref.segments) {
        const ax = seg.start.x, ay = seg.start.y, az = seg.start.z;
        const bx = seg.end.x, by = seg.end.y, bz = seg.end.z;
        const abx = bx - ax, aby = by - ay, abz = bz - az;
        const abLenSq = abx * abx + aby * aby + abz * abz;
        let t = 0;
        if (abLenSq > 1e-8) {
          t = ((p.x - ax) * abx + (p.y - ay) * aby + (p.z - az) * abz) / abLenSq;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
        }
        const cx = ax + abx * t, cy = ay + aby * t, cz = az + abz * t;
        const dist = (cx - p.x) ** 2 + (cy - p.y) ** 2 + (cz - p.z) ** 2;
        if (!best || dist < best.dist) {
          best = { segmentId: seg.segmentId, t, pos: { x: cx, y: cy, z: cz }, dist };
        }
      }
      // ref always has at least one segment, so best is non-null here.
      return best!;
    };

    for (const b of modelBraces) {
      const shaftA = nearestShaft(b.ax, b.ay);
      const shaftB = nearestShaft(b.bx, b.by);
      if (!shaftA || !shaftB || shaftA === shaftB) {
        bracesDropped++;
        continue;
      }

      const diameter = Number.isFinite(b.diameter) && b.diameter > 0
        ? b.diameter
        : shaftDefaults.diameterMm;
      const jointDiameter = getJointDiameter(diameter);

      // Authored brace endpoints (raft-frame). pos is kept authored for visual
      // fidelity; parentShaftId + t come from the closest segment so the host
      // re-derives position from the shaft.
      const endpointA: Vec3 = { x: b.ax, y: b.ay, z: b.az - raftZ };
      const endpointB: Vec3 = { x: b.bx, y: b.by, z: b.bz - raftZ };
      const projA = projectToShaft(shaftA, endpointA);
      const projB = projectToShaft(shaftB, endpointB);

      const knotA: Knot = {
        id: uuidv4(),
        parentShaftId: projA.segmentId,
        t: projA.t,
        pos: endpointA,
        diameter: jointDiameter,
        _importHint: 'braceImported',
      };
      const knotB: Knot = {
        id: uuidv4(),
        parentShaftId: projB.segmentId,
        t: projB.t,
        pos: endpointB,
        diameter: jointDiameter,
        _importHint: 'braceImported',
      };
      knots.push(knotA, knotB);

      braces.push({
        id: uuidv4(),
        modelId: placeholderModelId,
        startKnotId: knotA.id,
        endKnotId: knotB.id,
        profile: { diameter },
      });
      bracesAttached++;
    }

    if (modelBraces.length > 0) {
      console.log(`${LOG_PREFIX} braces`, {
        total: modelBraces.length,
        attached: bracesAttached,
        dropped: bracesDropped,
      });
    }

    // --- Support-to-support braces (from reclassified tips) ---
    // Each pending brace connects the SOURCE support's shaft to the TARGET support's
    // shaft at the authored contact point. We project the contact onto the target
    // pillar (where the tip landed) and project a source point onto the source pillar,
    // then link them with a DragonFruit Brace — the same primitive used for authored
    // sub-3 braces. This replaces a model cone that would otherwise tunnel to the
    // off-model contact.
    let supportBracesEmitted = 0;
    for (const pb of pendingSupportBraces) {
      const targetShaft = nearestShaft(pb.targetPillarX, pb.targetPillarY);
      const sourceShaft = nearestShaft(pb.sourcePillarX, pb.sourcePillarY);
      if (!targetShaft || !sourceShaft || targetShaft === sourceShaft) {
        continue;
      }
      // Target knot: the contact projected onto the target pillar (where it landed).
      const projTarget = projectToShaft(targetShaft, pb.contact);
      // Source knot: the same height on the source pillar (so the brace spans across).
      const sourcePoint: Vec3 = { x: pb.sourcePillarX, y: pb.sourcePillarY, z: pb.contact.z };
      const projSource = projectToShaft(sourceShaft, sourcePoint);
      const jointDiameter = getJointDiameter(pb.diameter);

      const knotTarget: Knot = {
        id: uuidv4(),
        parentShaftId: projTarget.segmentId,
        t: projTarget.t,
        pos: projTarget.pos,
        diameter: jointDiameter,
        _importHint: 'braceImported',
      };
      const knotSource: Knot = {
        id: uuidv4(),
        parentShaftId: projSource.segmentId,
        t: projSource.t,
        pos: projSource.pos,
        diameter: jointDiameter,
        _importHint: 'braceImported',
      };
      knots.push(knotTarget, knotSource);
      braces.push({
        id: uuidv4(),
        modelId: placeholderModelId,
        startKnotId: knotSource.id,
        endKnotId: knotTarget.id,
        profile: { diameter: pb.diameter },
      });
      supportBracesEmitted++;
    }
    if (pendingSupportBraces.length > 0) {
      console.log(`${LOG_PREFIX} support-to-support braces`, {
        pending: pendingSupportBraces.length,
        emitted: supportBracesEmitted,
      });
    }

    // --- Fork-junction re-anchoring ---
    // A fork-junction trunk's base sits mid-air where braces converge. We built it
    // as a normal trunk on a zero-size root so its tips/branches/leaves form
    // correctly, but a root off the plate makes the host's SmartPlacementV2 re-route
    // the support down to the plate (spiking through the model). Now that the
    // converging braces have dropped knots at the convergence point, re-anchor each
    // fork trunk to the nearest convergence knot — its bottom segment becomes parented
    // to that knot (a branch off the brace network) — and drop the floating root so
    // the host no longer tries to ground it.
    let forksReanchored = 0;
    let forksRedirectedToPartner = 0;
    if (forkJunctionTrunks.length > 0) {
      const droppedRootIds = new Set<string>();
      // Knots that a brace attaches to (the convergence knots we want to anchor onto).
      const braceKnotIds = new Set<string>();
      for (const br of braces) {
        if (br.startKnotId) braceKnotIds.add(br.startKnotId);
        if (br.endKnotId) braceKnotIds.add(br.endKnotId);
      }
      // Find the ShaftRef (built earlier per support) that owns a given segment id,
      // used below to re-host a convergence knot onto the OTHER pillar's shaft.
      const findShaftRefForSegment = (segmentId: string): ShaftRef | null => {
        for (const ref of shaftRefs) {
          if (ref.segments.some((s) => s.segmentId === segmentId)) return ref;
        }
        return null;
      };
      for (const fork of forkJunctionTrunks) {
        // Anchor onto the nearest BRACE-convergence knot at the fork base. We key off
        // "a brace references this knot" rather than shaft ownership, because the
        // converging braces drop their knots onto the fork's own base segment — those
        // are exactly the knots we want, so excluding by shaft would miss them.
        let best: Knot | null = null;
        let bestD = Infinity;
        for (const k of knots) {
          if (!braceKnotIds.has(k.id)) continue;
          const d = Math.hypot(k.pos.x - fork.basePos.x, k.pos.y - fork.basePos.y, k.pos.z - fork.basePos.z);
          if (d < bestD) { bestD = d; best = k; }
        }
        // Only re-anchor if a convergence knot is genuinely at the base (within 2mm).
        if (!best || bestD > 2.0) continue;

        // The nearest-knot search above is keyed only on "a brace references this
        // knot", not on which shaft hosts it — so it almost always finds the LOCAL
        // knot the converging brace dropped on the fork's OWN base segment (it's
        // trivially the closest possible point to itself), not the genuine knot on
        // the OTHER pillar the brace actually connects to. Anchoring directly to that
        // local knot makes the branch its own parent: a self-reference that the
        // host's trunk-resolution walk can never escape (it renders fine — preserved
        // knots draw at their authored position regardless — but never resolves to a
        // trunk, so editing/selection logic that walks the parent chain breaks).
        // When the chosen knot is self-hosted, follow its brace to the other endpoint
        // and re-host a NEW knot at the SAME convergence position onto that external
        // shaft instead — same geometry, but a parent chain that actually leads
        // somewhere.
        let anchorKnot = best;
        const isSelfHosted = fork.trunk.segments.some((s) => s.id === best!.parentShaftId);
        if (isSelfHosted) {
          const hostBrace = braces.find((br) => br.startKnotId === best!.id || br.endKnotId === best!.id);
          const partnerId = hostBrace
            ? (hostBrace.startKnotId === best!.id ? hostBrace.endKnotId : hostBrace.startKnotId)
            : null;
          const partner = partnerId ? knots.find((k) => k.id === partnerId) : null;
          const partnerShaftRef = partner ? findShaftRefForSegment(partner.parentShaftId) : null;
          if (partnerShaftRef) {
            const proj = projectToShaft(partnerShaftRef, best.pos);
            anchorKnot = {
              id: uuidv4(),
              parentShaftId: proj.segmentId,
              t: proj.t,
              pos: { ...best.pos },
              diameter: best.diameter,
              _importHint: 'preserve',
            };
            knots.push(anchorKnot);
            forksRedirectedToPartner++;
          }
        }

        // Re-parent the trunk's bottom segment to the convergence knot: set its
        // bottomJoint to a joint at the knot so the shaft starts from the convergence.
        const bottomSeg = fork.trunk.segments[0];
        bottomSeg.bottomJoint = {
          id: uuidv4(),
          pos: { x: anchorKnot.pos.x, y: anchorKnot.pos.y, z: anchorKnot.pos.z },
          diameter: anchorKnot.diameter ?? getJointDiameter(bottomSeg.diameter),
        };
        // Emit the fork as a BRANCH (parented to the convergence knot), not a trunk.
        // The host routes every trunk through SmartPlacementV2, which always grounds
        // to the plate — wrong for a junction held mid-air by braces, and the cause
        // of the spikes through the model. A branch is built parented to its knot and
        // is never grounded, so the junction stays where Chitubox authored it.
        const forkBranch: Branch = {
          id: fork.trunk.id,
          modelId: fork.trunk.modelId,
          parentKnotId: anchorKnot.id,
          segments: fork.trunk.segments,
          contactCone: fork.trunk.contactCone,
        };
        branches.push(forkBranch);
        // Remove the trunk now that it's represented as a branch.
        const ti = trunks.findIndex((t) => t.id === fork.trunk.id);
        if (ti >= 0) trunks.splice(ti, 1);
        droppedRootIds.add(fork.rootId);
        forksReanchored++;
      }
      // Drop the floating roots we re-anchored.
      if (droppedRootIds.size > 0) {
        for (let i = roots.length - 1; i >= 0; i--) {
          if (droppedRootIds.has(roots[i].id)) roots.splice(i, 1);
        }
      }
      console.log(`${LOG_PREFIX} fork junctions`, {
        total: forkJunctionTrunks.length,
        reanchored: forksReanchored,
        redirectedToPartnerShaft: forksRedirectedToPartner,
        rootsDropped: droppedRootIds.size,
      });
    }

    // --- Brace-fed junction branches (multi-level support trees). ---
    // A junction is a tip-bearing knot with NO pillar of its own, reached by a
    // single diagonal brace from a grounded pillar's knot, with its tips fanning
    // out to the model. The flat pillar→knot→tips model drops these entirely, so
    // we rebuild each as a DragonFruit Branch: parented to the pillared knot the
    // brace comes from (resolved onto that pillar's shaft so the host can recompute
    // it), its first segment runs up to the junction, and the tips become contact
    // cones (primary on the branch; extras as sub-branches off a knot at the
    // junction). This recovers the whole upper tier of the support tree.
    const modelJunctions = model.junctionBranches ?? [];
    let junctionBranchesBuilt = 0;
    let junctionTipsBuilt = 0;
    let junctionDropped = 0;
    for (const jb of modelJunctions) {
      const parentPos: Vec3 = { x: jb.parentX, y: jb.parentY, z: jb.parentZ - raftZ };
      const junctionPos: Vec3 = { x: jb.junctionX, y: jb.junctionY, z: jb.junctionZ - raftZ };
      const shaftDiameter = Number.isFinite(jb.diameter) && jb.diameter > 0
        ? jb.diameter
        : shaftDefaults.diameterMm;

      // Parent the branch to the grounded pillar's shaft at the parent point. If
      // no shaft resolves there, skip (can't attach a free-floating branch).
      const parentRef = nearestShaft(parentPos.x, parentPos.y);
      if (!parentRef) { junctionDropped++; continue; }
      const proj = projectToShaft(parentRef, parentPos);
      const parentKnot: Knot = {
        id: uuidv4(),
        parentShaftId: proj.segmentId,
        t: proj.t,
        pos: parentPos,
        diameter: getJointDiameter(shaftDiameter),
        _importHint: 'preserve',
      };
      knots.push(parentKnot);

      if (jb.tips.length === 0) { junctionDropped++; continue; }

      // Native junction (Option A, same as multi-tip trunks): a Branch runs from the
      // parent knot (on the grounded pillar's shaft) up to a terminal joint at the
      // JUNCTION, a single knot sits at that junction on the branch shaft, and EVERY
      // junction tip becomes a Leaf radiating from that knot. No mid-junction joint
      // with cones fanning off at an angle — that produced the kink. The branch shaft
      // simply carries the load up to the junction knot, and the tips hang off it as
      // leaves, exactly as DF would if the junction had been hand-placed.
      const junctionTerminalJoint: Joint = {
        id: uuidv4(),
        pos: junctionPos,
        diameter: getJointDiameter(shaftDiameter),
      };
      const branchSeg: Segment = {
        id: uuidv4(),
        type: 'straight',
        diameter: shaftDiameter,
        bottomJoint: undefined, // connects to the parent knot
        topJoint: junctionTerminalJoint,
      };
      const junctionBranch: Branch = {
        id: uuidv4(),
        modelId: placeholderModelId,
        parentKnotId: parentKnot.id,
        segments: [branchSeg],
        contactCone: undefined, // shaft ends in the junction knot, not a cone
      };
      branches.push(junctionBranch);
      junctionBranchesBuilt++;

      // The single junction knot, riding the branch segment at the junction.
      // NOTE: must NOT share the `junctionPos` object with junctionTerminalJoint
      // above. applyZShift/applyXYShift dedupe JOINTS by id but iterate knots
      // separately assuming each knot owns a distinct pos object; a shared ref is
      // shifted once as the segment topJoint AND again as a knot, double-shifting
      // the whole upper junction tier by (plateX, plateY, -raftZ) into the model.
      // Clone the position so each structure owns its own pos (matches the working
      // multi-tip trunk path, which builds a fresh sharedKnotPos for its knot).
      const junctionKnot: Knot = {
        id: uuidv4(),
        parentShaftId: branchSeg.id,
        pos: { x: junctionPos.x, y: junctionPos.y, z: junctionPos.z },
        diameter: getJointDiameter(shaftDiameter),
        _importHint: 'preserve',
      };
      knots.push(junctionKnot);

      // Every junction tip radiates from the junction knot as a Leaf (short) or a
      // Branch (long: thin shaft + short native cone), same as multi-tip trunk tips.
      for (const tip of jb.tips) {
        const { leaf, branch } = buildTipFromKnot(
          tip,
          junctionKnot,
          junctionKnot.pos,
          new THREE.Vector3(tip.x, tip.y, tip.contactZ - raftZ),
          shaftDiameter,
          placeholderModelId,
          tipDefaults,
          mesh,
        );
        if (leaf) leaves.push(leaf);
        if (branch) branches.push(branch);
        junctionTipsBuilt++;
      }
    }
    if (modelJunctions.length > 0) {
      console.log(`${LOG_PREFIX} junction branches`, {
        total: modelJunctions.length,
        built: junctionBranchesBuilt,
        tips: junctionTipsBuilt,
        dropped: junctionDropped,
      });
    }

    // --- Twigs (sub-12): tiny model-to-model struts. ---
    // A twig is a short body bridging two contact points on the model. We build it
    // to match the host's own buildTwig EXACTLY (SupportTypes/Twig/twigBuilder.ts):
    //   - a minimal disk-type ContactDiskProfile (type + the 3 disk fields only),
    //   - real per-endpoint surface normals recovered from the model mesh (the
    //     authored format stores none), used to orient each disk INTO the model,
    //   - the shaft running between two joints that sit OFF the surface by the
    //     disk stand-off along each surface normal,
    //   - joints sized 1.1x the disk contact diameter, and diskLengthOverride set.
    // Matching the canonical builder removes every structural variable: the disks
    // face the model (not along the strut) and the twig renders like a native one.
    const modelTwigs = model.twigs ?? [];
    const twigs: Twig[] = [];
    const JOINT_TAPER = 1.1; // twig joint = 1.1x its disk contact diameter
    const JOINT_CLEARANCE_MM = 0.05;
    // Recover the model surface normal at a contact point. The contact sits ON the
    // model; we want the normal of the face it actually rests on, oriented OUT of the
    // solid (the direction the twig disk stands off). The earlier approach cast a
    // single ray ALONG the strut to find that face — but for a twig whose strut runs
    // nearly tangent to the surface (e.g. a contact on a near-horizontal overhang),
    // that ray skims past the local face and hits a DIFFERENT wall, yielding a normal
    // anti-aligned with the true surface. The disk cap then faces empty space instead
    // of lying flat on the model — the "disk sitting outside the model" artefact.
    //
    // Instead, probe in MANY directions and take the NEAREST hit face: that is the
    // surface the contact rests on, regardless of strut orientation. Then orient the
    // face normal outward with an inside/outside test. Raycast-only (no BVH needed),
    // matching the rest of the converter. Falls back to the strut axis on no mesh/hit.
    const STANDOFF_PROBE_MM = 0.6;
    const pointInsideModel = (p: THREE.Vector3): boolean => {
      if (!mesh) return false;
      // 6-axis ray-parity majority: robust to thin/concave regions where a single
      // axis gives a false odd-crossing. Inside iff a majority of axes report odd.
      const dirs: ReadonlyArray<readonly [number, number, number]> = [
        [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
      ];
      let votes = 0;
      const rc = new THREE.Raycaster();
      for (const d of dirs) {
        rc.set(p, new THREE.Vector3(d[0], d[1], d[2]));
        if (rc.intersectObject(mesh, false).length % 2 === 1) votes++;
      }
      return votes >= 4;
    };
    // 14 probe directions: 6 axes + 8 diagonals, enough to find the nearest face on
    // overhangs of any orientation without the cost of a full sphere of rays.
    const PROBE_DIRS: ReadonlyArray<readonly [number, number, number]> = [
      [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
      [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
      [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
    ];
    const PROBE_BACKOFF_MM = 0.4;
    // Returns the outward surface normal AND the snapped surface position (the
    // actual mesh hit point). The authored CBX twig endpoint can sit a fraction
    // of a mm off the mesh surface; snapping to the hit position — the same
    // technique createContactAssembly uses for tip contacts — ensures the disk
    // face is flush with the model surface rather than floating below it.
    const recoverSurfaceContact = (contact: Vec3, _towardOther: Vec3, fallback: Vec3): { normal: Vec3; surfacePos: Vec3 | null } => {
      if (!mesh) return { normal: fallback, surfacePos: null };
      const raycaster = new THREE.Raycaster();
      let bestNormal: THREE.Vector3 | null = null;
      let bestSurfacePos: THREE.Vector3 | null = null;
      let bestErr = Infinity;
      const origin = new THREE.Vector3();
      for (const d of PROBE_DIRS) {
        const dir = new THREE.Vector3(d[0], d[1], d[2]).normalize();
        // Start a hair behind the contact along the probe so a face we're sitting on
        // is in front of the ray; the hit nearest to the contact is the resting face.
        origin.set(contact.x, contact.y, contact.z).addScaledVector(dir, -PROBE_BACKOFF_MM);
        raycaster.set(origin, dir);
        const hits = raycaster.intersectObject(mesh, false);
        if (hits.length === 0 || !hits[0].face) continue;
        const err = Math.abs(hits[0].distance - PROBE_BACKOFF_MM);
        if (err < bestErr) {
          bestErr = err;
          bestNormal = hits[0].face.normal.clone().transformDirection(mesh.matrixWorld).normalize();
          bestSurfacePos = hits[0].point.clone();
        }
      }
      if (!bestNormal) return { normal: fallback, surfacePos: null };
      // Orient OUTWARD: a point a small stand-off along +n must be OUTSIDE the model.
      // Use the snapped surface position for the probe so the orientation test is
      // accurate even when the authored contact is slightly off the mesh surface.
      const probeOrigin = bestSurfacePos ?? new THREE.Vector3(contact.x, contact.y, contact.z);
      const probe = new THREE.Vector3(
        probeOrigin.x + bestNormal.x * STANDOFF_PROBE_MM,
        probeOrigin.y + bestNormal.y * STANDOFF_PROBE_MM,
        probeOrigin.z + bestNormal.z * STANDOFF_PROBE_MM,
      );
      if (pointInsideModel(probe)) bestNormal.multiplyScalar(-1);
      const normal: Vec3 = { x: bestNormal.x, y: bestNormal.y, z: bestNormal.z };
      const surfacePos: Vec3 | null = bestSurfacePos
        ? { x: bestSurfacePos.x, y: bestSurfacePos.y, z: bestSurfacePos.z }
        : null;
      return { normal, surfacePos };
    };

    for (const t of modelTwigs) {
      const contactDiameter = Number.isFinite(t.diameter) && t.diameter > 0
        ? t.diameter
        : shaftDefaults.diameterMm;
      const posA: Vec3 = { x: t.ax, y: t.ay, z: t.az - raftZ };
      const posB: Vec3 = { x: t.bx, y: t.by, z: t.bz - raftZ };

      // Strut axis A→B (cone axis for disk A; reversed for disk B).
      const axisA = normalizeVec({ x: posB.x - posA.x, y: posB.y - posA.y, z: posB.z - posA.z });
      const axisB = { x: -axisA.x, y: -axisA.y, z: -axisA.z };

      // Real surface normals + snapped contact positions at each end. The authored
      // CBX endpoint can sit slightly off the mesh; using the raycast hit position
      // (same as createContactAssembly does for tip contacts) closes any gap.
      const contactA = recoverSurfaceContact(posA, posB, axisB);
      const contactB = recoverSurfaceContact(posB, posA, axisA);
      const normalA = contactA.normal;
      const normalB = contactB.normal;
      const effectivePosA = contactA.surfacePos ?? posA;
      const effectivePosB = contactB.surfacePos ?? posB;

      // Minimal disk-type profile — EXACTLY the host ContactDiskProfile shape
      // (type + diskThicknessMm + maxStandoffMm + standoffAngleThreshold). No tip
      // fields: a ContactDiskProfile does not carry contact/body/length/penetration.
      const diskProfile = () => ({
        type: 'disk' as const,
        diskThicknessMm: tipDefaults.diskThicknessMm ?? 0.1,
        maxStandoffMm: tipDefaults.maxStandoffMm ?? 1.5,
        standoffAngleThreshold: tipDefaults.standoffAngleThreshold ?? Math.PI / 4,
      });
      const profA = diskProfile();
      const profB = diskProfile();

      const jointDiameterA = contactDiameter * JOINT_TAPER;
      const jointDiameterB = contactDiameter * JOINT_TAPER;

      // Disk stand-off: the larger of the angle-based disk thickness and the
      // joint radius + clearance (matches twigDiskJointStandoff).
      const standoff = (normal: Vec3, axis: Vec3, jointDia: number, prof: ReturnType<typeof diskProfile>): number => {
        const angleBased = calculateDiskThickness(normal, axis, prof);
        const radiusBased = jointDia / 2 + JOINT_CLEARANCE_MM;
        return Math.max(angleBased, radiusBased);
      };
      const thicknessA = standoff(normalA, axisA, jointDiameterA, profA);
      const thicknessB = standoff(normalB, axisB, jointDiameterB, profB);

      // Joints sit OFF the surface along each surface normal (like the host).
      // Use the snapped surface positions so the joint follows the corrected contact.
      const jointPosA: Vec3 = {
        x: effectivePosA.x + normalA.x * thicknessA,
        y: effectivePosA.y + normalA.y * thicknessA,
        z: effectivePosA.z + normalA.z * thicknessA,
      };
      const jointPosB: Vec3 = {
        x: effectivePosB.x + normalB.x * thicknessB,
        y: effectivePosB.y + normalB.y * thicknessB,
        z: effectivePosB.z + normalB.z * thicknessB,
      };

      const diskA: ContactDisk = {
        id: uuidv4(),
        pos: effectivePosA,
        surfaceNormal: normalA,
        coneAxis: axisA,
        diskLengthOverride: thicknessA,
        profile: profA,
        contactDiameterMm: contactDiameter,
      };
      const diskB: ContactDisk = {
        id: uuidv4(),
        pos: effectivePosB,
        surfaceNormal: normalB,
        coneAxis: axisB,
        diskLengthOverride: thicknessB,
        profile: profB,
        contactDiameterMm: contactDiameter,
      };

      twigs.push({
        id: uuidv4(),
        modelId: placeholderModelId,
        segments: [
          {
            id: uuidv4(),
            type: 'straight',
            diameter: contactDiameter, // legacy uniform value (taper carried by joints)
            bottomJoint: { id: uuidv4(), pos: jointPosA, diameter: jointDiameterA },
            topJoint: { id: uuidv4(), pos: jointPosB, diameter: jointDiameterB },
          },
        ],
        contactDiskA: diskA,
        contactDiskB: diskB,
      });
    }
    if (modelTwigs.length > 0) {
      console.log(`${LOG_PREFIX} twigs`, { total: modelTwigs.length });
    }

    // --- Leaf sanity pass ---------------------------------------------------
    // A Leaf is a shaft-less cone straight from the knot to the contact, valid only
    // when the knot is ~one tip-length from the contact. Some leaves are classified
    // when their knot is close, but the knot is later relocated (junction composition,
    // shaft splits) so the final knot→contact distance is much larger. A long leaf
    // has no shaft to follow the surface and tunnels straight through the model.
    // Here we re-check every leaf against its FINAL knot position and convert any
    // over-long one into a Branch (shaft knot→socket + short native cone), which
    // approaches the contact along the surface instead of cutting through.
    {
      const knotById = new Map(knots.map((k) => [k.id, k]));
      const tipLen = CBX_TIP_DEFAULTS.lengthMm;
      const keptLeaves: Leaf[] = [];
      let converted = 0;
      for (const leaf of leaves) {
        const knot = leaf.parentKnotId ? knotById.get(leaf.parentKnotId) : undefined;
        const cc = leaf.contactCone;
        if (!knot || !cc) { keptLeaves.push(leaf); continue; }
        const knotToContact = Math.hypot(cc.pos.x - knot.pos.x, cc.pos.y - knot.pos.y, cc.pos.z - knot.pos.z);
        if (knotToContact <= tipLen + LEAF_MAX_SHAFT_MM) { keptLeaves.push(leaf); continue; }

        // Over-long: rebuild as a Branch. Re-solve a short native cone + socket from
        // the knot toward the contact via createContactAssembly (the LYS contract),
        // so the cone is a short tip near the contact and the shaft carries the rest.
        const shaftDia = (cc.profile as any)?.bodyDiameterMm
          ? Math.max((cc.profile as any).bodyDiameterMm, 0.8)
          : 0.8;
        const assembly = createContactAssembly(
          { id: uuidv4(), base: { x: knot.pos.x, y: knot.pos.y, z: knot.pos.z }, tip: { x: cc.pos.x, y: cc.pos.y, z: cc.pos.z } },
          new THREE.Vector3(cc.pos.x, cc.pos.y, cc.pos.z),
          knot.pos,
          { length: tipLen, diameter: CBX_TIP_DEFAULTS.bodyDiameterMm, pointDiameter: CBX_TIP_DEFAULTS.contactDiameterMm },
          CBX_TIP_DEFAULTS,
          mesh,
          false, false, null, true,
        );
        branches.push({
          id: uuidv4(),
          modelId: leaf.modelId,
          parentKnotId: knot.id,
          segments: [
            { id: uuidv4(), type: 'straight', diameter: shaftDia, bottomJoint: undefined, topJoint: assembly.socketJoint },
          ],
          contactCone: assembly.contactCone,
        });
        converted++;
      }
      leaves.length = 0;
      leaves.push(...keptLeaves);
      if (CBX_DEBUG && converted > 0) {
        cbxDebug(`leaf sanity pass: converted ${converted} over-long leaf/leaves into branches (were tunnelling)`);
      }
    }

    // --- Knot-centering / merge sanity pass ---------------------------------
    // Resolve clusters of near-coincident brace knots on the same shaft down to one
    // shared knot, so authored brace scatter doesn't leave a fan of attach points
    // (each independently tracking its own diameter and able to drift out of sync
    // on a later edit) where the host renders a single clean attachment in Chitubox.
    // Contact (leaf/branch) knots are used as anchors but never moved or merged away.
    {
      const braceKnotIds = new Set<string>();
      for (const br of braces) {
        if (br.startKnotId) braceKnotIds.add(br.startKnotId);
        if (br.endKnotId) braceKnotIds.add(br.endKnotId);
      }
      const contactKnotIds = new Set<string>();
      for (const br of branches) {
        if (br.parentKnotId) contactKnotIds.add(br.parentKnotId);
      }
      for (const lf of leaves) {
        if (lf.parentKnotId) contactKnotIds.add(lf.parentKnotId);
      }
      const { moved: movedKnots, merged: mergedKnots, idRemap } = centerCoincidentKnots({ knots, braceKnotIds, contactKnotIds });
      if (idRemap.size > 0) {
        for (const br of braces) {
          const remappedStart = idRemap.get(br.startKnotId);
          if (remappedStart) br.startKnotId = remappedStart;
          const remappedEnd = idRemap.get(br.endKnotId);
          if (remappedEnd) br.endKnotId = remappedEnd;
        }
      }
      if (CBX_DEBUG && movedKnots > 0) {
        cbxDebug(`knot-centering pass: resolved ${movedKnots} coincident brace knot(s) onto shared shaft spots`);
      }
      if (CBX_DEBUG && mergedKnots > 0) {
        cbxDebug(`knot-merge pass: merged ${mergedKnots} duplicate brace knot(s) into shared knot ids`);
      }
    }

    // --- Degenerate-joint collapse pass ------------------------------------
    // Remove near-zero-length shaft stubs whose two end joints would render as a
    // lump of overlapping spheres at a trunk top / branch attach point. Structural
    // only: the contact cone's socket joint (and therefore every tip contact) is
    // preserved; we only drop the redundant lower joint and re-point any riding
    // knots onto the merged segment.
    {
      const collapsed = collapseDegenerateJoints({ trunks, branches, knots });
      if (CBX_DEBUG && collapsed > 0) {
        cbxDebug(`joint-collapse pass: removed ${collapsed} degenerate shaft stub(s)`);
      }
    }

    const result: DragonfruitImportFormat = {
      version: 1,
      meta: {
        source: model.filename ? `chitubox:${model.filename}` : 'chitubox_conversion',
        // Match LYS parity: the host expects {0,0,0} here (LysConverter hardcodes
        // it). The model mesh carries its own world position.
        objectCenter: { x: 0, y: 0, z: 0 },
        updatedAt: Date.now(),
      },
      roots,
      trunks,
      branches,
      leaves,
      twigs,
      sticks,
      braces,
      anchors: [],
      knots,
      kickstands: [],
    };

    console.log(`${LOG_PREFIX} convert:done`, {
      roots: result.roots.length,
      trunks: result.trunks.length,
      branches: result.branches.length,
      braces: result.braces.length,
      knots: result.knots.length,
      leaves: result.leaves.length,
      twigs: result.twigs?.length ?? 0,
      sticks: result.sticks?.length ?? 0,
      raftZ,
    });

    if (CBX_DEBUG && mesh) {
      // Self-check: sample each support shaft along its length and report any segment
      // whose interior passes THROUGH the model (odd ray-crossing parity = inside).
      // This catches "support goes straight through the model" that pure seating
      // checks miss, and names which primitive/where so we can chase it.
      const insideMesh = (p: THREE.Vector3): boolean => {
        const rc = new THREE.Raycaster(p, new THREE.Vector3(1, 0, 0));
        return rc.intersectObject(mesh, false).length % 2 === 1;
      };
      const knotById = new Map(result.knots.map((k) => [k.id, k]));
      let shaftThrough = 0;
      const sampleShaft = (label: string, segs: Segment[], parentPos: Vec3 | undefined, conePos: Vec3 | undefined) => {
        for (const s of segs) {
          const bot = s.bottomJoint?.pos ?? parentPos;
          const top = s.topJoint?.pos ?? conePos;
          if (!bot || !top) continue;
          let hitInside = 0;
          for (let i = 1; i <= 6; i++) {
            const f = i / 7;
            const p = new THREE.Vector3(bot.x + (top.x - bot.x) * f, bot.y + (top.y - bot.y) * f, bot.z + (top.z - bot.z) * f);
            if (insideMesh(p)) hitInside++;
          }
          if (hitInside >= 2) { shaftThrough++; cbxDebug(`SHAFT THROUGH MODEL (${label}): ${hitInside}/6 samples inside, bot z=${bot.z.toFixed(2)} top z=${top.z.toFixed(2)}`); }
        }
      };
      for (const t of result.trunks) sampleShaft('trunk', t.segments, t.segments[0]?.bottomJoint?.pos, t.contactCone?.pos);
      for (const br of result.branches) {
        const pk = br.parentKnotId ? knotById.get(br.parentKnotId) : undefined;
        sampleShaft('branch', br.segments, pk?.pos, br.contactCone?.pos);
      }
      cbxDebug(`penetration self-check: ${shaftThrough} shaft segment(s) pass through the model`);
    }

    return result;
  }

  /** Collects every model id referenced inside converted support payloads. */
  private static collectModelIds(data: DragonfruitImportFormat): string[] {
    const ids = new Set<string>();
    for (const root of data.roots || []) if (root?.modelId) ids.add(root.modelId);
    for (const trunk of data.trunks || []) if (trunk?.modelId) ids.add(trunk.modelId);
    for (const branch of data.branches || []) if (branch?.modelId) ids.add(branch.modelId);
    for (const leaf of data.leaves || []) if (leaf?.modelId) ids.add(leaf.modelId);
    for (const twig of data.twigs || []) if (twig?.modelId) ids.add(twig.modelId);
    for (const stick of data.sticks || []) if (stick?.modelId) ids.add(stick.modelId);
    for (const brace of data.braces || []) if (brace?.modelId) ids.add(brace.modelId);
    for (const anchor of data.anchors || []) if (anchor?.modelId) ids.add(anchor.modelId);
    return [...ids];
  }

  /**
   * Rewrites all converted entities to a single target model id. Called by the
   * file-type bridge after conversion, matching LysConverter.reassignModelId.
   *
   * EVERY top-level support entity is a SupportEntity (carries its own modelId),
   * so all of them must be reassigned — not just roots/trunks/branches. Missing
   * an entity type leaves it tagged with the placeholder model id from convert(),
   * which belongs to no displayed model: the host's support tab filters
   * interactable supports per model, so a mis-tagged entity renders as static
   * geometry but cannot be selected, and per-model model drags don't move it.
   * (This was the brace "renders but won't connect / won't move" bug — braces
   * were the one emitted type the old reassign skipped.)
   */
  static reassignModelId(data: DragonfruitImportFormat, modelId: string): void {
    if (!modelId) return;
    const before = this.collectModelIds(data);
    for (const root of data.roots) root.modelId = modelId;
    for (const trunk of data.trunks) trunk.modelId = modelId;
    for (const branch of data.branches) branch.modelId = modelId;
    for (const leaf of data.leaves) leaf.modelId = modelId;
    for (const twig of data.twigs ?? []) twig.modelId = modelId;
    for (const stick of data.sticks ?? []) stick.modelId = modelId;
    for (const brace of data.braces) brace.modelId = modelId;
    for (const anchor of data.anchors ?? []) anchor.modelId = modelId;
    console.log(`${LOG_PREFIX} reassignModelId`, {
      targetModelId: modelId,
      beforeModelIds: before,
      afterModelIds: this.collectModelIds(data),
    });
  }

  /**
   * Shift every support entity in Z by `deltaZ`. Used to move converted supports
   * into the same frame the host places the model in.
   *
   * Background: the host centers the model geometry's bounding box at the origin
   * and places it from there — it does NOT honour a transform-Z we provide, and
   * it does not move the supports with the model. So to keep supports locked to
   * the model, the bridge shifts them by the model's bbox-center Z (see
   * fileTypeHandlers). This is the CBX analogue of LYS's applySupportZOffset.
   *
   * Walks every Z-bearing field: Roots transform, Trunk/Branch segment joints,
   * contact-cone positions, and Knots. Joints shared across segments are shifted
   * once via an id set.
   */
  // Cluster transform operations live in converter/clusterTransform; these static
  // methods delegate to them to preserve the existing CbxConverter.* public API.
  static applyZShift(data: DragonfruitImportFormat, deltaZ: number): void {
    clusterApplyZShift(data, deltaZ);
  }

  static applyXYShift(data: DragonfruitImportFormat, deltaX: number, deltaY: number): void {
    clusterApplyXYShift(data, deltaX, deltaY);
  }

  static seatRootsOnPlate(data: DragonfruitImportFormat, plateZ = 0): void {
    clusterSeatRootsOnPlate(data, plateZ);
  }
}
