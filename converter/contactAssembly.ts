import * as THREE from 'three';
import { v4 as uuidv4 } from 'uuid';
import { ContactCone } from '@/supports/SupportPrimitives/ContactCone/types';
import { Joint, Vec3 } from '@/supports/types';
import { getJointDiameter } from '@/supports/constants';
import { calculateSmoothedNormal } from '@/supports/PlacementLogic/PlacementUtils';
import { calculateDiskThickness } from '@/supports/SupportPrimitives/ContactDisk/contactDiskUtils';
import { CbxContactInput } from './types';

/**
 * Builds a contact-cone + socket-joint pair for a converted CBX support endpoint.
 *
 * This mirrors the proven LYS importer contract (df-plugin-lys), which maps an
 * external slicer's contacts onto NATIVE DragonFruit contact cones rather than
 * replicating the slicer's own tip geometry. The key idea (from the DF author):
 *
 *   - The cone `normal` (cone axis / shaft direction) keeps the authored APPROACH
 *     angle — the direction the support arrives from (socket → tip).
 *   - The cone `surfaceNormal` is the TRUE model surface normal, recovered by
 *     raycasting the mesh. The contact DISK seats perpendicular to this.
 *   - The disk's socket joint absorbs the angular difference between the two.
 *
 * This is the same split the native twigBuilder/leaf use, so the result registers
 * as a proper, editable DF support — not abnormal geometry the editor can't handle.
 *
 * CBX does NOT author a tip normal, so `preferAuthoredNormal` is effectively unused
 * here; the cone axis is solved geometrically from startPos → tip, and the surface
 * normal comes from the mesh raycast (falling back to the cone axis on a miss).
 */
export function createContactAssembly(
  s: CbxContactInput,
  tipWorld: THREE.Vector3,
  startPos: Vec3,
  tipSettings: any,
  tipDefaults: any,
  mesh?: THREE.Mesh,
  preferAuthoredNormal: boolean = false,
  strictAuthoredCoordinates: boolean = false,
  transformedTipNormal?: THREE.Vector3 | null,
  enforceSocketBelowTip: boolean = true
): { socketJoint: Joint; contactCone: ContactCone } {
  // Resolve primary geometric values from imported tip settings.
  const tipLen = tipSettings?.length || tipDefaults.lengthMm;
  const tipBodyDiameter = tipSettings?.diameter || tipDefaults.bodyDiameterMm;

  const dx = tipWorld.x - startPos.x;
  const dy = tipWorld.y - startPos.y;
  const hDistSq = dx * dx + dy * dy;
  const tipLenSq = tipLen * tipLen;

  let socketPosVec: THREE.Vector3;
  let coneAxis: THREE.Vector3 | null = null;

  const authoredTipNormal = transformedTipNormal
    ? transformedTipNormal.clone()
    : s.tipNormal
      ? new THREE.Vector3(s.tipNormal.x, s.tipNormal.y, s.tipNormal.z)
      : null;

  // Preferred path: use an authored tip normal if available/allowed (rare for CBX).
  if (preferAuthoredNormal && authoredTipNormal && authoredTipNormal.lengthSq() > 1e-8) {
    const normalized = authoredTipNormal.clone().normalize();
    const axisA = normalized.clone();
    const axisB = normalized.clone().multiplyScalar(-1);
    const socketA = axisA.clone().multiplyScalar(tipLen).add(tipWorld);
    const socketB = axisB.clone().multiplyScalar(tipLen).add(tipWorld);
    const startPosVec = new THREE.Vector3(startPos.x, startPos.y, startPos.z);
    const epsilon = 1e-6;
    const socketAIsBelowTip = socketA.z <= tipWorld.z + epsilon;
    const socketBIsBelowTip = socketB.z <= tipWorld.z + epsilon;

    if (enforceSocketBelowTip && socketAIsBelowTip !== socketBIsBelowTip) {
      if (socketAIsBelowTip) {
        coneAxis = axisA;
        socketPosVec = socketA;
      } else {
        coneAxis = axisB;
        socketPosVec = socketB;
      }
    } else {
      if (socketA.distanceTo(startPosVec) <= socketB.distanceTo(startPosVec)) {
        coneAxis = axisA;
        socketPosVec = socketA;
      } else {
        coneAxis = axisB;
        socketPosVec = socketB;
      }
    }
  } else if (hDistSq <= tipLenSq) {
    // Geometric fallback: infer a valid socket by solving the vertical component
    // from the tip length, keeping the socket at the start (shaft) XY.
    const vOffset = Math.sqrt(tipLenSq - hDistSq);
    socketPosVec = new THREE.Vector3(
      startPos.x,
      startPos.y,
      tipWorld.z - vOffset
    );
    if (socketPosVec.z < startPos.z) {
      const toStart = new THREE.Vector3(
        startPos.x - tipWorld.x,
        startPos.y - tipWorld.y,
        startPos.z - tipWorld.z
      );
      socketPosVec = toStart.normalize().multiplyScalar(tipLen).add(tipWorld);
    }
  } else {
    // Final fallback: place the socket along the start->tip axis at tip length.
    const toStart = new THREE.Vector3(
      startPos.x - tipWorld.x,
      startPos.y - tipWorld.y,
      startPos.z - tipWorld.z
    );
    socketPosVec = toStart.normalize().multiplyScalar(tipLen).add(tipWorld);
  }

  const socketJoint: Joint = {
    id: uuidv4(),
    pos: { x: socketPosVec.x, y: socketPosVec.y, z: socketPosVec.z },
    diameter: getJointDiameter(tipBodyDiameter)
  };

  if (!coneAxis) {
    coneAxis = socketPosVec.clone().sub(tipWorld).normalize();
  }

  let finalTipPos = { x: tipWorld.x, y: tipWorld.y, z: tipWorld.z };
  let surfaceNormal: Vec3 | undefined = undefined;
  const hasAuthoredTipNormal = !!(authoredTipNormal && authoredTipNormal.lengthSq() > 1e-8);

  // Surface normal source priority:
  // 1) authored tip normal (rare for CBX)
  // 2) mesh raycast normal (the usual CBX path)
  // 3) cone axis (fallback)
  if (hasAuthoredTipNormal && authoredTipNormal) {
    const n = authoredTipNormal.clone().normalize();
    surfaceNormal = { x: n.x, y: n.y, z: n.z };
  } else if (!strictAuthoredCoordinates && mesh) {
    const raycaster = new THREE.Raycaster();
    const rayOrigin = socketPosVec.clone();
    const rayDir = tipWorld.clone().sub(socketPosVec).normalize();
    raycaster.set(rayOrigin, rayDir);
    const intersects = raycaster.intersectObject(mesh, false);

    if (intersects.length > 0) {
      const hit = intersects[0];
      finalTipPos = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
      const smoothed = calculateSmoothedNormal(hit);
      surfaceNormal = { x: smoothed.x, y: smoothed.y, z: smoothed.z };
    }
  }

  const coneProfile = {
    type: 'disk' as const,
    lengthMm: tipLen,
    contactDiameterMm: tipSettings?.pointDiameter || tipDefaults.contactDiameterMm,
    bodyDiameterMm: tipBodyDiameter,
    diskThicknessMm: tipDefaults.diskThicknessMm ?? 0.1,
    maxStandoffMm: tipDefaults.maxStandoffMm ?? 0.25,
    standoffAngleThreshold: tipDefaults.standoffAngleThreshold ?? Math.PI / 4,
    penetrationMm: tipDefaults.penetrationMm
  };

  const effectiveSurfaceNormal = surfaceNormal || { x: coneAxis.x, y: coneAxis.y, z: coneAxis.z };
  const diskOffset = strictAuthoredCoordinates
    ? 0
    : calculateDiskThickness(effectiveSurfaceNormal, { x: coneAxis.x, y: coneAxis.y, z: coneAxis.z }, coneProfile);

  const coneStartPos = {
    x: finalTipPos.x + effectiveSurfaceNormal.x * diskOffset,
    y: finalTipPos.y + effectiveSurfaceNormal.y * diskOffset,
    z: finalTipPos.z + effectiveSurfaceNormal.z * diskOffset
  };

  const alignedSocketPos = {
    x: coneStartPos.x + coneAxis.x * tipLen,
    y: coneStartPos.y + coneAxis.y * tipLen,
    z: coneStartPos.z + coneAxis.z * tipLen
  };

  socketJoint.pos = alignedSocketPos;

  const contactCone: ContactCone = {
    id: uuidv4(),
    pos: finalTipPos,
    normal: { x: coneAxis.x, y: coneAxis.y, z: coneAxis.z },
    surfaceNormal: surfaceNormal,
    socketJointId: socketJoint.id,
    profile: coneProfile
  };

  return { socketJoint, contactCone };
}
