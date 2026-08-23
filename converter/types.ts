import * as THREE from 'three';
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

export const LOG_PREFIX = '[CbxConverter]';

/**
 * Debug instrumentation flag. When true, the converter emits a detailed geometry
 * trace for every native branch (knot/middle-joint/socket/cone positions, shaft
 * rise vs cone reach, angles from vertical) plus the penetration self-check.
 * Toggle via the CBX_DEBUG env var (`CBX_DEBUG=0` to silence) or by flipping the
 * default here.
 */
export const CBX_DEBUG = (typeof process !== 'undefined' && process.env && process.env.CBX_DEBUG === '0')
  ? false
  : true;

export function cbxDebug(...args: unknown[]): void {
  if (CBX_DEBUG) console.log('[CbxDebug]', ...args);
}

/**
 * Fallback tip defaults for createContactAssembly, used only where the Cbx
 * record authors no value. They mirror the host's DEFAULT_TIP_* settings, so
 * the cone keeps native proportions.
 *
 * An authored contact diameter always wins; only the body end falls back. If
 * the host's live `settings.tip` reaches convert(), it is used instead.
 */
export const CBX_TIP_DEFAULTS = {
  lengthMm: 2.5,
  bodyDiameterMm: 1.0,
  contactDiameterMm: 0.3,
  diskThicknessMm: 0.1,
  maxStandoffMm: 0.25,
  standoffAngleThreshold: Math.PI / 4,
  penetrationMm: 0.1,
};

export type CbxTipDefaults = typeof CBX_TIP_DEFAULTS;

/**
 * Fallback root/shaft defaults, sourced from settings rather than the file.
 * Cbx's skate radius is deliberately not used as the pad diameter: the plate
 * footprint is a DragonFruit setting, not authored geometry.
 */
export const CBX_ROOT_DEFAULTS = {
  diameterMm: 3.0,
  diskHeightMm: 0.5,
  coneHeightMm: 1.0,
};

export const CBX_SHAFT_DEFAULTS = {
  diameterMm: 0.7,
};

// Max XY distance (mm) from a brace endpoint to a pillar shaft for attachment.
// Brace endpoints sit on pillar centres (verified within ~0.5mm); 1.0mm gives a
// small safety margin without risking a wrong-shaft match in dense layouts.
export const CBX_BRACE_ATTACH_TOL_MM = 1.0;

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
  /**
   * Authored socket XY (P2 of the Cbx tip record): where the cone's wide end sits.
   * Together with the contact point this gives the TRUE authored approach direction
   * (P1→P2), which is often steeply slanted. Without it the cone has to be rebuilt
   * vertically below the contact, bending the approach away from the authored
   * direction so tips climb vertically instead of driving into the surface.
   */
  socketX: number;
  socketY: number;
  /** Authored cone length, mm (= 3D distance contact→socket). */
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
  /**
   * True when this pillar's base sits mid-air at a brace convergence point (a
   * fork junction) rather than on the plate. Such a pillar is not a grounded
   * trunk — it is a Branch growing UP out of the point where ≥2 braces meet. The
   * converter emits it as a Branch parented to the convergence knot (which the
   * braces create) instead of a grounded trunk with a floating root "cup".
   */
  isForkJunction?: boolean;
  /**
   * Contact that hangs DOWN from this support's base onto the model, present
   * when the support spans between two parts of the model rather than standing
   * on the plate. Its socket meets the pillar bottom; its contact is below.
   *
   * With one of these the support is a DragonFruit Stick.
   * Any remaining upward tips become leaves or branches on the hub.
   * 
   */
  downwardTip?: CbxTip;
}

/**
 * Authored per-instance plate transform, read directly from the `.chitubox`
 * per-instance header table (parser open-coded the sub-offsets):
 *   plateX ← header +660, plateY ← header +664, liftZ ← header +668.
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

/**
 * A twig support equiv. Cbx stores it as a sub-12 record.
 */
export interface CbxTwig {
  /** Contact endpoint A (world space, on the model surface). */
  ax: number;
  ay: number;
  az: number;
  /** Contact endpoint B (world space, on the model surface). */
  bx: number;
  by: number;
  bz: number;
  /** Body / contact diameter, mm. */
  diameter: number;
}

/**
 * A brace-fed, tip-bearing JUNCTION that has no pillar of its own. Chitubox builds
 * multi-level support trees where a high junction knot (no pillar) is reached by a
 * single diagonal brace from a grounded pillar's knot, and one-or-more tips fan out
 * from that junction up to the model.
 *
 * In DragonFruit terms this is a Branch: parented to the source pillar's knot
 * (parentX/Y/Z), its first segment runs along the brace up to the junction
 * (junctionX/Y/Z), and the tips become contact cones.
 */
export interface CbxJunctionBranch {
  /** Junction point (world space) where the brace ends and the tips fan out. */
  junctionX: number;
  junctionY: number;
  junctionZ: number;
  /** Parent attachment point (world space): the pillared knot the brace comes from. */
  parentX: number;
  parentY: number;
  parentZ: number;
  /** Shaft (brace) diameter, mm. */
  diameter: number;
  /** Contact tips fanning out from the junction to the model. */
  tips: CbxTip[];
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
  /** Tiny model-to-model twigs (sub-12). Optional for the same back-compat reason. */
  twigs?: CbxTwig[];
  /**
   * Brace-fed, tip-bearing junction knots that have no pillar (multi-level support
   * trees). Rebuilt as DragonFruit branches. Optional for back-compat.
   */
  junctionBranches?: CbxJunctionBranch[];
  /**
   * Authored per-instance plate transform (plate XY + Z-lift). Optional so older
   * callers / synthetic fixtures that don't set it still type-check; the bridge
   * defaults a missing transform to the origin.
   */
  transform?: CbxTransform;
}
