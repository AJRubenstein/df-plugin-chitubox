import * as THREE from 'three';
import { v4 as uuidv4 } from 'uuid';
import { ContactCone } from '@/supports/SupportPrimitives/ContactCone/types';
import { Joint, Vec3 } from '@/supports/types';
import { getJointDiameter } from '@/supports/constants';
import { calculateSmoothedNormal } from '@/supports/PlacementLogic/PlacementUtils';
import { calculateDiskThickness } from '@/supports/SupportPrimitives/ContactDisk/contactDiskUtils';
import { CbxContactInput } from './types';

/**
 * Builds a contact-cone and socket-joint pair for a converted support endpoint,
 * mapping the authored contact onto a native DragonFruit cone rather than
 * replicating Chitubox's own tip geometry.
 *
 *   - `normal` (the cone axis) keeps the authored approach angle, socket -> tip.
 *   - `surfaceNormal` is the true model normal from a mesh raycast; the contact
 *     disk seats perpendicular to it.
 *   - The socket joint absorbs the angle between the two.
 *
 * Cbx authors no tip normal, so the axis is solved geometrically and the surface
 * normal falls back to the axis on a raycast miss.
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

  // The mesh raycast (finalTipPos) is the TRUE surface contact, which rarely sits
  // exactly where the authored tipLen predicted (CBX's own contact estimate vs
  // DF's raycast hit almost never agree exactly). Re-deriving the socket by
  // walking the FIXED authored tipLen from the corrected tip drags the socket off
  // the shaft's planned line by the full mismatch, producing a visible dogleg in
  // the trunk. The raycast travels along the coneAxis line by construction (it's
  // cast from socketPosVec toward tipWorld), so finalTipPos always lies on that
  // same ray — project the original geometric socket guess back onto it instead.
  // This re-anchors the socket at the planned attach point and lets the cone's
  // actual length absorb the real-vs-authored distance, instead of the socket.
  const MIN_CONE_LEN_MM = 0.3;
  const coneStartVec = new THREE.Vector3(coneStartPos.x, coneStartPos.y, coneStartPos.z);
  const projectedLen = socketPosVec.clone().sub(coneStartVec).dot(coneAxis);
  const effectiveLen = projectedLen > MIN_CONE_LEN_MM ? projectedLen : tipLen;
  coneProfile.lengthMm = effectiveLen;

  const alignedSocketPos = {
    x: coneStartPos.x + coneAxis.x * effectiveLen,
    y: coneStartPos.y + coneAxis.y * effectiveLen,
    z: coneStartPos.z + coneAxis.z * effectiveLen
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
