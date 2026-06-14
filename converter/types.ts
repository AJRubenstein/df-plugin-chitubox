import { Vec3 } from '@/supports/types';

/**
 * Shared structural types for CBX (.chitubox) support conversion.
 *
 * These interfaces intentionally represent only the fields the contact-assembly
 * helper reads off a support endpoint — not a complete schema for the format.
 */

/** A point/vector in support-local space (mm). Re-exported for convenience. */
export type CbxVector = Vec3;

/**
 * Minimal contact-endpoint shape consumed by `createContactAssembly`.
 *
 * The converter synthesizes one of these per tip: `tip` is the contact point on
 * the model, `base` is the attachment point on the support body (the knot), and
 * `tipNormal` (optional) is the authored surface normal — CBX does not store
 * one, so it is normally absent and the helper solves the cone axis geometrically.
 */
export interface CbxContactInput {
  id: string;
  base: CbxVector;
  tip: CbxVector;
  tipNormal?: CbxVector;
  settings?: unknown;
}
