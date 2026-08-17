/**
 * CBX converter geometry helpers — the pure "given a knot and a contact, build a
 * primitive" functions, extracted from CbxConverter.ts to mirror the LYS plugin's
 * converter/helpers.ts split. These are stateless: they take geometry in and return
 * DragonFruit primitives, with no knowledge of the overall convert orchestration.
 */
import * as THREE from 'three';
import { Vec3, Knot, Joint, Segment, Branch, Leaf, Trunk } from '@/supports/types';
import { getJointDiameter } from '@/supports/constants';
import { recomputeLeafContactConeAxisAndLength } from '@/supports/state';
import { ContactCone } from '@/supports/SupportPrimitives/ContactCone/types';
import { createContactAssembly } from './contactAssembly';
import { v4 as uuidv4 } from 'uuid';
import { CbxTip, CbxTipDefaults, CBX_TIP_DEFAULTS, CBX_DEBUG, cbxDebug } from './types';

export function normalizeVec(v: Vec3): Vec3 {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (!Number.isFinite(len) || len < 1e-9) return { x: 0, y: 0, z: 1 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/**
 * Build a synthetic LysSupport-shaped object for createContactAssembly.
 * Cbx has no tip normal, so tipNormal is omitted; the helper then takes its
 * geometric socket-solve path (preferLysTipNormal=false).
 */
export function synthSupportForTip(tip: CbxTip, attachPos: Vec3): any {
  return {
    id: 'chitubox-synth',
    base: { x: attachPos.x, y: attachPos.y, z: attachPos.z },
    tip: { x: tip.x, y: tip.y, z: tip.contactZ },
    settings: undefined,
  };
}

/**
 * tipSettings for createContactAssembly.
 *   length        ← authored cone length.
 *   pointDiameter ← AUTHORED contactDiameter (the model footprint). Never defaulted.
 *   diameter      ← the SHAFT diameter this tip grows from, not the authored Cbx
 *                   bodyDiameter (`pb`).
 *
 * Cbx's "Connection" cone tapers from the contact (upper) to a lower/pillar
 * diameter (`pb`) that's often narrower than the shaft (e.g. a 0.80 shaft with a
 * 0.50 connection) — imported verbatim that reads as a fat joint ball necking down
 * to a thin spike, since the engine sizes the socket JOINT to the shaft diameter
 * (see applyTrunkDiameterProfile) independently of the cone's own body diameter.
 * Matching the native DF behaviour (editing shaft diameter syncs tip body diameter
 * to it, see updateShaftProfile) keeps the cone body flush with the shaft it grows
 * from, which is the look the host produces by default and what a settings-dialog
 * round-trip already converges imports to.
 *
 * @param shaftMm  the shaft/pillar diameter this tip grows from.
 */
export function synthTipSettings(tip: CbxTip, shaftMm: number): any {
  return {
    length: Number.isFinite(tip.length) && tip.length > 0 ? tip.length : undefined,
    diameter: shaftMm,
    pointDiameter: Number.isFinite(tip.contactDiameter) ? tip.contactDiameter : undefined,
  };
}

/**
 * Build a single tip hanging off a host knot as EITHER a native Leaf or a native
 * Branch, mirroring the LYS importer's decision:
 *
 *   shaftLength = distance(knot → contact) − nativeTipLength
 *   shaftLength <= LEAF_MAX_SHAFT_MM (0.2)  → Leaf  (cone reaches straight from knot)
 *   shaftLength >  LEAF_MAX_SHAFT_MM         → Branch (thin shaft + SHORT native cone)
 *
 * Why: Chitubox authors long tips (4–8mm) as a single cone from the knot to the
 * model. Imported verbatim that's one long, fat (body-diameter) cone swinging out
 * at a steep angle — it reads as a "twist" and overhangs the knot. The native DF
 * form is a thin shaft carrying most of the distance, capped by a SHORT contact
 * cone (the native ~2.5mm) at the model. That's slim along the shaft, seats cleanly
 * via the disk, and is what DF would build if the tip were hand-placed. Short tips
 * stay leaves (no shaft needed), which is correct for compact supports like HAND.
 *
 * The contact cone is always aimed/length-solved from the knot to the FIXED model
 * contact via the host's recomputeLeafContactConeAxisAndLength, so the model-side
 * clearance is preserved and the cone won't "snap" on first edit.
 *
 * `forceLeaf` overrides the length test. A stick's hub carries an authored FAN of
 * long tips (CriosphinxHead: six, 7-8mm each) and the host builds exactly that
 * shape by hand -- its "Leaf Fanning" mode sprouts long leaves straight from a
 * shaft. Splitting them into branches there invents shafts Chitubox never
 * authored and detaches the fan from the hub, so hub tips stay leaves whatever
 * their length. The length test still governs trunk/branch tips, where a long
 * unsupported cone really would read as a twist.
 */
export const LEAF_MAX_SHAFT_MM = 0.2;
export function buildTipFromKnot(
  tip: CbxTip,
  knot: Knot,
  knotPos: Vec3,
  contactWorld: THREE.Vector3,
  shaftDiameter: number,
  modelId: string,
  tipDefaults: typeof CBX_TIP_DEFAULTS,
  mesh?: THREE.Mesh,
  forceLeaf = false,
): { leaf?: Leaf; branch?: Branch } {
  const knotToContact = Math.hypot(
    contactWorld.x - knotPos.x,
    contactWorld.y - knotPos.y,
    contactWorld.z - knotPos.z,
  );
  const nativeTipLen = tipDefaults.lengthMm;
  const shaftLength = knotToContact - nativeTipLen;
  const asBranch = !forceLeaf && shaftLength > LEAF_MAX_SHAFT_MM;

  // For a branch, the cone is the SHORT native tip (it sits at the model end of a
  // shaft). For a leaf, the cone spans the whole authored distance from the knot.
  // Body diameter follows the shaft (see synthTipSettings) in both cases.
  const tipSettingsForCone = asBranch
    ? { length: nativeTipLen, diameter: shaftDiameter, pointDiameter: tip.contactDiameter }
    : synthTipSettings(tip, shaftDiameter);

  const assembly = createContactAssembly(
    synthSupportForTip(tip, knotPos),
    contactWorld,
    knotPos,
    tipSettingsForCone,
    tipDefaults,
    mesh,
    false, false, null, true,
  );
  const cone = assembly.contactCone;

  if (!asBranch) {
    // Leaf: aim the cone from the knot straight to the contact.
    if (cone.surfaceNormal) {
      const { axis, lengthMm } = recomputeLeafContactConeAxisAndLength(
        cone.pos, cone.surfaceNormal, knotPos, cone.profile,
      );
      cone.normal = axis;
      cone.profile.lengthMm = lengthMm;
    }
    if (CBX_DEBUG) {
      cbxDebug(
        `LEAF  knot=(${knotPos.x.toFixed(2)},${knotPos.y.toFixed(2)},${knotPos.z.toFixed(2)}) `
        + `contact=(${cone.pos.x.toFixed(2)},${cone.pos.y.toFixed(2)},${cone.pos.z.toFixed(2)}) `
        + `knotToContact=${knotToContact.toFixed(2)} shaftLength=${shaftLength.toFixed(2)} coneLen=${(cone.profile.lengthMm ?? 0).toFixed(2)}`,
      );
    }
    return { leaf: { id: uuidv4(), modelId, parentKnotId: knot.id, contactCone: cone } };
  }

  if (CBX_DEBUG) {
    const sp = assembly.socketJoint.pos;
    const rise = sp.z - knotPos.z;
    const len = Math.hypot(sp.x - knotPos.x, sp.y - knotPos.y, sp.z - knotPos.z);
    cbxDebug(
      `BRANCH knot=(${knotPos.x.toFixed(2)},${knotPos.y.toFixed(2)},${knotPos.z.toFixed(2)}) `
      + `contact=(${cone.pos.x.toFixed(2)},${cone.pos.y.toFixed(2)},${cone.pos.z.toFixed(2)}) `
      + `knotToContact=${knotToContact.toFixed(2)} shaftLength=${shaftLength.toFixed(2)} shaftRise=${rise.toFixed(2)} shaftLen=${len.toFixed(2)}`,
    );
  }

  // Branch: a thin shaft from the knot toward the contact, ending at the cone's
  // socket joint (the short native cone caps it at the model). The shaft direction
  // follows knot → cone socket; the cone keeps its own socket joint.
  return {
    branch: {
      id: uuidv4(),
      modelId,
      parentKnotId: knot.id,
      segments: [
        {
          id: uuidv4(),
          type: 'straight',
          diameter: shaftDiameter,
          bottomJoint: undefined, // connects to the parent knot
          topJoint: assembly.socketJoint,
        },
      ],
      contactCone: cone,
    },
  };
}

/**
 * Build a Branch off a parent knot EXACTLY the way the proven LYS importer does:
 * call createContactAssembly (the shared cone/socket solver) with the parent knot
 * as the start point and the model contact as the tip, then wrap its socketJoint +
 * contactCone in a single-segment branch. NO middle joint, NO custom cone-axis
 * blending, NO surface-normal raycast, NO socket clamp — createContactAssembly
 * already solves the socket placement and cone axis (and enforces socket-below-tip).
 * Our earlier hand-rolled geometry fought that solver and produced giant sideways
 * cones; deferring entirely to createContactAssembly (the LYS contract) fixes it.
 *
 *   LYS: const { socketJoint, contactCone } = createContactAssembly(s, tip, knotPos, ...);
 *        const segment = { straight, diameter, bottomJoint: undefined, topJoint: socketJoint };
 *        const branch  = { parentKnotId: knot.id, segments: [segment], contactCone };
 */
export function buildNativeBranch(
  tip: CbxTip,
  parentKnot: Knot,
  contactWorld: THREE.Vector3,
  shaftDiameter: number,
  modelId: string,
  tipDefaults: typeof CBX_TIP_DEFAULTS,
  mesh?: THREE.Mesh,
): Branch {
  const knotPos = parentKnot.pos;

  // Native tip dimensions so the branch ends in a small DF tip (not the fat authored
  // Chitubox body). createContactAssembly solves the socket + cone from the knot to
  // the contact, with enforceSocketBelowTip=true so the socket sits below the tip and
  // the branch shaft rises from the knot to it (single segment, exactly like LYS).
  const tipSettings = {
    length: tipDefaults.lengthMm,
    diameter: tipDefaults.bodyDiameterMm,
    pointDiameter: tipDefaults.contactDiameterMm,
  };
  const { socketJoint, contactCone } = createContactAssembly(
    synthSupportForTip(tip, knotPos),
    contactWorld,
    knotPos,
    tipSettings,
    tipDefaults,
    mesh,
    false, // preferAuthoredNormal — CBX has no authored tip normal
    false, // strictAuthoredCoordinates
    null,
    true,  // enforceSocketBelowTip — keep the socket below the contact so it ascends
  );

  const segment: Segment = {
    id: uuidv4(),
    type: 'straight',
    diameter: shaftDiameter,
    bottomJoint: undefined, // connects to the parent knot
    topJoint: socketJoint,
  };

  if (CBX_DEBUG) {
    const sp = socketJoint.pos;
    const shaftRise = sp.z - knotPos.z;
    const shaftLen = Math.hypot(sp.x - knotPos.x, sp.y - knotPos.y, sp.z - knotPos.z);
    const shaftAng = Math.acos(Math.min(1, Math.abs(shaftRise) / (shaftLen || 1))) * 180 / Math.PI;
    const coneReach = Math.hypot(contactCone.pos.x - sp.x, contactCone.pos.y - sp.y, contactCone.pos.z - sp.z);
    cbxDebug(
      `branch knot=(${knotPos.x.toFixed(2)},${knotPos.y.toFixed(2)},${knotPos.z.toFixed(2)}) `
      + `contact=(${contactCone.pos.x.toFixed(2)},${contactCone.pos.y.toFixed(2)},${contactCone.pos.z.toFixed(2)}) | `
      + `shaft: len=${shaftLen.toFixed(2)} rise=${shaftRise.toFixed(2)} ang=${shaftAng.toFixed(0)}° | `
      + `cone: reach=${coneReach.toFixed(2)} len=${(contactCone.profile.lengthMm ?? 0).toFixed(2)} `
      + `${shaftRise < 0.3 ? '<<< NEAR-ZERO SHAFT' : ''}`,
    );
  }

  return {
    id: uuidv4(),
    modelId,
    parentKnotId: parentKnot.id,
    segments: [segment],
    contactCone,
  };
}

/**
 * Apply the native trunk diameter profile at import time — the thing the host's
 * computeAndApplyTrunkDiameterProfile does on edit (and which otherwise only runs
 * when you nudge the trunk diameter). Without it an imported trunk stays a uniform
 * thin shaft with branches stuck on abruptly; with it the shaft is SPLIT at each
 * branch knot and thickened bottom-up so it carries the branch load — the smooth
 * stepped taper DF shows after the edit.
 *
 * Two effects, mirroring the host:
 *  1. Split the hosting segment at each branch knot so the knot is a boundary, and
 *     anchor the knot to the lower (thicker) side at t=1.
 *  2. Bottom-up running max: each segment's diameter = max(its own contact/shaft
 *     demand, the diameter demand of any branch attached above). Joints take the
 *     thicker adjacent segment's getJointDiameter.
 *
 * Mutates and returns the trunk; updates knot parentShaftId/t in `knots` in place.
 */
export function applyTrunkDiameterProfile(
  trunk: Trunk,
  rootTopZ: number,
  knots: Knot[],
  branches: Branch[],
): Trunk {
  const branchesByKnot = new Map<string, Branch[]>();
  for (const b of branches) {
    if (!b.parentKnotId) continue;
    const list = branchesByKnot.get(b.parentKnotId);
    if (list) list.push(b); else branchesByKnot.set(b.parentKnotId, [b]);
  }

  // Knots on this trunk that host branches, processed top-down so split indices stay valid.
  const segIds = new Set(trunk.segments.map((s) => s.id));
  const branchKnots = knots
    .filter((k) => segIds.has(k.parentShaftId) && (branchesByKnot.get(k.id)?.length ?? 0) > 0)
    .sort((a, b) => b.pos.z - a.pos.z);

  const segEndpoints = (seg: Segment, idx: number): { start: Vec3; end: Vec3 } => {
    const start = seg.bottomJoint?.pos
      ?? (idx === 0 ? { x: seg.topJoint?.pos.x ?? 0, y: seg.topJoint?.pos.y ?? 0, z: rootTopZ } : trunk.segments[idx - 1].topJoint!.pos);
    const end = seg.topJoint?.pos ?? trunk.contactCone?.pos ?? { x: start.x, y: start.y, z: start.z + 10 };
    return { start, end };
  };

  // 1) Split segments at each branch knot.
  for (const knot of branchKnots) {
    const segIdx = trunk.segments.findIndex((s) => s.id === knot.parentShaftId);
    if (segIdx === -1) continue;
    const seg = trunk.segments[segIdx];
    const { start, end } = segEndpoints(seg, segIdx);
    const t = typeof knot.t === 'number' ? Math.min(1, Math.max(0, knot.t)) : computeLinearTLocal(knot.pos, start, end);

    if (t >= 1 - 1e-6) { knot.t = 1; continue; }
    if (t <= 1e-6) {
      // Boundary at the bottom: anchor to the segment below if any.
      if (segIdx > 0) { knot.parentShaftId = trunk.segments[segIdx - 1].id; knot.t = 1; }
      continue;
    }

    // Split: a new joint at the knot, lower seg [start→knot], upper seg [knot→end].
    const splitJoint: Joint = {
      id: uuidv4(),
      pos: { x: knot.pos.x, y: knot.pos.y, z: knot.pos.z },
      diameter: seg.diameter, // refined below
    };
    const lowerSeg: Segment = { id: uuidv4(), type: 'straight', diameter: seg.diameter, bottomJoint: seg.bottomJoint, topJoint: splitJoint };
    const upperSeg: Segment = { id: uuidv4(), type: 'straight', diameter: seg.diameter, bottomJoint: splitJoint, topJoint: seg.topJoint };
    trunk.segments.splice(segIdx, 1, lowerSeg, upperSeg);
    // Anchor this knot (and any other knots on the old segment) to the correct side.
    for (const k of knots) {
      if (k.parentShaftId !== seg.id) continue;
      const kt = typeof k.t === 'number' ? k.t : computeLinearTLocal(k.pos, start, end);
      if (Math.abs(kt - t) <= 1e-6) { k.parentShaftId = lowerSeg.id; k.t = 1; }
      else if (kt < t) { k.parentShaftId = lowerSeg.id; k.t = t <= 1e-6 ? 0 : kt / t; }
      else { k.parentShaftId = upperSeg.id; k.t = (kt - t) / (1 - t); }
    }
  }

  // 2) Bottom-up running max diameter.
  const contactDemand = (() => {
    const p = trunk.contactCone?.profile as any;
    const coneDemand = p ? Math.max(p.bodyDiameterMm ?? 0, p.contactDiameterMm ?? 0) : 0;
    return Math.max(trunk.baseDiameterMm ?? 0, coneDemand);
  })();
  const demandAtTopBySeg = new Map<string, number>();
  for (const knot of knots) {
    if (!trunk.segments.some((s) => s.id === knot.parentShaftId)) continue;
    if (typeof knot.t !== 'number' || knot.t < 1 - 1e-6) continue;
    const attached = branchesByKnot.get(knot.id);
    if (!attached) continue;
    let demand = 0;
    for (const b of attached) for (const s of b.segments) demand = Math.max(demand, s.diameter ?? 0);
    demandAtTopBySeg.set(knot.parentShaftId, Math.max(demandAtTopBySeg.get(knot.parentShaftId) ?? 0, demand));
  }

  const segDiameters = new Array<number>(trunk.segments.length);
  let runningMax = contactDemand;
  for (let i = trunk.segments.length - 1; i >= 0; i--) {
    runningMax = Math.max(runningMax, demandAtTopBySeg.get(trunk.segments[i].id) ?? 0, trunk.segments[i].diameter ?? 0);
    segDiameters[i] = runningMax;
  }

  trunk.segments = trunk.segments.map((seg, i) => {
    const segDia = segDiameters[i];
    const belowDia = i > 0 ? segDiameters[i - 1] : segDia;
    const aboveDia = i + 1 < segDiameters.length ? segDiameters[i + 1] : segDia;
    return {
      ...seg,
      diameter: segDia,
      bottomJoint: seg.bottomJoint ? { ...seg.bottomJoint, diameter: getJointDiameter(Math.max(segDia, belowDia)) } : seg.bottomJoint,
      topJoint: seg.topJoint ? { ...seg.topJoint, diameter: getJointDiameter(Math.max(segDia, aboveDia)) } : seg.topJoint,
    };
  });

  return trunk;
}

export function computeLinearTLocal(pos: Vec3, start: Vec3, end: Vec3): number {
  const dx = end.x - start.x, dy = end.y - start.y, dz = end.z - start.z;
  const lenSq = dx * dx + dy * dy + dz * dz;
  if (lenSq < 1e-6) return 0;
  const t = ((pos.x - start.x) * dx + (pos.y - start.y) * dy + (pos.z - start.z) * dz) / lenSq;
  return Math.min(1, Math.max(0, t));
}
