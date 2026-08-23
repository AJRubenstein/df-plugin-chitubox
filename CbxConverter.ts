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
 * Converts parsed Cbx supports into DragonFruit's import format. A support is a
 * chain -- [base pad] -> pillar -> knot -> tips -- becoming Roots -> Trunk with
 * a cone for the tallest tip, and a Knot + Branch for each extra one.
 *
 * Z is raft-normalised so bases land on the plate at 0; modelId is a
 * placeholder the host reassigns.
 */
// Re-exported so existing importers of CbxConverter keep working.
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
 * Raft-top height: the minimum base/pillar bottom Z. Exported so the bridge can
 * apply the same offset to the model mesh and keep both in one frame.
 */
// Re-exported so existing importers of CbxConverter keep working.
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
import { classifySupportTips, centerCoincidentKnots, collapseDegenerateJoints, dedupeCoincidentJoints } from './converter/sanityPasses';

/** Output of converting one support: the entities it contributes. */
interface BuiltSupport {
  root: Roots;
  trunk: Trunk;
  knots: Knot[];
  branches: Branch[];
  leaves: Leaf[];
  /** Ids of leaves built as an authored fan; exempt from the leaf sanity pass. */
  fanLeafIds: string[];
}

/**
 * Build a Stick: a support spanning two model contacts rather than rising from
 * the plate. Its cones are the downward tip and the lowest upward tip; further
 * upward tips return as leaves or branches on the hub.
 */
const JOINT_TAPER = 1.1; // twig joint = 1.1x its disk contact diameter
const JOINT_CLEARANCE_MM = 0.05;

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

  // The shaft is defined by the two contacts; sockets and joints fall out of
  // the solve. createContactAssembly's third argument is the opposite contact,
  // a direction hint rather than an anchor. With only one authored contact the
  // far end is a zero-length cone at the hub.

  const CAP_LEN_MM = 1e-4;
  const extraTips = s.tips;

  const hubTop: Vec3 = { x: s.pillarX, y: s.pillarY, z: z(s.pillarTopZ) };
  const hubBottom: Vec3 = { x: s.pillarX, y: s.pillarY, z: z(s.pillarBottomZ) };

  // A = the authored model contact, at the BOTTOM.
  const contactA = new THREE.Vector3(down.x, down.y, z(down.contactZ));
  // B = the shaft's top terminus (the fan hub). Not a model contact.
  const contactB = new THREE.Vector3(hubTop.x, hubTop.y, hubTop.z);

  // The record gives the downward cone's axis exactly: socket on the pillar
  // bottom, contact 26.8 degrees off vertical from there. Feed that as the
  // authored normal so only the short cone tilts and the body stays vertical.
  const downAxis = new THREE.Vector3(
    down.socketX - down.x,
    down.socketY - down.y,
    z(down.attachZ) - z(down.contactZ),
  ).normalize();

  const assemblyA = createContactAssembly(
    { ...synthSupportForTip(down, hubBottom), tipNormal: { x: downAxis.x, y: downAxis.y, z: downAxis.z } },
    contactA,
    { x: contactB.x, y: contactB.y, z: contactB.z },
    synthTipSettings(down, shaftDiameter), tipDefaults, mesh,
    true, true, downAxis, false,
  );

  // Cone B caps the top. Aimed DOWN the shaft (toward cone A) so its socket
  // lands on hubTop rather than beyond it, and given ~zero length so it has no
  // visible cone body -- there is no second model contact to draw.
  const capAxis = new THREE.Vector3(0, 0, -1);
  const assemblyB = createContactAssembly(
    { ...synthSupportForTip(s.tips[0], hubTop), tipNormal: { x: capAxis.x, y: capAxis.y, z: capAxis.z } },
    contactB,
    { x: contactA.x, y: contactA.y, z: contactA.z },
    { length: CAP_LEN_MM, diameter: shaftDiameter, pointDiameter: shaftDiameter },
    tipDefaults, mesh,
    true, true, capAxis, false,
  );

  const jointA: Joint = assemblyA.socketJoint;
  const jointB: Joint = assemblyB.socketJoint;

  // Pin the cap length: createContactAssembly re-solves lengthMm from the span
  // and would otherwise restore the default, reinstating the stray second cone.
  if (assemblyB.contactCone.profile) {
    assemblyB.contactCone.profile.lengthMm = CAP_LEN_MM;
  }

  const stick: Stick = {
    id: uuidv4(),
    modelId,
    segments: [
      {
        id: uuidv4(),
        type: 'straight',
        diameter: shaftDiameter,
        // A is the bottom cone, B the top, matching the host's stickBuilder.
        bottomJoint: jointA,
        topJoint: jointB,
      },
    ],
    contactConeA: assemblyA.contactCone,
    contactConeB: assemblyB.contactCone,
  };

  // ALL upward contacts become leaves on the hub knot (forceLeaf below), so the
  // branches array stays empty here for a stick -- it is kept only because
  // buildTipFromKnot's return type is shared with the trunk path.
  const knots: Knot[] = [];
  const branches: Branch[] = [];
  const leaves: Leaf[] = [];

  // One knot per leaf: a shared knot renders only one leaf attached. `t` is the
  // normalised position along the host segment, and is required -- the host
  // derives the knot's position from parentShaftId + t.
  const stickSegment = stick.segments[0];
  // Both joints are set when the stick is built above; fall back to the hub
  // endpoints so the type's optionality does not need an assertion.
  const segStart = stickSegment.bottomJoint?.pos ?? hubBottom;
  const segEnd = stickSegment.topJoint?.pos ?? hubTop;

  // Hub knot, matching the native sprout-leaf flow: pos and diameter come from
  // the JOINT itself, not re-derived, and no _importHint is stamped.
  const hubJoint = stickSegment.topJoint;
  const hubAttachT = 1.0;
  // COPY the joint's position, never alias it: the cluster transforms dedupe
  // joints by id but iterate knots unconditionally, so a shared Vec3 gets
  // shifted once per knot pointing at it.
  const hubAttachSrc: Vec3 = hubJoint?.pos ?? segEnd;
  const hubAttach: Vec3 = { x: hubAttachSrc.x, y: hubAttachSrc.y, z: hubAttachSrc.z };
  for (const tip of extraTips) {
    const attachT = hubAttachT;
    const leafKnot: Knot = {
      id: uuidv4(),
      parentShaftId: stickSegment.id,
      t: attachT,
      // Fresh Vec3 per knot: see hubAttach above.
      pos: { x: hubAttach.x, y: hubAttach.y, z: hubAttach.z },
      diameter: hubJoint?.diameter ?? getJointDiameter(shaftDiameter),
      // Stamp 'project' so normalization takes the import-hint fast path. The
      // heuristics below it key off isEndpointProjection, true for every hub
      // knot at t=1.0, and were written for trunk/branch knots.
      _importHint: 'project',
    };
    knots.push(leafKnot);

    // forceLeaf: a stick's hub fan is authored as leaves, however long. See
    // buildTipFromKnot's note -- the length test is for trunk tips, not fans.
    const { leaf, branch } = buildTipFromKnot(
      tip, leafKnot, hubAttach,
      new THREE.Vector3(tip.x, tip.y, z(tip.contactZ)),
      shaftDiameter, modelId, tipDefaults, mesh, true,
    );
    if (leaf) leaves.push(leaf);
    if (branch) branches.push(branch);
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
    // Fork junction: the base is mid-air at a brace convergence, so it must not
    // render a base cup. A zero-size root starts the shaft exactly there, with no
    // disk or cone geometry drawn.
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

  // Tips are pre-sorted tallest-first; primary = first. A support with no model
  // tips is a grounded pillar hosting only braces: emit it as a contactless
  // trunk so those braces have a shaft to attach to.
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
    return { root, trunk, knots: [], branches: [], leaves: [], fanLeafIds: [] };
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
  // root -> joint0 (knee) -> socket -> contact cone. Extra tips become Branches
  // off a knot on this shaft. The trunk is always cone-terminated so the engine
  // recognises it as a properly-formed support.
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
  // shaftLength = dist(knot -> contact) - tipLen. Too short for a shaft gives a
  // Leaf, otherwise a Branch. All extra tips share one knot, as Chitubox roots
  // them at the pillar top.
  const fanLeafIds = new Set<string>();
  if (extraTips.length > 0) {
    const topSegment = segments[segments.length - 1];
    // Use the authored knot height, not the primary cone's socket: it is where
    // the tips actually fan out, so they approach their contacts from below
    // rather than meeting the shaft side-on. Clamped to the top segment.
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

    // forceLeaf: these tips are an authored fan, rooted at one shared height and
    // drawn as single long cones. The length test would make each a Branch,
    // inventing shafts the file never authored.
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
        true,
      );
      if (leaf) { leaves.push(leaf); fanLeafIds.add(leaf.id); }
      if (branch) branches.push(branch);
    }
  }

  // Apply the trunk diameter profile to every trunk. Multi-tip splits the shaft
  // at branch knots and thickens bottom-up; single-tip still needs it to size
  // the top socket joint to the shaft rather than the narrower cone body.
  applyTrunkDiameterProfile(trunk, rootTopZ, knots, branches);

  return { root, trunk, knots, branches, leaves, fanLeafIds: [...fanLeafIds] };
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
   * import format.
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
    // Leaves built on an authored FAN hub -- a stick's top knot or a junction
    // knot. Both are authored at their final position, so the leaf sanity pass
    // below must not re-classify them as branches by knot-to-contact length.
    const stickHubLeafIds = new Set<string>();
    const braces: Brace[] = [];

    // raftZ = 0: supports stay in the same world frame as the geometry, and the
    // bridge shifts both by one offset so they stay locked. Normalising here
    // would desync them by the raft thickness.
    const raftZ = 0;

    // Track each pillar's segments with world endpoints so a brace attaches to
    // the closest segment in 3D, matching the host's findClosestSegment. An
    // endpoint high on a pillar belongs to the upper segment, not the lower.
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
    // Fork-junction trunks build as normal trunks but sit mid-air. Recorded here
    // and re-anchored to a convergence knot after braces create them: a root off
    // the plate makes the host re-route it down through the model.
    const forkJunctionTrunks: Array<{ trunk: Trunk; rootId: string; basePos: Vec3 }> = [];

    // Split tips into model contacts and cross-brace tips landing on a
    // neighbouring shaft. The latter are emitted as Braces once the shafts
    // exist; as model cones they would tunnel to empty space.
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
        // A downward contact means the support spans two parts of the model
        // rather than standing on the plate, which DragonFruit models as a
        // Stick. Remaining upward tips fan off the hub knot as leaves.
        if (s.downwardTip && s.tips.length > 0) {
          const stick = buildStick(s, placeholderModelId, raftZ, tipDefaults, mesh);
          if (stick) {
            sticks.push(stick.stick);
            knots.push(...stick.knots);
            branches.push(...stick.branches);
            leaves.push(...stick.leaves);
            for (const l of stick.leaves) stickHubLeafIds.add(l.id);
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
        for (const id of built.fanLeafIds) stickHubLeafIds.add(id);

        if (s.isForkJunction) {
          forkJunctionTrunks.push({
            trunk: built.trunk,
            rootId: built.root.id,
            basePos: { x: s.pillarX, y: s.pillarY, z: built.root.transform.pos.z },
          });
        }

        // Segment world endpoints, derived as the host's
        // getTrunkSegmentEndpoints does: start from bottomJoint, else the root
        // top or previous topJoint; end at topJoint, else the cone socket.
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
    /**
     * Resolve the pillar a brace endpoint attaches to.
     *
     * XY alone is not enough: on stacked tiers several pillars sit inside the
     * tolerance, and binding to the wrong one stretches the brace across the
     * model. Scoring in 3D against each candidate's segments picks the tier that
     * actually contains the endpoint.
     */
    const nearestShaft = (x: number, y: number, z?: number): ShaftRef | null => {
      let best: ShaftRef | null = null;
      let bestD = Infinity;
      for (const r of shaftRefs) {
        const dxy = (r.px - x) ** 2 + (r.py - y) ** 2;
        // Reject anything outside the XY tolerance first (unchanged behaviour).
        if (dxy > CBX_BRACE_ATTACH_TOL_MM * CBX_BRACE_ATTACH_TOL_MM) continue;
        // Within tolerance, rank by true 3D distance to the pillar's segments so
        // the correct TIER wins rather than whichever is marginally closer in XY.
        let d = dxy;
        if (z !== undefined) {
          d = Infinity;
          for (const seg of r.segments) {
            const ax = seg.start.x, ay = seg.start.y, az = seg.start.z;
            const bx = seg.end.x, by = seg.end.y, bz = seg.end.z;
            const abx = bx - ax, aby = by - ay, abz = bz - az;
            const abLenSq = abx * abx + aby * aby + abz * abz;
            let t = 0;
            if (abLenSq > 1e-8) {
              t = ((x - ax) * abx + (y - ay) * aby + (z - az) * abz) / abLenSq;
              t = t < 0 ? 0 : t > 1 ? 1 : t;
            }
            const cx = ax + abx * t, cy = ay + aby * t, cz = az + abz * t;
            const dd = (cx - x) ** 2 + (cy - y) ** 2 + (cz - z) ** 2;
            if (dd < d) d = dd;
          }
        }
        if (d < bestD) { bestD = d; best = r; }
      }
      return best;
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

    // A projection clamped to a segment end that still lands far from it means
    // the authored point lies beyond the shaft: the nearest-shaft guess was
    // wrong. Marking such knots 'project' draws them on the shaft their t
    // refers to, rather than at a point with no shaft under it.
    const BRACE_ENDPOINT_PRESERVE_TOL_MM = 0.5;
    const braceProjectionIsUnreliable = (
      authored: Vec3,
      proj: { t: number; pos: Vec3 },
    ): boolean => {
      const clampedToEnd = proj.t <= 1e-4 || proj.t >= 1 - 1e-4;
      if (!clampedToEnd) return false;
      const dx = proj.pos.x - authored.x;
      const dy = proj.pos.y - authored.y;
      const dz = proj.pos.z - authored.z;
      return Math.sqrt(dx * dx + dy * dy + dz * dz) > BRACE_ENDPOINT_PRESERVE_TOL_MM;
    };
    const braceKnotPos = (authored: Vec3, proj: { t: number; pos: Vec3 }): Vec3 => (
      braceProjectionIsUnreliable(authored, proj)
        ? { x: proj.pos.x, y: proj.pos.y, z: proj.pos.z }
        : authored
    );
    const braceKnotHint = (
      authored: Vec3,
      proj: { t: number; pos: Vec3 },
    ): Knot['_importHint'] => (
      braceProjectionIsUnreliable(authored, proj) ? 'project' : 'braceImported'
    );

    for (const b of modelBraces) {
      // Pass Z so a stacked tier cannot be mis-picked (see nearestShaft).
      const shaftA = nearestShaft(b.ax, b.ay, b.az - raftZ);
      const shaftB = nearestShaft(b.bx, b.by, b.bz - raftZ);
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
        pos: braceKnotPos(endpointA, projA),
        diameter: jointDiameter,
        _importHint: braceKnotHint(endpointA, projA),
      };
      const knotB: Knot = {
        id: uuidv4(),
        parentShaftId: projB.segmentId,
        t: projB.t,
        pos: braceKnotPos(endpointB, projB),
        diameter: jointDiameter,
        _importHint: braceKnotHint(endpointB, projB),
      };
      // A rebuilt brace must stay close to its authored span. Authored braces
      // are short 45deg struts, so a large overshoot means the endpoint bound to
      // the wrong pillar; drop it rather than draw a girder across the model.
      const authoredLen = Math.hypot(
        endpointB.x - endpointA.x, endpointB.y - endpointA.y, endpointB.z - endpointA.z,
      );
      const builtLen = Math.hypot(
        projB.pos.x - projA.pos.x, projB.pos.y - projA.pos.y, projB.pos.z - projA.pos.z,
      );
      if (builtLen > authoredLen * 2 + 2) {
        if (CBX_DEBUG) {
          cbxDebug(
            `BRACE-REJECT authored=${authoredLen.toFixed(2)}mm built=${builtLen.toFixed(2)}mm `
            + `A=(${endpointA.x.toFixed(2)},${endpointA.y.toFixed(2)},${endpointA.z.toFixed(2)}) `
            + `B=(${endpointB.x.toFixed(2)},${endpointB.y.toFixed(2)},${endpointB.z.toFixed(2)})`,
          );
        }
        bracesDropped++;
        continue;
      }

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
    // Project the contact onto the target pillar and a matching point onto the
    // source pillar, then link them with a Brace.
    let supportBracesEmitted = 0;
    for (const pb of pendingSupportBraces) {
      // The authored contact height is the attach Z for both ends of this strut,
      // so use it to disambiguate stacked tiers (see nearestShaft).
      const targetShaft = nearestShaft(pb.targetPillarX, pb.targetPillarY, pb.contact.z);
      const sourceShaft = nearestShaft(pb.sourcePillarX, pb.sourcePillarY, pb.contact.z);
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
    // Now the converging braces have dropped knots at the convergence, re-anchor
    // each fork trunk to the nearest one and drop its floating root, so the host
    // stops trying to ground it.
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
        // Anchor onto the nearest brace-convergence knot at the fork base. Keyed
        // on brace reference rather than shaft ownership: converging braces drop
        // their knots onto the fork's own base segment.
        let best: Knot | null = null;
        let bestD = Infinity;
        for (const k of knots) {
          if (!braceKnotIds.has(k.id)) continue;
          const d = Math.hypot(k.pos.x - fork.basePos.x, k.pos.y - fork.basePos.y, k.pos.z - fork.basePos.z);
          if (d < bestD) { bestD = d; best = k; }
        }
        // Only re-anchor if a convergence knot is genuinely at the base (within 2mm).
        if (!best || bestD > 2.0) continue;

        // The search above is keyed on brace reference, not host shaft, so it
        // usually finds the knot on the fork's OWN base segment -- making the
        // branch its own parent, a self-reference the trunk-resolution walk
        // cannot escape. Where the knot is self-hosted, re-host a new one at the
        // same position on the brace's other shaft.
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
        // Emit the fork as a Branch, not a trunk: the host grounds every trunk
        // to the plate, which is wrong for a junction held mid-air by braces.
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
    // A junction is a tip-bearing knot with no pillar of its own, reached by one
    // diagonal brace. Rebuilt as a Branch parented to the knot that brace comes
    // from, with its tips as contact cones.
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
      const parentRef = nearestShaft(parentPos.x, parentPos.y, parentPos.z);
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

      // A Branch runs from the parent knot up to a terminal joint at the
      // junction; one knot sits there and every junction tip is a Leaf off it.
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

      // Clone the position rather than sharing junctionPos: the cluster
      // transforms dedupe joints by id but iterate knots separately, so a shared
      // ref is shifted twice.
      const junctionKnot: Knot = {
        id: uuidv4(),
        parentShaftId: branchSeg.id,
        pos: { x: junctionPos.x, y: junctionPos.y, z: junctionPos.z },
        diameter: getJointDiameter(shaftDiameter),
        _importHint: 'preserve',
      };
      knots.push(junctionKnot);

      // Junction tips radiate from the junction knot as an authored FAN, same as
      // a multi-tip trunk's extra tips and a stick's hub -- forceLeaf, so the
      // knot-to-contact length test does not split them into separate shafts.
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
          true,
        );
        if (leaf) { leaves.push(leaf); stickHubLeafIds.add(leaf.id); }
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

    // --- Twigs (sub-12): short struts bridging two model contacts. ---
    // Built to match the host's buildTwig: disks oriented by real surface
    // normals from the mesh, joints standing off the surface along them.
    const modelTwigs = model.twigs ?? [];
    const twigs: Twig[] = [];

    // Surface normal at a contact, oriented out of the solid. Probes in many
    // directions and takes the nearest hit: a single ray along the strut skims
    // past the local face where the strut runs near-tangent to the surface.
    // Falls back to the strut axis with no mesh or no hit.
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
    // Returns the outward normal and the snapped mesh hit point. Authored twig
    // endpoints can sit a fraction off the surface, so snapping keeps the disk
    // flush rather than floating.
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

    // --- Leaf sanity pass ---
    // A Leaf is a shaft-less cone, valid only while its knot sits about one
    // tip-length from the contact; later relocation can stretch that into a leaf
    // that tunnels through the model. Stick-hub leaves are exempt, their knot
    // never moves.
    {
      const knotById = new Map(knots.map((k) => [k.id, k]));
      const tipLen = CBX_TIP_DEFAULTS.lengthMm;
      const keptLeaves: Leaf[] = [];
      let converted = 0;
      for (const leaf of leaves) {
        const knot = leaf.parentKnotId ? knotById.get(leaf.parentKnotId) : undefined;
        const cc = leaf.contactCone;
        if (!knot || !cc) { keptLeaves.push(leaf); continue; }
        if (stickHubLeafIds.has(leaf.id)) { keptLeaves.push(leaf); continue; }
        const knotToContact = Math.hypot(cc.pos.x - knot.pos.x, cc.pos.y - knot.pos.y, cc.pos.z - knot.pos.z);
        if (knotToContact <= tipLen + LEAF_MAX_SHAFT_MM) { keptLeaves.push(leaf); continue; }

        // Over-long: rebuild as a Branch. Re-solve a short native cone + socket from
        // the knot toward the contact, so the cone is a short tip and the shaft
        // carries the rest.
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

    // --- Knot-centering / merge sanity pass ---
    // Merge clusters of near-coincident brace knots on one shaft into a single
    // attachment. Contact knots anchor but are never moved.
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

    // --- Degenerate-joint collapse pass ---
    // Remove near-zero-length stubs whose end joints render as overlapping
    // spheres. The cone's socket joint is preserved; riding knots are
    // re-pointed onto the merged segment.
    {
      const collapsed = collapseDegenerateJoints({ trunks, branches, knots });
      if (CBX_DEBUG && collapsed > 0) {
        cbxDebug(`joint-collapse pass: removed ${collapsed} degenerate shaft stub(s)`);
      }
    }

    // --- Coincident-joint dedup ---
    // Two distinct joint objects at one point render as one sphere but drag
    // apart. Reference-shared joints are left alone.
    {
      const deduped = dedupeCoincidentJoints({
        supports: [...trunks, ...branches, ...twigs, ...sticks],
        knots,
      });
      if (CBX_DEBUG && deduped > 0) {
        cbxDebug(`joint-dedup pass: merged ${deduped} coincident joint(s)`);
      }
    }

    const result: DragonfruitImportFormat = {
      version: 1,
      meta: {
        source: model.filename ? `chitubox:${model.filename}` : 'chitubox_conversion',
        // The host expects {0,0,0}; the model mesh carries its own position.
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
   * file-type bridge after conversion.
   *
   * Every emitted type must be covered: one left on convert()'s placeholder id
   * belongs to no displayed model, so it renders but cannot be selected or
   * dragged.
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
   * Shift every support entity in Z by `deltaZ`. The host centers the model's
   * bbox at the origin and does not move supports with it, so the bridge shifts
   * them by the same amount to keep the two locked. Joints shared across
   * segments are shifted once.
   */
  // These delegate to converter/clusterTransform, preserving the public API.
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
