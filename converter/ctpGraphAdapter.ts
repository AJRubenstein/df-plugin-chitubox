/**
 * Map a .ctp pool record onto the graph vocabulary.
 *
 * CHITUBOX Pro carries the same record taxonomy as .chitubox, in a different
 * field: what .chitubox calls `sub`, .ctp calls `role`, with the shared
 * categories numbered identically -- tip 1, pillar 3, base 4, foot 5, knot 9,
 * twig 12. The .ctp `sub` column is constant per role and classifies nothing.
 *
 * So the graph builder and emitter need no .ctp branch: feeding them `role` as
 * `sub` is the whole adaptation.
 */

import type { PoolRecord } from '../CtpParser';

/**
 * A contact hanging DOWN from a pillar bottom: the foot of a support standing
 * on the model. The emitter finds it among tips, so it maps onto tip.
 */
const ROLE_DOWNWARD_CONTACT = 2;
const SUB_TIP = 1;

/** A record the graph reads: `sub` taken from the .ctp `role` column. */
export interface CtpGraphRecord {
  index: number;
  sub: number;
  x: number; y: number; topZ: number;
  x2: number; y2: number; botZ: number;
  paramA: number;
  paramB: number;
  extra: number;
}

export function toGraphRecords(records: PoolRecord[]): CtpGraphRecord[] {
  return records.map((r, index) => ({
    index,
    sub: r.role === ROLE_DOWNWARD_CONTACT ? SUB_TIP : r.role,
    x: r.x, y: r.y, topZ: r.topZ,
    x2: r.x2, y2: r.y2, botZ: r.botZ,
    paramA: r.paramA,
    paramB: r.paramB,
    extra: r.extra,
  }));
}
