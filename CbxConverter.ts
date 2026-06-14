import * as THREE from 'three';
import {
  DragonfruitImportFormat,
  Roots,
  Trunk,
  Branch,
  Brace,
  Knot,
  Joint,
  Segment,
  Vec3,
} from '@/supports/types';
import { SupportSettings } from '@/supports/Settings';
import { getJointDiameter } from '@/supports/constants';
import { createContactAssembly } from './converter/contactAssembly';
import { generateUuid } from '@/utils/uuid';

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

const LOG_PREFIX = '[CbxConverter]';

/**
 * Fallback support-tip defaults handed to createContactAssembly when a value
 * isn't authored in the Cbx record. Field set matches what the assembly
 * helper reads (lengthMm, bodyDiameterMm, contactDiameterMm, diskThicknessMm,
 * maxStandoffMm, standoffAngleThreshold, penetrationMm). Values mirror
 * DEFAULT_TIP_PROFILE so cone proportions stay consistent with native authoring.
 *
 * If the host's live `settings.tip` is passed into convert(), those values are
 * used instead (see resolveTipDefaults).
 */
const CBX_TIP_DEFAULTS = {
  lengthMm: 3.0,
  bodyDiameterMm: 1.2,
  contactDiameterMm: 0.4,
  diskThicknessMm: 0.1,
  maxStandoffMm: 0.25,
  standoffAngleThreshold: Math.PI / 4,
  penetrationMm: 0.05,
};

/**
 * Fallback root/shaft defaults. Root pad diameter and disk/cone heights follow
 * convertLysData, which sources them from settings.roots rather than from the
 * source file. Cbx's skate radius is intentionally NOT used as the pad
 * diameter, matching LYS behaviour (the plate footprint is a DragonFruit
 * setting, not authored geometry).
 */
const CBX_ROOT_DEFAULTS = {
  diameterMm: 3.0,
  diskHeightMm: 0.5,
  coneHeightMm: 1.0,
};

const CBX_SHAFT_DEFAULTS = {
  diameterMm: 0.7,
};

// Max XY distance (mm) from a brace endpoint to a pillar shaft for attachment.
// Brace endpoints sit on pillar centres (verified within ~0.5mm); 1.0mm gives a
// small safety margin without risking a wrong-shaft match in dense layouts.
const CBX_BRACE_ATTACH_TOL_MM = 1.0;

/**
 * A single contact branch (tip) of a support. A support may have several
 * (branched supports share one pillar/knot but reach multiple contact points).
 */
export interface CbxTip {
  /** Contact point on the model surface (world space). */
  x: number;
  y: number;
  contactZ: number;
  /** Z where the tip meets the knot (bottom of the cone). */
  attachZ: number;
  /** Authored cone length, mm (= contactZ − attachZ). */
  length: number;
  /** Small contact end (touches model) and larger body/socket end, mm. */
  contactDiameter: number;
  bodyDiameter: number;
  /** Penetration depth into the model, mm. */
  contactDepth: number;
}

/**
 * Optional wide base pad (only present on larger supports). Authored as a
 * truncated cone: top/bottom radii and the Z span it occupies (world space).
 */
export interface CbxBasePad {
  topRadius: number;
  bottomRadius: number;
  topZ: number;
  bottomZ: number;
}

/**
 * Parsed support in the CORRECTED chain model (see CbxParser). One support
 * is a vertical chain: [base pad] → pillar → knot → one-or-more tips. All Z
 * values are world frame; diameters are already radius×2.
 */
export interface CbxSupport {
  /** Authored pillar (shaft) diameter, mm. */
  pillarDiameter: number;
  /** Pillar top/bottom Z (world space). Top meets the knot; bottom the raft. */
  pillarTopZ: number;
  pillarBottomZ: number;
  /** Pillar XY (shared by base + knot). */
  pillarX: number;
  pillarY: number;
  /** Knot (spherical joint) center Z and authored sphere diameter. */
  knotCenterZ: number;
  knotDiameter: number;
  /** Optional wide base pad. */
  base: CbxBasePad | null;
  /** One or more contact branches. */
  tips: CbxTip[];
}

/**
 * Authored per-instance plate transform, read directly from the `.chitubox`
 * per-instance header table (parser open-coded the sub-offsets):
 *   plateX ← header +660, plateY ← header +664, liftZ ← header +668.
 *
 * This is the data the format report previously called "undecoded": it is now
 * decoded, so multi-model imports can place each model at its authored plate
 * position instead of stacking everything at the origin. The last (anomalous)
 * header entry has no authored transform; the parser fills it with zeros, which
 * the bridge treats as "centre on the plate".
 */
export interface CbxTransform {
  /** Plate X translation, mm (header +660). */
  plateX: number;
  /** Plate Y translation, mm (header +664). */
  plateY: number;
  /** Authored Z-lift, mm (header +668). 0 = flat on plate. */
  liftZ: number;
}

/**
 * A brace: a diagonal strut connecting two vertical support shafts (pillars).
 * In the `.chitubox` block it is a sub-3 record whose two endpoints differ in
 * XY (a normal vertical pillar has identical endpoints). Both endpoints land on
 * existing pillar shafts; the converter drops a Knot on each and links them with
 * a DragonFruit Brace. All Z values are world frame; diameter is radius×2.
 */
export interface CbxBrace {
  /** Endpoint A (world space). */
  ax: number;
  ay: number;
  az: number;
  /** Endpoint B (world space). */
  bx: number;
  by: number;
  bz: number;
  /** Strut diameter, mm. */
  diameter: number;
}

/** Per-model bundle handed to the converter (one entry per distinct model). */
export interface CbxModelInput {
  index: number;
  filename: string | null;
  /** Model mesh, used only for the import meta objectCenter. */
  geometry?: THREE.BufferGeometry | null;
  supports: CbxSupport[];
  /**
   * Diagonal braces between support shafts. Optional so older callers / fixtures
   * without braces still type-check; absent means no braces for this model.
   */
  braces?: CbxBrace[];
  /**
   * Authored per-instance plate transform (plate XY + Z-lift). Optional so older
   * callers / synthetic fixtures that don't set it still type-check; the bridge
   * defaults a missing transform to the origin.
   */
  transform?: CbxTransform;
}

/**
 * The raft-top height (world frame) for a set of supports: the minimum base/
 * pillar bottom Z. Subtracting it raft-normalizes the scene so support bases
 * land on DragonFruit's plate at z = 0.
 *
 * Exported so the file-type bridge can apply the SAME offset to the model mesh's
 * transform — keeping geometry and supports in the same frame. Returns 0 when
 * there are no supports (nothing to anchor against).
 */
export function computeRaftZ(supports: CbxSupport[]): number {
  if (!supports || supports.length === 0) return 0;
  return Math.min(...supports.map((s) => (s.base ? s.base.bottomZ : s.pillarBottomZ)));
}

/**
 * The model's authored lift above the plate (world frame), recovered from the
 * supports rather than the geometry: each tip's contact point minus its
 * penetration depth is a point on the model's lower surface, so the minimum of
 * those is the model's lowest supported surface ≈ the model's true bottom.
 *
 * This is contamination-immune (it never touches the mesh) and is what the
 * file-type bridge uses as transform.position.z so the normalized geometry is
 * lifted back to the height its supports expect. Returns 0 if there are no tips.
 */
export function computeModelLift(model: CbxModelInput): number {
  const tips = (model.supports ?? []).flatMap((s) => s.tips);
  if (tips.length === 0) return 0;
  return Math.min(...tips.map((t) => t.contactZ - t.contactDepth));
}

/**
 * Build a synthetic LysSupport-shaped object for createContactAssembly.
 * Cbx has no tip normal, so tipNormal is omitted; the helper then takes its
 * geometric socket-solve path (preferLysTipNormal=false).
 */
function synthSupportForTip(tip: CbxTip, attachPos: Vec3): any {
  return {
    id: 'chitubox-synth',
    base: { x: attachPos.x, y: attachPos.y, z: attachPos.z },
    tip: { x: tip.x, y: tip.y, z: tip.contactZ },
    settings: undefined,
  };
}

/**
 * tipSettings for createContactAssembly, from AUTHORED tip values.
 *   length        ← authored cone length (contactZ − attachZ). Critical: passing
 *                   the real length prevents the helper's default-3mm fallback
 *                   from placing the socket below the plate on short supports.
 *   pointDiameter ← contactDiameter (small end on the model)
 *   diameter      ← bodyDiameter    (larger socket end)
 */
function synthTipSettings(tip: CbxTip): any {
  return {
    length: Number.isFinite(tip.length) && tip.length > 0 ? tip.length : undefined,
    diameter: Number.isFinite(tip.bodyDiameter) ? tip.bodyDiameter : undefined,
    pointDiameter: Number.isFinite(tip.contactDiameter) ? tip.contactDiameter : undefined,
  };
}

/** Output of converting one support: the entities it contributes. */
interface BuiltSupport {
  root: Roots;
  trunk: Trunk;
  knots: Knot[];
  branches: Branch[];
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
  const rootId = generateUuid();
  let root: Roots;
  if (s.base) {
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
    id: generateUuid(),
    pos: { x: px, y: py, z: knotCenter },
    diameter: Number.isFinite(s.knotDiameter) && s.knotDiameter > 0
      ? s.knotDiameter
      : getJointDiameter(shaftDiameter),
  };

  // Tips are pre-sorted tallest-first by the parser; primary = first.
  const [primaryTip, ...extraTips] = s.tips;
  const attachPos: Vec3 = { x: px, y: py, z: knotCenter };

  // --- Primary tip → trunk terminal cone. ---
  const primary = createContactAssembly(
    synthSupportForTip(primaryTip, attachPos),
    new THREE.Vector3(primaryTip.x, primaryTip.y, z(primaryTip.contactZ)),
    attachPos,
    synthTipSettings(primaryTip),
    tipDefaults,
    mesh,
    false, false, null, true,
  );

  // Shaft: root → knot joint (bottomJoint undefined = "on Root"), then knot →
  // primary socket. Authored diameter throughout.
  const segments: Segment[] = [
    {
      id: generateUuid(),
      type: 'straight',
      diameter: shaftDiameter,
      bottomJoint: undefined,
      topJoint: knotJoint,
    },
    {
      id: generateUuid(),
      type: 'straight',
      diameter: shaftDiameter,
      bottomJoint: knotJoint,
      topJoint: primary.socketJoint,
    },
  ];

  const trunk: Trunk = {
    id: generateUuid(),
    modelId,
    rootId,
    baseDiameterMm: shaftDiameter,
    segments,
    contactCone: primary.contactCone,
  };

  // --- Extra tips → Knot on the shaft + Branch with its own cone. ---
  const knots: Knot[] = [];
  const branches: Branch[] = [];
  for (const tip of extraTips) {
    // The branch attaches at the knot joint (top of the pillar), where Cbx
    // roots all of a support's tips.
    const knot: Knot = {
      id: generateUuid(),
      parentShaftId: segments[1].id, // the knot→primary shaft segment
      pos: { x: px, y: py, z: knotCenter },
      diameter: knotJoint.diameter,
      _importHint: 'preserve',
    };
    knots.push(knot);

    const branchAssembly = createContactAssembly(
      synthSupportForTip(tip, attachPos),
      new THREE.Vector3(tip.x, tip.y, z(tip.contactZ)),
      attachPos,
      synthTipSettings(tip),
      tipDefaults,
      mesh,
      false, false, null, true,
    );

    branches.push({
      id: generateUuid(),
      modelId,
      parentKnotId: knot.id,
      segments: [
        {
          id: generateUuid(),
          type: 'straight',
          diameter: shaftDiameter,
          bottomJoint: undefined, // connects to the parent knot
          topJoint: branchAssembly.socketJoint,
        },
      ],
      contactCone: branchAssembly.contactCone,
    });
  }

  return { root, trunk, knots, branches };
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
    const placeholderModelId = generateUuid();
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

    for (const s of supports) {
      try {
        const built = buildSupport(
          s, placeholderModelId, raftZ, tipDefaults, rootDefaults, shaftDefaults, mesh,
        );
        roots.push(built.root);
        trunks.push(built.trunk);
        knots.push(...built.knots);
        branches.push(...built.branches);

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
          const end: Vec3 = seg.topJoint?.pos
            ?? coneSocket
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
        id: generateUuid(),
        parentShaftId: projA.segmentId,
        t: projA.t,
        pos: endpointA,
        diameter: jointDiameter,
        _importHint: 'braceImported',
      };
      const knotB: Knot = {
        id: generateUuid(),
        parentShaftId: projB.segmentId,
        t: projB.t,
        pos: endpointB,
        diameter: jointDiameter,
        _importHint: 'braceImported',
      };
      knots.push(knotA, knotB);

      braces.push({
        id: generateUuid(),
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
      leaves: [],
      twigs: [],
      sticks: [],
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
      raftZ,
    });

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
  static applyZShift(data: DragonfruitImportFormat, deltaZ: number): void {
    if (!Number.isFinite(deltaZ) || Math.abs(deltaZ) < 1e-6) return;

    const shiftedJointIds = new Set<string>();
    const shiftJoint = (joint?: Joint) => {
      if (!joint?.pos) return;
      if (joint.id && shiftedJointIds.has(joint.id)) return;
      joint.pos.z += deltaZ;
      if (joint.id) shiftedJointIds.add(joint.id);
    };
    const shiftCone = (cone?: { pos: Vec3 }) => {
      if (cone?.pos) cone.pos.z += deltaZ;
    };
    const shiftSegments = (segments: Segment[]) => {
      for (const seg of segments) {
        shiftJoint(seg.bottomJoint);
        shiftJoint(seg.topJoint);
      }
    };

    for (const root of data.roots) {
      if (root.transform?.pos) root.transform.pos.z += deltaZ;
    }
    for (const trunk of data.trunks) {
      shiftSegments(trunk.segments);
      shiftCone(trunk.contactCone);
    }
    for (const branch of data.branches) {
      shiftSegments(branch.segments);
      shiftCone(branch.contactCone);
    }
    for (const knot of data.knots) {
      if (knot.pos) knot.pos.z += deltaZ;
    }
  }

  /**
   * Shift every support entity in XY by (`deltaX`, `deltaY`). The XY analogue of
   * applyZShift: used to move a converted support cluster from its authored
   * model-local frame to the model's plate position (header +660/+664).
   *
   * Chitubox authors each model's geometry AND its supports in the same
   * model-local frame (both centred near the local origin); the per-instance
   * plate XY is the translation onto the build plate. Applying the same XY delta
   * to the supports here and to the model's transform.position in the bridge
   * keeps the two locked together while spreading models across the plate.
   *
   * Walks the same Z-bearing fields applyZShift does (roots, segment joints,
   * contact cones, knots), shifting their X/Y. Shared joints are shifted once.
   */
  static applyXYShift(data: DragonfruitImportFormat, deltaX: number, deltaY: number): void {
    if (
      (!Number.isFinite(deltaX) || Math.abs(deltaX) < 1e-6) &&
      (!Number.isFinite(deltaY) || Math.abs(deltaY) < 1e-6)
    ) {
      return;
    }
    const dx = Number.isFinite(deltaX) ? deltaX : 0;
    const dy = Number.isFinite(deltaY) ? deltaY : 0;

    const shiftedJointIds = new Set<string>();
    const shiftJoint = (joint?: Joint) => {
      if (!joint?.pos) return;
      if (joint.id && shiftedJointIds.has(joint.id)) return;
      joint.pos.x += dx;
      joint.pos.y += dy;
      if (joint.id) shiftedJointIds.add(joint.id);
    };
    const shiftCone = (cone?: { pos: Vec3 }) => {
      if (cone?.pos) {
        cone.pos.x += dx;
        cone.pos.y += dy;
      }
    };
    const shiftSegments = (segments: Segment[]) => {
      for (const seg of segments) {
        shiftJoint(seg.bottomJoint);
        shiftJoint(seg.topJoint);
      }
    };

    for (const root of data.roots) {
      if (root.transform?.pos) {
        root.transform.pos.x += dx;
        root.transform.pos.y += dy;
      }
    }
    for (const trunk of data.trunks) {
      shiftSegments(trunk.segments);
      shiftCone(trunk.contactCone);
    }
    for (const branch of data.branches) {
      shiftSegments(branch.segments);
      shiftCone(branch.contactCone);
    }
    for (const knot of data.knots) {
      if (knot.pos) {
        knot.pos.x += dx;
        knot.pos.y += dy;
      }
    }
  }

  /**
   * Pin every Roots base to the build plate (z = `plateZ`, default 0), leaving
   * the rest of each support (shaft joints, knots, contact cones) untouched.
   *
   * Why: DragonFruit treats a support's ROOT as anchored in plate space and its
   * contact cone as anchored to the model surface — the shaft between them is
   * solved/stretched by the host. After applyZShift puts the whole support in
   * the host's centered-model frame (so cones meet the model), the roots end up
   * below the plate. This re-seats just the roots on the plate; the first shaft
   * segment has `bottomJoint: undefined` (= "connects to Root"), so the host
   * re-solves the shaft from the plate up to the first joint automatically — the
   * visual result is a support standing on the plate and reaching up to the model.
   */
  static seatRootsOnPlate(data: DragonfruitImportFormat, plateZ = 0): void {
    for (const root of data.roots) {
      if (root.transform?.pos) root.transform.pos.z = plateZ;
    }
  }
}
