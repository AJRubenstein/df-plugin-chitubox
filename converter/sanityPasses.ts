/**
 * Converter sanity passes — post/pre-processing validation that catches emergent
 * problems a single local decision can't. Kept separate from the build helpers so
 * the "is this geometry actually valid against the model + other supports" checks
 * live in one place and can grow independently.
 */
import * as THREE from 'three';
import { CbxSupport, CbxTip } from './types';

/** Result of classifying one support's tips against the model and its neighbours. */
export interface TipClassification {
  /** Tips whose contact lands on the MODEL surface — build normally. */
  modelTips: CbxTip[];
  /**
   * Tips whose contact lands on ANOTHER support (a support-to-support brace, as
   * authored in Chitubox by dropping a tip onto a neighbouring shaft). Each carries
   * the world point and the pillar (XY) it braces onto, so the converter can emit a
   * DragonFruit Brace instead of a model-contact cone that would tunnel to empty
   * space.
   */
  braceTips: Array<{ tip: CbxTip; targetPillarX: number; targetPillarY: number }>;
}

const SURFACE_NEAR_MM = 2.0;   // contact within this of the model = a model tip
const PILLAR_NEAR_MM = 2.0;    // contact within this of another pillar = a brace tip
// When a tip is near BOTH the model and a neighbouring pillar (a cross-brace landing
// in the tight gap between a shaft and the model surface), the pillar must be at least
// this much closer than the model surface for the tip to be treated as a support-to-
// support brace rather than a model contact. This resolves the ambiguity in Chitubox's
// favour (it authored the tip onto the shaft) without flipping genuine model tips,
// which sit ON the surface (dSurface ≈ 0) and so can never clear this margin. Measured
// gap on the halfling cross-braces is ~0.6–0.7 mm; 0.5 keeps a safety buffer.
const BRACE_PRIORITY_MARGIN_MM = 0.5;

// Cast in many directions so steeply-angled model faces are still detected; the
// nearest hit distance is the contact's distance to the model surface.
const PROBE_DIRS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0],
  [1, 1, 0], [-1, -1, 0], [1, -1, 0], [-1, 1, 0],
];

function distanceToModelSurface(mesh: THREE.Mesh, x: number, y: number, z: number): number {
  let best = Infinity;
  const origin = new THREE.Vector3(x, y, z);
  const rc = new THREE.Raycaster();
  for (const d of PROBE_DIRS) {
    const dir = new THREE.Vector3(d[0], d[1], d[2]).normalize();
    rc.set(origin, dir);
    const hits = rc.intersectObject(mesh, false);
    if (hits.length) best = Math.min(best, hits[0].distance);
  }
  return best;
}

/** Nearest OTHER support pillar (treated as a vertical segment) to a world point. */
function distanceToNearestOtherPillar(
  supports: CbxSupport[],
  self: CbxSupport,
  x: number,
  y: number,
  z: number,
): { dist: number; pillarX: number; pillarY: number } | null {
  let best: { dist: number; pillarX: number; pillarY: number } | null = null;
  for (const s of supports) {
    if (s === self) continue;
    const dxy = Math.hypot(s.pillarX - x, s.pillarY - y);
    const zMin = Math.min(s.pillarBottomZ, s.pillarTopZ) - 2;
    const zMax = Math.max(s.pillarBottomZ, s.pillarTopZ) + 2;
    const within = z >= zMin && z <= zMax;
    const dist = within
      ? dxy
      : Math.hypot(dxy, Math.min(Math.abs(z - s.pillarTopZ), Math.abs(z - s.pillarBottomZ)));
    if (!best || dist < best.dist) best = { dist, pillarX: s.pillarX, pillarY: s.pillarY };
  }
  return best;
}

/**
 * Classify a support's tips into model-contact tips and support-to-support brace
 * tips. A tip whose contact is far from the model but close to a neighbouring
 * pillar is a brace (Chitubox lets you land a tip on another support to cross-brace
 * the cluster); importing it as a model cone makes it tunnel through everything to
 * reach empty space (the "arch through the foot" artefact). Returning it as a brace
 * tip lets the converter wire a DragonFruit Brace between the two supports instead.
 *
 * When no mesh is available, every tip is treated as a model tip (no reclassification).
 */
export function classifySupportTips(
  support: CbxSupport,
  allSupports: CbxSupport[],
  mesh?: THREE.Mesh,
): TipClassification {
  if (!mesh) {
    return { modelTips: [...support.tips], braceTips: [] };
  }
  const modelTips: CbxTip[] = [];
  const braceTips: TipClassification['braceTips'] = [];

  for (const tip of support.tips) {
    const dSurface = distanceToModelSurface(mesh, tip.x, tip.y, tip.contactZ);
    const pillar = distanceToNearestOtherPillar(allSupports, support, tip.x, tip.y, tip.contactZ);
    const pillarNear = pillar !== null && pillar.dist <= PILLAR_NEAR_MM;

    // A tip can be near BOTH the model and a neighbouring shaft. Chitubox authors
    // makeshift cross-braces by landing a tip on another support's shaft, and those
    // landing points often sit only ~1 mm from the model too. The old order ("model
    // wins if dSurface ≤ 2") then built such a brace as a full model support that
    // overshoots its true (shaft) contact and runs on to a model-touching tip — the
    // support comes out too long. So when the pillar is the meaningfully closer
    // attachment, classify the tip as a brace even if it is also within the surface
    // band. Genuine model tips sit on the surface (dSurface ≈ 0) and never clear the
    // margin, so they are unaffected.
    if (pillarNear && pillar.dist < dSurface - BRACE_PRIORITY_MARGIN_MM) {
      braceTips.push({ tip, targetPillarX: pillar.pillarX, targetPillarY: pillar.pillarY });
      continue;
    }
    if (dSurface <= SURFACE_NEAR_MM) {
      modelTips.push(tip);
      continue;
    }
    if (pillarNear) {
      braceTips.push({ tip, targetPillarX: pillar.pillarX, targetPillarY: pillar.pillarY });
      continue;
    }
    // Neither on the model nor on a pillar — keep as a model tip (best effort); the
    // downstream penetration self-check will surface it if it's genuinely stray.
    modelTips.push(tip);
  }

  return { modelTips, braceTips };
}

/** Minimal knot shape this pass needs (a subset of the import-format Knot). */
interface CenterableKnot {
  id: string;
  parentShaftId?: string;
  t?: number;
  pos: { x: number; y: number; z: number };
}

export interface KnotCenteringInput {
  /** All knots in the converted payload (mutated in place). */
  knots: CenterableKnot[];
  /** Ids of knots referenced as a brace endpoint (start/end). */
  braceKnotIds: ReadonlySet<string>;
  /** Ids of knots that anchor a model-contact structure (leaf/branch parent). */
  contactKnotIds: ReadonlySet<string>;
}

/** How close in parametric t (fraction of a shaft segment) two knots must be to be
 *  treated as "congregating in the same spot". ~8% of a segment — tight enough that
 *  only genuinely-clustered knots merge, loose enough to catch authored scatter. */
const KNOT_CLUSTER_T_TOL = 0.08;

/** Result of {@link centerCoincidentKnots}. */
export interface KnotCenteringResult {
  /** Number of surviving knots whose position/t was snapped onto the cluster anchor. */
  moved: number;
  /** Number of duplicate brace-only knots removed (merged into a cluster survivor). */
  merged: number;
  /**
   * Old knot id -> surviving knot id, for every knot removed by the merge. The
   * caller must rewrite any Brace.startKnotId/endKnotId that names a key here to
   * the mapped value (braceKnotIds is exactly that reference set).
   */
  idRemap: Map<string, string>;
}

/**
 * Resolve clusters of near-coincident knots on the same shaft down to a single
 * shared knot. Chitubox frequently lands several braces at almost the same height
 * on one shaft, each authoring its own knot a fraction of a millimetre apart; left
 * as separate knots, the host renders a little fan of overlapping attach points
 * (each with its own independently-tracked diameter, so they can drift out of sync
 * on a later diameter edit) instead of the single clean attachment Chitubox shows.
 *
 * The host's data model already supports many entities (braces, branches, leaves)
 * referencing one shared Knot.id, so the fix is a real merge: every brace-only
 * knot in a cluster collapses onto one survivor, which the caller re-points all
 * matching Brace.startKnotId/endKnotId references onto.
 *
 * Rules, deliberately conservative:
 *  - Only BRACE-only knots are merged. A knot that anchors a leaf or branch (a real
 *    model contact) is never moved or merged away — moving it could drag a tip off
 *    the model — but it MAY serve as the anchor the brace-only knots snap onto.
 *  - Clustering is by parentShaftId + parametric t (matching the host's own
 *    coincidence test), not 3D distance, so knots on a short/near-horizontal shaft
 *    that are far apart along it are not wrongly merged.
 *  - The shared spot is the contact knot's position if the cluster has one, else
 *    the mean of the brace members — so braces gather onto the real support where
 *    one exists.
 *  - The survivor is the lowest-t brace-only member of the cluster (deterministic);
 *    the rest are removed from `knots` and mapped onto it in `idRemap`.
 */
export function centerCoincidentKnots(input: KnotCenteringInput): KnotCenteringResult {
  const { knots, braceKnotIds, contactKnotIds } = input;

  // Group knots that have a shaft + a defined t by their shaft.
  const byShaft = new Map<string, CenterableKnot[]>();
  for (const k of knots) {
    if (!k.parentShaftId || typeof k.t !== 'number') continue;
    const list = byShaft.get(k.parentShaftId);
    if (list) list.push(k);
    else byShaft.set(k.parentShaftId, [k]);
  }

  let moved = 0;
  let merged = 0;
  const idRemap = new Map<string, string>();
  const removeIds = new Set<string>();
  for (const list of byShaft.values()) {
    list.sort((a, b) => (a.t as number) - (b.t as number));
    const used = new Set<number>();
    for (let i = 0; i < list.length; i++) {
      if (used.has(i)) continue;
      const group = [list[i]];
      used.add(i);
      for (let j = i + 1; j < list.length; j++) {
        if (used.has(j)) continue;
        if (Math.abs((list[j].t as number) - (list[i].t as number)) <= KNOT_CLUSTER_T_TOL) {
          group.push(list[j]);
          used.add(j);
        }
      }
      // Brace-only members are the ones we may move.
      const braceMembers = group.filter(
        (k) => braceKnotIds.has(k.id) && !contactKnotIds.has(k.id),
      );
      if (braceMembers.length < 2) continue;

      // Anchor: a contact knot in the group if present (braces gather onto the real
      // support), else the mean position/t of the brace members.
      const contact = group.find((k) => contactKnotIds.has(k.id));
      let anchorPos: { x: number; y: number; z: number };
      let anchorT: number;
      if (contact) {
        anchorPos = { x: contact.pos.x, y: contact.pos.y, z: contact.pos.z };
        anchorT = contact.t as number;
      } else {
        anchorPos = { x: 0, y: 0, z: 0 };
        anchorT = 0;
        for (const k of braceMembers) {
          anchorPos.x += k.pos.x;
          anchorPos.y += k.pos.y;
          anchorPos.z += k.pos.z;
          anchorT += k.t as number;
        }
        anchorPos.x /= braceMembers.length;
        anchorPos.y /= braceMembers.length;
        anchorPos.z /= braceMembers.length;
        anchorT /= braceMembers.length;
      }

      for (const k of braceMembers) {
        if (
          k.pos.x !== anchorPos.x ||
          k.pos.y !== anchorPos.y ||
          k.pos.z !== anchorPos.z ||
          k.t !== anchorT
        ) {
          k.pos.x = anchorPos.x;
          k.pos.y = anchorPos.y;
          k.pos.z = anchorPos.z;
          k.t = anchorT;
          moved++;
        }
      }

      // Collapse the brace-only members onto one survivor (lowest t, i.e. the
      // first of the group — deterministic). The rest are dropped from `knots`
      // and mapped so the caller can re-point their brace references onto it.
      const [survivor, ...duplicates] = braceMembers;
      for (const dup of duplicates) {
        idRemap.set(dup.id, survivor.id);
        removeIds.add(dup.id);
        merged++;
      }
    }
  }

  if (removeIds.size > 0) {
    let w = 0;
    for (let r = 0; r < knots.length; r++) {
      if (!removeIds.has(knots[r].id)) knots[w++] = knots[r];
    }
    knots.length = w;
  }

  return { moved, merged, idRemap };
}

/** Minimal joint shape for the collapse pass. */
interface CollapsibleJoint {
  id: string;
  pos: { x: number; y: number; z: number };
  diameter: number;
}
/** Minimal segment shape for the collapse pass. */
interface CollapsibleSegment {
  id: string;
  bottomJoint?: CollapsibleJoint;
  topJoint?: CollapsibleJoint;
}
/** A support (trunk or branch) whose chain we may collapse. */
interface CollapsibleSupport {
  segments: CollapsibleSegment[];
  contactCone?: { socketJointId?: string };
}

export interface JointCollapseInput {
  /** Trunks (mutated in place). */
  trunks: CollapsibleSupport[];
  /** Branches (mutated in place). */
  branches: CollapsibleSupport[];
  /** All knots — their parentShaftId/t are re-pointed when a segment is removed. */
  knots: CenterableKnot[];
}

/** A shaft segment shorter than this (mm) is a degenerate stub: its two end joints
 *  render as overlapping spheres a fraction of a millimetre apart. Below this we
 *  collapse the two joints into one and drop the stub. Chosen to catch the authored
 *  ~0.05–0.45 mm stubs at trunk tops / branch attach points without touching real
 *  short transition segments (which are >= MIN_TRANSITION_SEG_MM = 0.5 by build). */
const DEGENERATE_SEGMENT_MM = 0.45;

function jointDist(a: CollapsibleJoint, b: CollapsibleJoint): number {
  return Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z);
}

/**
 * Collapse degenerate (near-zero-length) shaft segments so a trunk/branch top
 * doesn't render a lump of overlapping joint spheres. Chitubox imports frequently
 * leave a knee joint, a diameter-profile split joint, and the socket joint crammed
 * into a sub-millimetre span at the trunk top (where a branch knot sits right below
 * the cone). Each is a separate sphere, so the user sees several joints piled in one
 * place — the "joint right next to the existing one" artefact.
 *
 * The collapse is purely structural and NEVER moves anything that holds the model:
 *  - The joint referenced by the contact cone (socketJointId) is the keeper — its
 *    position and id are preserved, so the cone/tip stay exactly where they were.
 *  - Otherwise the UPPER joint (toward the cone) is kept, so we only ever drop the
 *    lower, redundant joint and shorten the routing below it. Tip contacts, which
 *    live on the cone above the socket, are untouched.
 *  - Knots whose parentShaftId is a removed segment are re-pointed to the surviving
 *    segment with t clamped to the merge point, so brace/branch/leaf linkage holds.
 *
 * Returns the number of stub segments removed (for debug logging).
 */
export function collapseDegenerateJoints(input: JointCollapseInput): number {
  const { trunks, branches, knots } = input;

  // Index knots by the segment they ride, so we can re-point them on removal.
  const knotsBySegment = new Map<string, CenterableKnot[]>();
  for (const k of knots) {
    if (!k.parentShaftId) continue;
    const list = knotsBySegment.get(k.parentShaftId);
    if (list) list.push(k);
    else knotsBySegment.set(k.parentShaftId, [k]);
  }

  let removed = 0;

  const collapseSupport = (support: CollapsibleSupport): void => {
    const socketJointId = support.contactCone?.socketJointId;
    // Walk top-down so a removal never invalidates a not-yet-visited lower segment,
    // and so segment indices below the edit stay stable.
    for (let i = support.segments.length - 1; i >= 0; i--) {
      const seg = support.segments[i];
      const bot = seg.bottomJoint;
      const top = seg.topJoint;
      // Only collapse a real two-joint stub. A segment with no bottomJoint connects
      // to the root/knot (no sphere to merge there); one with no topJoint ends in
      // the cone (handled by the segment above). Leave those alone.
      if (!bot || !top) continue;
      if (jointDist(bot, top) > DEGENERATE_SEGMENT_MM) continue;

      // Decide which joint survives. Never drop the cone's socket joint.
      const topIsSocket = socketJointId !== undefined && top.id === socketJointId;
      const botIsSocket = socketJointId !== undefined && bot.id === socketJointId;
      // Keeper defaults to the UPPER joint (toward the cone); if the LOWER one is the
      // socket, keep that instead so the cone reference and its position are intact.
      const keeper = botIsSocket ? bot : top;
      const dropped = keeper === top ? bot : top;

      // If the keeper is the socket we keep its position untouched (so the cone does
      // not move). Otherwise we keep the upper joint's position — also leaving the
      // cone side fixed. Either way the kept position is the one nearer the model.
      // Re-point the segment below the dropped joint onto the keeper.
      const belowSeg = support.segments[i - 1];
      if (belowSeg && belowSeg.topJoint && dropped && belowSeg.topJoint.id === dropped.id) {
        belowSeg.topJoint = keeper;
      }
      // The segment ABOVE (i+1) already connects via `top`; if we dropped `top`
      // (because bottom was the socket — only happens at the very top), re-point it.
      const aboveSeg = support.segments[i + 1];
      if (aboveSeg && aboveSeg.bottomJoint && dropped && aboveSeg.bottomJoint.id === dropped.id) {
        aboveSeg.bottomJoint = keeper;
      }

      // Re-point any knots that rode this stub segment onto the merged segment.
      const ridingKnots = knotsBySegment.get(seg.id);
      const mergeTargetSegId = belowSeg ? belowSeg.id : (aboveSeg ? aboveSeg.id : seg.id);
      if (ridingKnots && mergeTargetSegId !== seg.id) {
        for (const k of ridingKnots) {
          k.parentShaftId = mergeTargetSegId;
          // The stub is sub-0.45mm; clamp the knot to the keeper end (t=1 toward the
          // cone for the below-segment, t=0 for the above-segment).
          k.t = belowSeg ? 1 : 0;
          k.pos.x = keeper.pos.x;
          k.pos.y = keeper.pos.y;
          k.pos.z = keeper.pos.z;
        }
      }

      // Remove the stub segment.
      support.segments.splice(i, 1);
      removed++;
    }
  };

  for (const t of trunks) collapseSupport(t);
  for (const b of branches) collapseSupport(b);
  return removed;
}
