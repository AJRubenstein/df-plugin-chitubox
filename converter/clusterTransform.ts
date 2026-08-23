/**
 * Cluster transform operations: move a converted support cluster as a whole into
 * its final plate frame. Extracted from CbxConverter so the Z-shift, XY-shift, and
 * root-seating walks live side by side — keeping them together makes it obvious
 * when a primitive type (e.g. leaves) is missing from one walk but not another.
 */
import * as THREE from 'three';
import { DragonfruitImportFormat, Joint, Segment, Vec3 } from '@/supports/types';
import { CbxSupport, CbxModelInput } from './types';

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

export function applyZShift(data: DragonfruitImportFormat, deltaZ: number): void {
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
  for (const twig of data.twigs ?? []) {
    shiftSegments(twig.segments);
    if (twig.contactDiskA?.pos) twig.contactDiskA.pos.z += deltaZ;
    if (twig.contactDiskB?.pos) twig.contactDiskB.pos.z += deltaZ;
  }


  for (const stick of data.sticks ?? []) {
    shiftSegments(stick.segments);
    shiftCone(stick.contactConeA);
    shiftCone(stick.contactConeB);
  }
  for (const leaf of data.leaves ?? []) {
    shiftCone(leaf.contactCone);
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
export function applyXYShift(data: DragonfruitImportFormat, deltaX: number, deltaY: number): void {
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
  for (const twig of data.twigs ?? []) {
    shiftSegments(twig.segments);
    shiftCone(twig.contactDiskA);
    shiftCone(twig.contactDiskB);
  }
  // Sticks were missing here too -- same defect as applyZShift above.
  for (const stick of data.sticks ?? []) {
    shiftSegments(stick.segments);
    shiftCone(stick.contactConeA);
    shiftCone(stick.contactConeB);
  }
  for (const leaf of data.leaves ?? []) {
    // Leaves carry only a contact cone (no segments); its pos MUST shift with the
    // cluster or the leaf detaches from its (shifted) knot and tunnels. This was
    // the cause of leaf cones stretching across the model on plate-shifted imports.
    shiftCone(leaf.contactCone);
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
 * Really just a hacky way to reseat supports that are stuck to thick rafts
 * in a native Chitubox file.
 */
export function seatRootsOnPlate(data: DragonfruitImportFormat, plateZ = 0): void {
  for (const root of data.roots) {
    if (root.transform?.pos) root.transform.pos.z = plateZ;
  }
}
