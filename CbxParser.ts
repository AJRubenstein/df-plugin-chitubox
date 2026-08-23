import * as THREE from 'three';
import type { CbxModelInput, CbxSupport, CbxBrace, CbxTwig, CbxJunctionBranch } from './CbxConverter';
import { buildSupportGraph } from './converter/supportGraph';
import { emitFromGraph } from './converter/graphEmit';

/**
 * Parser for `.chitubox` project files, scoped to what import needs: model mesh
 * geometry per distinct model, and the parametric support records DragonFruit
 * rebuilds into editable primitives.
 *
 * Support mesh triangles are deliberately not extracted, since support geometry
 * is regenerated from the records to stay re-editable. Their extent is still
 * located, because it bounds each block's geometry region.
 *
 * Format:
 *   - 4-byte LE magic 0xAB231243 at offset 0.
 *   - field4 (offset 4) = model instance count, not a version.
 *   - Per-instance header blocks of 680 bytes.
 *   - Support records are 72 bytes, tagged 0xEA342389, typed by a sub-index.
 *   - Model geometry is flat 36-byte float32 triangles, no normals.
 */

const MAGIC = 0xab231243;
const TAG_EA = 0xea342389;
const REC_SIZE = 72;

// A support is a VERTICAL CHAIN of parts, not a fixed group of 4 records:
//   [base pad sub-4] → pillar sub-3 → knot sub-9 → one-or-more tips sub-1
// stitched by the continuity rule (each part's botZ ≈ the part-below's topZ).
const TIP_SUB = 1; // contact branch to the model (a support may have several)
const KNOT_SUB = 9; // spherical joint atop the pillar
const PILLAR_SUB = 3; // vertical shaft (NOT a tip — this was the core bug)
const BASE_SUB = 4; // wide base pad cone (only on larger supports)
const FOOT_SUB = 5; // wide flat ground-contact disk; its bottom marks the plate.
                    // One sits under each support (sometimes clustered into what
                    // looks like a "platform"). The disk bottom is always exactly
                    // at the plate, so it is the authoritative ground anchor.
const TWIG_SUB = 12; // tiny model-to-model support: a short strut whose BOTH ends
                     // contact the model, using the model itself as the brace.
const MODEL_HDR_SUB = 2; // skip
const SUMMARY_SUB = 6; // skip

const INLINE_PAD = 436;
// The gap from an instance's support pointer to its first TAG record. 436 in
// the common layout, 416 in the field12 == 420 variant. Rather than key off the
// variant, seek the TAG: the pad is a fixed header whose size is the only thing
// that moves, and a wrong guess silently drops every support on the instance.
const INLINE_PAD_MAX = 512;
const COORD_LIMIT = 500; // reject vertices outside ±500mm
// A sub-3 record whose two endpoints differ in XY by more than this is a brace
// (diagonal shaft-to-shaft strut) rather than a vertical pillar. Vertical pillars
// have identical endpoints (delta ~0); the smallest real braces span >1.5mm, so
// 0.8mm cleanly separates the two without catching sensor noise.
// A sub-3 record is a diagonal BRACE (not a vertical pillar) when its two
// endpoints differ in XY by more than this. Authored pillars are dead-vertical
// (dXY < 0.01); braces are ≥ ~0.5 (and 45°, dz ≈ dXY). The 0.01–0.5 band is empty
// across every test file, so 0.3 cleanly separates the two with wide margin and
// catches short braces (dXY ≈ 0.78) that a higher cut (0.8) misclassified as
// near-vertical pillars — which then produced spurious mid-air roots.
const BRACE_XY_MIN = 0.3;

// Record-table probe bounds (see findRecordBase). A candidate record is judged
// by its geometry span: in-bounds, non-empty, whole 36-byte triangles, and at
// least MIN_PROBE_TRIS of them so zero or noise regions cannot validate.
const MIN_PROBE_TRIS = 100;
const PROBE_DELTA_MAX = 128;   // max shift from meshOffset+444, either direction
const ABS_PROBE_LIMIT = 65536; // how far into the file the absolute scan looks

const LOG_PREFIX = '[CbxParser]';

/**
 * Build supports with the endpoint graph (supportGraph + graphEmit) instead of
 * the top-down chain builder.
 *
 * The graph derives structure geometrically -- endpoint coincidence, T-junction
 * splits, anchor proximity -- rather than walking pillars from the top. 
 *
 * Set CBX_CHAIN_BUILDER=1 to fall back to the chain builder. Both paths stay
 * live so the two can be compared on the same file.
 */
const USE_GRAPH_BUILDER = !(
  typeof process !== 'undefined' && process.env && process.env.CBX_CHAIN_BUILDER === '1'
);

/** Little-endian readers over a DataView (mirror struct.unpack_from('<I'/'<f')). */
function u32(view: DataView, off: number): number {
  return view.getUint32(off, true);
}
function f32(view: DataView, off: number): number {
  return view.getFloat32(off, true);
}

/**
 * Resolve an instance's support pointer to the start of its parametric block.
 * Returns null when no TAG record sits within INLINE_PAD_MAX bytes.
 */
function resolveSupportBlock(view: DataView, len: number, supPtr: number): number | null {
  // The block header at supPtr carries the record-block address at +4. Verified
  // against 181/181 support blocks, so the pad is authored, not fixed: it is 436
  // under a 412-byte file header and 416 under a 420-byte one.
  if (supPtr + 8 <= len) {
    const authored = u32(view, supPtr + 4);
    if (authored > 0 && authored + 4 <= len && u32(view, authored) === TAG_EA) return authored;
  }
  // Fall back to the historically observed pads before scanning.
  for (const pad of [INLINE_PAD, 416]) {
    const base = supPtr + pad;
    if (base > 0 && base + 4 <= len && u32(view, base) === TAG_EA) return base;
  }
  const limit = Math.min(len - 4, supPtr + INLINE_PAD_MAX);
  for (let base = Math.max(0, supPtr); base <= limit; base += 4) {
    if (u32(view, base) === TAG_EA) return base;
  }
  return null;
}

/** One decoded 72-byte parametric record. */
export interface RawRecord {
  sub: number;
  x: number;
  y: number;
  topZ: number;
  /** Second endpoint X (= x for a vertical pillar/tip; differs for a brace). */
  x2: number;
  /** Second endpoint Y (= y for a vertical pillar/tip; differs for a brace). */
  y2: number;
  botZ: number;
  paramA: number;
  paramB: number;
  geoPtr: number;
  geoBytes: number;
  extra: number;
}

function readRecord(view: DataView, base: number): RawRecord {
  return {
    sub: u32(view, base + 4),
    x: f32(view, base + 8),
    y: f32(view, base + 12),
    topZ: f32(view, base + 16),
    x2: f32(view, base + 20),
    y2: f32(view, base + 24),
    botZ: f32(view, base + 28),
    paramA: f32(view, base + 32),
    paramB: f32(view, base + 36),
    geoPtr: u32(view, base + 40),
    geoBytes: u32(view, base + 44),
    extra: f32(view, base + 48),
  };
}

/** Search for a little-endian uint32 value in bytes within [from, to). */
function indexOfU32(bytes: Uint8Array, value: number, from: number, to?: number): number {
  const b0 = value & 0xff;
  const b1 = (value >>> 8) & 0xff;
  const b2 = (value >>> 16) & 0xff;
  const b3 = (value >>> 24) & 0xff;
  const end = (to ?? bytes.length) - 3;
  for (let i = Math.max(0, from); i < end; i++) {
    if (bytes[i] === b0 && bytes[i + 1] === b1 && bytes[i + 2] === b2 && bytes[i + 3] === b3) {
      return i;
    }
  }
  return -1;
}

/** Collect every TAG_EA offset from `from` to end of buffer. */
function allTagOffsets(bytes: Uint8Array, from: number): number[] {
  const out: number[] = [];
  let p = from;
  while (true) {
    const i = indexOfU32(bytes, TAG_EA, p);
    if (i === -1) break;
    out.push(i);
    p = i + 1;
  }
  return out;
}

/**
 * Split sorted TAG offsets into blocks (one per model instance's record group).
 * A gap larger than REC_SIZE*2 between consecutive tags starts a new block.
 */
function splitBlocks(tags: number[]): number[] {
  if (tags.length === 0) return [];
  const starts = [tags[0]];
  for (let i = 0; i < tags.length - 1; i++) {
    if (tags[i + 1] - tags[i] > REC_SIZE * 2) {
      starts.push(tags[i + 1]);
    }
  }
  return starts;
}

/**
 * Debug side-channel: when set, `parseBuffer` records the resolved coordinates of
 * every support block it decodes, so an out-of-tree structure builder can be run
 * over byte-identical input without duplicating block resolution. Off in normal
 * use; nothing in the import path reads it.
 */
export interface CbxBlockRef {
  modelIndex: number;
  recBase: number;
  geoPtr: number;
  zOff: number;
}
export const cbxDebugBlocks: { capture: CbxBlockRef[] | null } = { capture: null };

/**
 * Decode every parametric record in one support block, in file order.
 *
 * Shared by both structure builders, so they cannot drift apart on input.
 */
export function decodeSupportBlockRecords(
  view: DataView,
  recBase: number,
  geoPtr: number,
  zOff: number,
): RawRecord[] {
  // geoPtr marks the end of the block. One variant stores it relative to the
  // block rather than absolute, which yields a negative span; when it cannot be
  // a valid end marker, count the TAG run instead. Records are contiguous, so
  // walking until the tag stops matching gives the same total.
  let totalRecBytes = geoPtr - recBase;
  if (totalRecBytes <= 0 || recBase + totalRecBytes > view.byteLength) {
    let end = recBase;
    while (end + REC_SIZE <= view.byteLength && u32(view, end) === TAG_EA) {
      end += REC_SIZE;
    }
    totalRecBytes = end - recBase;
  }
  const totalRecs = Math.floor(totalRecBytes / REC_SIZE);

  // Decode every record in the block (world-frame Z), skipping header + summary.
  const recs: RawRecord[] = [];
  for (let i = 0; i < totalRecs; i++) {
    const base = recBase + i * REC_SIZE;
    if (u32(view, base) !== TAG_EA) continue;
    const rec = readRecord(view, base);
    if (rec.sub === SUMMARY_SUB) continue;
    if (rec.sub === MODEL_HDR_SUB) {
      // Sub-2 is usually a model header with no geometry, but it also carries
      // the DOWNWARD contact cone that anchors a support standing on the model:
      // same field layout and radius pair as a sub-1 tip, just inverted, with
      // the narrow contact end below the wide socket. Without it a mid-air
      // branch hangs attached to nothing.
      //
      // Only a record whose endpoints actually describe a cone qualifies; a
      // real header has no such span.
      const spans = Math.abs(rec.topZ - rec.botZ) > 0.05 && rec.paramA > 0 && rec.paramB > 0;
      if (!spans) continue;
      // No re-orientation is needed: the fields already follow the tip
      // convention. (x, y, topZ) is the narrow contact end -- here below the
      // socket, because this cone points DOWN onto the model -- and
      // (x2, y2, botZ) is the wide socket, landing on the knot the branch
      // hangs from.
      rec.sub = TIP_SUB;
    }
    // Shift Z into world frame up front so all continuity math is in one frame.
    rec.topZ += zOff;
    rec.botZ += zOff;
    recs.push(rec);
  }
  return recs;
}

/**
 * Graph-builder entry point, shaped like parseSupportBlock so the two are
 * interchangeable at the call site. Anything the emitter cannot place is warned
 * about rather than silently dropped.
 */
function buildViaGraph(
  view: DataView,
  recBase: number,
  geoPtr: number,
  zOff: number,
  modelIdx: number,
): { supports: CbxSupport[]; braces: CbxBrace[]; twigs: CbxTwig[]; junctionBranches: CbxJunctionBranch[] } {
  const recs = decodeSupportBlockRecords(view, recBase, geoPtr, zOff);
  const graph = buildSupportGraph(recs.map((r, i) => ({ index: i, ...r })));
  const emitted = emitFromGraph(graph, recs);

  console.log(
    `${LOG_PREFIX} instance ${modelIdx} (graph): ${emitted.supports.length} supports, `
    + `${emitted.braces.length} braces, ${emitted.twigs.length} twigs, `
    + `${emitted.junctionBranches.length} junction branch(es).`,
  );
  if (emitted.skipped.length > 0) {
    const byReason = new Map<string, number>();
    for (const s of emitted.skipped) {
      byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
    }
    console.warn(
      `${LOG_PREFIX} instance ${modelIdx} (graph): ${emitted.skipped.length} part(s) unplaced -- `
      + [...byReason.entries()].map(([r, n]) => `${n} ${r}`).join(', '),
    );
  }

  return {
    supports: emitted.supports,
    braces: emitted.braces,
    twigs: emitted.twigs,
    junctionBranches: emitted.junctionBranches,
  };
}

function parseSupportBlock(
  view: DataView,
  bytes: Uint8Array,
  recBase: number,
  geoPtr: number,
  zOff: number,
  modelIdx: number,
): { supports: CbxSupport[]; braces: CbxBrace[]; twigs: CbxTwig[]; junctionBranches: CbxJunctionBranch[] } {
  void bytes; // reserved: support-chain parsing reads via the DataView only.
  const recs = decodeSupportBlockRecords(view, recBase, geoPtr, zOff);

  // A sub-3 record is a BRACE (diagonal strut between two shafts) when its two
  // endpoints differ in XY; otherwise it is a normal vertical pillar. Splitting
  // here keeps the vertical-chain logic below unchanged and routes diagonal
  // struts to their own output.
  const isBrace = (r: RawRecord): boolean =>
    r.sub === PILLAR_SUB && Math.hypot(r.x - r.x2, r.y - r.y2) > BRACE_XY_MIN;

  const braceRecs = recs.filter(isBrace);
  const pillars = recs.filter((r) => r.sub === PILLAR_SUB && !isBrace(r));
  const knots = recs.filter((r) => r.sub === KNOT_SUB);
  const bases = recs.filter((r) => r.sub === BASE_SUB);
  const feet = recs.filter((r) => r.sub === FOOT_SUB);

  // Which pillar (index into `pillars`) an XY lands on, or -1. Pillar XY is the
  // shaft centre; a tolerance catches authored rounding.
  const PILLAR_HIT_TOL_MM = 0.4;
  const pillarIndexAt = (x: number, y: number): number => {
    for (let i = 0; i < pillars.length; i++) {
      if (Math.hypot(x - pillars[i].x, y - pillars[i].y) <= PILLAR_HIT_TOL_MM) return i;
    }
    return -1;
  };

  // Does a point attach to pillar p's SHAFT — i.e. on its XY and at/below its top
  // (within the shaft span), not above the top reaching up to the model?
  const TOP_MARGIN_MM = 0.5;
  const onPillarShaft = (pi: number, z: number): boolean => {
    if (pi < 0) return false;
    const p = pillars[pi];
    const top = Math.max(p.topZ, p.botZ);
    return z <= top + TOP_MARGIN_MM;
  };

  // A sub-1 record is normally a model-contact TIP: one end touches the model, the
  // other attaches to its pillar. But some sub-1 records have BOTH endpoints on the
  // SHAFTS of two DIFFERENT pillars — they never reach the model; they are tapered
  // pillar-to-pillar struts. By the support taxonomy those are BRACES
  // ("support-to-support, never touches the model"), not tips. Treated as tips they
  // force a model-contact cone that shoots through the pillar toward the model.
  //
  // The Z test is essential: a tip whose contact end shares a pillar's XY but sits
  // ABOVE that pillar's top is passing the pillar to reach the model — a genuine
  // tip, not a link. Only when BOTH ends land on the pillar shaft (at/below the
  // top) is it a true pillar-to-pillar brace.
  const tipIsPillarLink = (r: RawRecord): boolean => {
    const pi1 = pillarIndexAt(r.x, r.y);
    const pi2 = pillarIndexAt(r.x2, r.y2);
    if (pi1 === -1 || pi2 === -1 || pi1 === pi2) return false;
    return onPillarShaft(pi1, r.topZ) && onPillarShaft(pi2, r.botZ);
  };

  // A DOWNWARD cone (contact below its socket) anchors a support that stands on
  // the model rather than the plate. Its socket sits on a knot, so the chain
  // builder below would otherwise claim it as an ordinary upward tip and bend
  // the support toward it. Hold it back here; it is picked up separately as the
  // support's downwardTip and drives the Stick path.
  const isDownwardCone = (r: RawRecord) => r.topZ < r.botZ;

  const allTipRecs = recs.filter((r) => r.sub === TIP_SUB && !isDownwardCone(r));
  const tips = allTipRecs.filter((r) => !tipIsPillarLink(r));
  const tipBraceRecs = allTipRecs.filter(tipIsPillarLink);

  const braces: CbxBrace[] = [
    // sub-3 braces: paramA is the shaft radius (paramA ≈ paramB).
    ...braceRecs.map((r) => ({
      ax: r.x, ay: r.y, az: r.topZ,
      bx: r.x2, by: r.y2, bz: r.botZ,
      diameter: r.paramA * 2,
    })),
    // sub-1 pillar-link braces: paramA is the POINTED contact end (~0.16) and
    // paramB the body (~0.50). Use the body radius so the strut has the right
    // thickness rather than rendering as a thin spike.
    ...tipBraceRecs.map((r) => ({
      ax: r.x, ay: r.y, az: r.topZ,
      bx: r.x2, by: r.y2, bz: r.botZ,
      diameter: Math.max(r.paramA, r.paramB) * 2,
    })),
  ];

  // Twigs (sub-12): tiny model-to-model struts. Both endpoints are contact points
  // on the model surface; paramA == paramB is the uniform body/contact radius.
  const twigs: CbxTwig[] = recs
    .filter((r) => r.sub === TWIG_SUB)
    .map((r) => ({
      ax: r.x, ay: r.y, az: r.topZ,
      bx: r.x2, by: r.y2, bz: r.botZ,
      diameter: Math.max(r.paramA, r.paramB) * 2,
    }));

  const near = (a: number, b: number, t = 0.05) => Math.abs(a - b) < t;
  const xyNear = (r1: RawRecord, r2: RawRecord, t = 0.06) =>
    Math.abs(r1.x - r2.x) < t && Math.abs(r1.y - r2.y) < t;

  // One in-progress support per pillar.
  interface Chain {
    pillar: RawRecord;
    knot: RawRecord | null;
    base: RawRecord | null;
    knotCenter: number;
    tips: RawRecord[];
  }

  const chains: Chain[] = pillars.map((p) => {
    const knot =
      knots.find((k) => xyNear(k, p) && near((k.topZ + k.botZ) / 2, p.topZ)) ??
      knots.find((k) => near((k.topZ + k.botZ) / 2, p.topZ, 0.03)) ??
      null;
    const base = bases.find((b) => xyNear(b, p) && near(b.topZ, p.botZ)) ?? null;
    const knotCenter = knot ? (knot.topZ + knot.botZ) / 2 : p.topZ;
    return { pillar: p, knot, base, knotCenter, tips: [] };
  });

  // Assign each tip to the chain whose knot center matches its botZ; tiebreak by
  // XY distance from the pillar (handles branched tips + stacked supports).
  //
  // The Z gate alone is NOT sufficient: on a large model many pillars share a
  // knot height, so a tip can bind to a chain anywhere on the plate purely
  // because the Z lined up, rendering as a giant leaf across the model.
  //
  // A tip's SOCKET sits on its own pillar, so cap the match on XY distance --
  // far enough out that genuine branched or offset tips still bind while a
  // cross-model match cannot. Score on the SOCKET, not the contact: the contact end
  // legitimately reaches out to the model, the socket is the end that must sit on
  // the shaft.
  const TIP_CHAIN_MAX_XY_MM = 8;
  const unassignedTips: RawRecord[] = [];
  for (const t of tips) {
    let best: Chain | null = null;
    let bestScore = Infinity;
    for (const c of chains) {
      const dz = Math.abs(c.knotCenter - t.botZ);
      if (dz > 0.1) continue;
      // Socket-to-pillar distance is the real attachment test.
      const dxySocket = Math.hypot(t.x2 - c.pillar.x, t.y2 - c.pillar.y);
      if (dxySocket > TIP_CHAIN_MAX_XY_MM) continue;
      const score = dz * 10 + dxySocket; // Z continuity dominant, XY tiebreak
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best) best.tips.push(t);
    else unassignedTips.push(t);
  }

  // --- Brace-fed junction branches (multi-level support trees). ---
  // A tip whose socket lands on no pillar-chain knot belongs to a high JUNCTION
  // knot that has no pillar of its own — it is reached by a single diagonal brace
  // from a grounded pillar's knot, with the tips fanning out to the model. Group
  // such tips by their junction knot and rebuild each junction as a DragonFruit
  // branch (parented to the brace's origin knot). Without this the whole upper tier
  // of a complex tree (junction knots + all their tips) is silently dropped.
  const junctionBranches: CbxJunctionBranch[] = [];
  // Indices of braces consumed as junction feeders — removed from the brace list
  // before return so they aren't ALSO built as standalone braces (one physical
  // strut → one primitive; building both leaves a disconnected brace gap).
  const consumedFeederBraceIdx = new Set<number>();
  if (unassignedTips.length > 0) {
    const JUNCTION_XY_TOL = 0.4;
    const JUNCTION_Z_TOL = 0.6;
    // Knots with NO pillar beneath them (candidates for junctions).
    const knotHasPillar = (k: RawRecord): boolean => {
      const center = (k.topZ + k.botZ) / 2;
      return pillars.some(
        (p) => Math.hypot(p.x - k.x, p.y - k.y) <= JUNCTION_XY_TOL
          && Math.abs(Math.max(p.topZ, p.botZ) - center) <= 0.8,
      );
    };
    const pillarlessKnots = knots.filter((k) => !knotHasPillar(k));

    // Which junction knot a tip socket lands on (or null).
    const junctionKnotForTip = (t: RawRecord): RawRecord | null => {
      for (const k of pillarlessKnots) {
        const center = (k.topZ + k.botZ) / 2;
        if (
          Math.hypot(t.x2 - k.x, t.y2 - k.y) <= JUNCTION_XY_TOL
          && Math.abs(t.botZ - center) <= JUNCTION_Z_TOL
        ) return k;
      }
      return null;
    };

    // All feeding braces (sub-3 + pillar-link) as endpoint pairs, for parent lookup.
    const braceEnds = braces.map((br) => ({
      a: { x: br.ax, y: br.ay, z: br.az },
      b: { x: br.bx, y: br.by, z: br.bz },
      diameter: br.diameter,
    }));
    // The pillared knot nearest a point (the brace's origin → branch parent).
    const pillaredKnotAt = (x: number, y: number, z: number): RawRecord | null => {
      let best: RawRecord | null = null;
      let bestD = Infinity;
      for (const k of knots) {
        if (!knotHasPillar(k)) continue;
        const center = (k.topZ + k.botZ) / 2;
        const d = Math.hypot(k.x - x, k.y - y, center - z);
        if (d < bestD && d <= 1.0) { bestD = d; best = k; }
      }
      return best;
    };

    // Group unassigned tips by their junction knot.
    const byJunction = new Map<RawRecord, RawRecord[]>();
    for (const t of unassignedTips) {
      const jk = junctionKnotForTip(t);
      if (!jk) continue; // genuinely orphaned (not a junction) — leave out
      const list = byJunction.get(jk) ?? [];
      list.push(t);
      byJunction.set(jk, list);
    }

    for (const [jk, jkTips] of byJunction) {
      const center = (jk.topZ + jk.botZ) / 2;
      // Find the brace feeding this junction: one endpoint at the junction; the
      // OTHER end is the parent attachment.
      let parent: { x: number; y: number; z: number } | null = null;
      let shaftDiameter = 0;
      let feederBraceIdx = -1;
      for (let bi = 0; bi < braceEnds.length; bi++) {
        const be = braceEnds[bi];
        for (const [end, other] of [[be.a, be.b], [be.b, be.a]] as const) {
          if (
            Math.hypot(end.x - jk.x, end.y - jk.y) <= JUNCTION_XY_TOL
            && Math.abs(end.z - center) <= JUNCTION_Z_TOL
          ) {
            // Prefer the pillared knot at the brace's far end; fall back to the
            // raw brace endpoint if none resolves (still a valid attach point).
            const pk = pillaredKnotAt(other.x, other.y, other.z);
            parent = pk ? { x: pk.x, y: pk.y, z: (pk.topZ + pk.botZ) / 2 } : { ...other };
            shaftDiameter = be.diameter;
            feederBraceIdx = bi;
            break;
          }
        }
        if (parent) break;
      }
      if (!parent) continue; // no feeding brace found — can't attach a branch
      if (feederBraceIdx >= 0) consumedFeederBraceIdx.add(feederBraceIdx);

      junctionBranches.push({
        junctionX: jk.x,
        junctionY: jk.y,
        junctionZ: center,
        parentX: parent.x,
        parentY: parent.y,
        parentZ: parent.z,
        diameter: shaftDiameter > 0 ? shaftDiameter : jk.paramA * 2,
        tips: jkTips.map((t) => ({
          x: t.x,
          y: t.y,
          contactZ: t.topZ,
          attachZ: t.botZ,
          socketX: t.x2,
          socketY: t.y2,
          length: Math.sqrt(
            (t.x - t.x2) ** 2 + (t.y - t.y2) ** 2 + (t.topZ - t.botZ) ** 2,
          ),
          contactDiameter: t.paramA * 2,
          bodyDiameter: t.paramB * 2,
          contactDepth: t.extra,
        })),
      });
    }
  }

  // Ground supports to their sub-5 foot (option c). Each support sits on a wide
  // flat sub-5 disk whose bottom is exactly the plate; sometimes several feet
  // cluster into what looks like a raised "platform". We do NOT render the feet
  // (or the platform they form) — instead we ground each support to its own foot
  // bottom: lower the base pad to the foot bottom (the plate) and extend the
  // pillar down to meet it, leaving the knot/tips/pillar-top untouched so model
  // contact is unchanged. sub-5 is the authoritative ground anchor, so a support raised onto a platform
  // is grounded by however much its foot is tall — no magic threshold, and bare
  // mid-air pillars (no foot beneath them) are correctly left alone.
  const FOOT_MATCH_TOL_MM = 1.0; // a support owns the foot within this XY radius
  const footBottomFor = (px: number, py: number): number | null => {
    let best: number | null = null;
    let bestD = Infinity;
    for (const f of feet) {
      const d = Math.hypot(f.x - px, f.y - py);
      if (d < bestD && d <= FOOT_MATCH_TOL_MM) {
        bestD = d;
        best = Math.min(f.topZ, f.botZ);
      }
    }
    return best;
  };

  // Pillar XYs that a brace endpoint lands on. A tipless pillar referenced by a
  // brace is part of the support lattice (a grounded pillar hosting braces/links),
  // not a throwaway interior strut, so it must be kept and emitted as a contactless
  // trunk for those braces to attach to.
  const bracedPillarXY: Array<{ x: number; y: number }> = [];
  for (const br of braces) {
    bracedPillarXY.push({ x: br.ax, y: br.ay }, { x: br.bx, y: br.by });
  }
  const isBracedPillar = (px: number, py: number): boolean =>
    bracedPillarXY.some((p) => Math.hypot(p.x - px, p.y - py) <= 0.4);

  // Plate Z (world): the lowest pillar/base bottom in the cluster. Anything sitting
  // well above it is mid-air. Both pillar.botZ and base.botZ are world frame here.
  const plateZ = chains.reduce((lo, c) => {
    const bottom = c.base ? Math.min(c.base.botZ, c.pillar.botZ) : c.pillar.botZ;
    return Math.min(lo, bottom);
  }, Infinity);

  // How many brace ENDPOINTS land at a given XY and Z (the convergence test). A
  // brace stores world endpoints (az/bz); a fork junction is where ≥2 of them meet
  // the base of an otherwise-ungrounded pillar.
  const MID_AIR_MM = 1.5; // base must be this far above the plate to count as mid-air
  const CONV_XY_MM = 0.4;
  const CONV_Z_MM = 0.6;
  const convergingBraceCount = (px: number, py: number, pz: number): number => {
    let n = 0;
    for (const br of braces) {
      if (Math.hypot(br.ax - px, br.ay - py) <= CONV_XY_MM && Math.abs(br.az - pz) <= CONV_Z_MM) n++;
      if (Math.hypot(br.bx - px, br.by - py) <= CONV_XY_MM && Math.abs(br.bz - pz) <= CONV_Z_MM) n++;
    }
    return n;
  };

  // A fork junction: a pillar whose base is mid-air, has NO base pad / foot of its
  // own, and has ≥2 braces converging at that base. Such pillars are branches
  // growing out of the convergence, not grounded trunks. (Per the support model,
  // no base "cup" should ever float off the plate — if it's airborne and fed by
  // braces, it's a branch.)
  const isForkJunction = (c: Chain): boolean => {
    const baseZ = c.base ? c.base.botZ : c.pillar.botZ;
    if (baseZ - plateZ <= MID_AIR_MM) return false; // grounded, not mid-air
    if (c.base) return false; // has its own base pad → genuinely grounded support
    if (footBottomFor(c.pillar.x, c.pillar.y) !== null) return false; // sits on a foot
    // Airborne with no pad and no foot: a branch, not a trunk. Converging braces
    // are the usual reason (a fork junction), but a pillar can also stand
    // directly on the model surface with nothing feeding it. Either way a
    // grounded trunk would plant a root cup in mid-air.
    return true;
  };

  // Materialize into CbxSupport records.
  const supports: CbxSupport[] = [];
  let tiplessPillars = 0;
  let contactlessPillars = 0;
  let groundedToFoot = 0;
  let forkJunctions = 0;

  for (const c of chains) {
    if (c.tips.length === 0 && !isBracedPillar(c.pillar.x, c.pillar.y)) {
      // A tipless pillar with no brace attached is an interior lattice strut that
      // neither touches the model nor anchors a brace. Skip it (counted, summarised
      // once per instance below).
      tiplessPillars++;
      continue;
    }
    if (c.tips.length === 0) {
      // Tipless but brace-referenced: a grounded pillar that hosts braces/links.
      // Keep it; buildSupport emits a contactless trunk (no contact cone).
      contactlessPillars++;
    } else {
      // Sort tips tallest-first for deterministic primary-tip selection.
      c.tips.sort((a, b) => b.topZ - a.topZ);
    }

    // Fork junction: a mid-air, braced, base-pad-less pillar is a branch growing
    // out of the convergence rather than a grounded trunk (avoids a floating cup).
    const fork = isForkJunction(c);
    if (fork) forkJunctions++;

    // Ground to the support's sub-5 foot bottom, if it has one sitting below it.
    // Lower the base pad (preserving its cone height) to the foot bottom and
    // extend the pillar down to the lowered base top. Only act when the foot is
    // actually below the current support bottom (i.e. there is a gap to close).
    let baseTopZ = c.base ? c.base.topZ : null;
    let baseBottomZ = c.base ? c.base.botZ : null;
    let pillarBottomZ = c.pillar.botZ;
    const footBottom = footBottomFor(c.pillar.x, c.pillar.y);
    if (footBottom !== null) {
      const currentBottom = c.base ? c.base.botZ : c.pillar.botZ;
      if (currentBottom - footBottom > 0.05) {
        if (c.base && baseBottomZ !== null && baseTopZ !== null) {
          const coneHeight = baseTopZ - baseBottomZ;
          baseBottomZ = footBottom;
          baseTopZ = footBottom + coneHeight;
          pillarBottomZ = baseTopZ;
        } else {
          // No base pad: extend the pillar straight down to the foot bottom.
          pillarBottomZ = footBottom;
        }
        groundedToFoot++;
      }
    }

    const support: CbxSupport = {
      // Pillar / shaft.
      pillarDiameter: c.pillar.paramA * 2, // authored shaft diameter (e.g. 1.30)
      pillarTopZ: c.pillar.topZ,
      pillarBottomZ,
      pillarX: c.pillar.x,
      pillarY: c.pillar.y,
      // Knot (spherical joint atop the pillar).
      knotCenterZ: c.knotCenter,
      knotDiameter: c.knot ? c.knot.topZ - c.knot.botZ : c.pillar.paramA * 2,
      // Base pad (optional wide root), grounded to the sub-5 foot bottom.
      base: c.base
        ? {
            topRadius: c.base.paramA,
            bottomRadius: c.base.paramB,
            topZ: baseTopZ as number,
            bottomZ: baseBottomZ as number,
          }
        : null,
      // Tips (one or more contact branches).
      tips: c.tips.map((t) => {
        // The authored cone length is the full 3D distance from the tip's pillar
        // attach point (P2) to its model contact point (P1) — NOT the Z difference
        // alone. Most tips here are SLANTED (P1 and P2 differ in XY), so the Z gap
        // (contactZ − attachZ) badly understates the true cone length: e.g. a tip
        // rising 1.2mm over 3.29mm of XY is 3.50mm long, not 1.20mm. Passing the
        // Z-only value made createContactAssembly treat the slant as mostly shaft
        // with a stubby 1.2mm cone, so the contact rendered at the wrong angle and
        // the cone ended partway instead of spanning pillar→model like Chitubox.
        const dx = t.x - t.x2;
        const dy = t.y - t.y2;
        const dz = t.topZ - t.botZ;
        const slantLength = Math.sqrt(dx * dx + dy * dy + dz * dz);
        return {
          x: t.x,
          y: t.y,
          contactZ: t.topZ,
          attachZ: t.botZ, // where the tip meets the knot
          socketX: t.x2, // authored socket XY → true approach direction (P1→P2)
          socketY: t.y2,
          length: slantLength, // authored cone length (true 3D slant distance)
          contactDiameter: t.paramA * 2, // small end on the model
          bodyDiameter: t.paramB * 2, // larger socket end
          contactDepth: t.extra, // penetration into the model
        };
      }),
      isForkJunction: fork,
      // A contact hanging DOWN from the pillar bottom means this support spans
      // between two parts of the model rather than standing on the plate. Its
      // Its socket sits on the bottom knot rather than the top.
      downwardTip: (() => {
        // Exactly one downward tip per stick-shaped support across every test
        // file (verified by trace); find() is sufficient.
        const down = recs.find((r) =>
          (r.sub === TIP_SUB)
          && Math.abs(r.botZ - c.pillar.botZ) <= 0.15
          && Math.hypot(r.x2 - c.pillar.x, r.y2 - c.pillar.y) <= 0.5
          && r.topZ < r.botZ);
        if (!down) return undefined;
        const dx = down.x - down.x2;
        const dy = down.y - down.y2;
        const dz = down.topZ - down.botZ;
        return {
          x: down.x,
          y: down.y,
          contactZ: down.topZ,
          attachZ: down.botZ,
          socketX: down.x2,
          socketY: down.y2,
          length: Math.sqrt(dx * dx + dy * dy + dz * dz),
          contactDiameter: down.paramA * 2,
          bodyDiameter: down.paramB * 2,
          contactDepth: down.extra,
        };
      })(),
    };

    supports.push(support);
  }

  if (tiplessPillars > 0 || braces.length > 0 || groundedToFoot > 0 || contactlessPillars > 0 || forkJunctions > 0) {
    // One concise line. Tipless pillars are interior lattice struts (skipped);
    // contactless pillars are grounded brace-hosts kept without a contact cone;
    // fork junctions are mid-air branch pillars re-parented to a convergence knot;
    // braces are shaft-to-shaft struts; grounded are supports lowered onto their
    // sub-5 foot bottom (the foot/platform geometry itself is not reproduced).
    console.debug(
      `${LOG_PREFIX} instance ${modelIdx}: ${supports.length} editable supports, `
      + `${braces.length} braces, ${tiplessPillars} interior strut pillar(s) skipped, `
      + `${contactlessPillars} contactless brace-host pillar(s), `
      + `${forkJunctions} fork-junction branch(es), `
      + `${groundedToFoot} support(s) grounded to sub-5 foot.`,
    );
  }

  const filteredBraces = braces.filter((_, idx) => !consumedFeederBraceIdx.has(idx));
  return { supports, braces: filteredBraces, twigs, junctionBranches };
}

/**
 * Scan for the record table and return the earliest geometry offset it declares,
 * or null if no plausible table is found. Used for files without a usable
 * meshOffset, where this is the only way to find where geometry begins.
 */
function earliestGeometryStart(
  view: DataView,
  len: number,
  nInstances: number,
  tablePtr = 0,
): number | null {
  const TAIL_OFF = 256;
  const STRIDE_OFF = 680;

  const recValid = (recBase: number): boolean => {
    const tail = recBase + TAIL_OFF;
    if (recBase < 0 || tail + 28 > len) return false;
    const gs = u32(view, tail + 16);
    const bc = u32(view, tail + 20);
    return (
      gs > 0 && gs < len && bc > 0 && gs + bc <= len
      && bc % 36 === 0 && bc / 36 >= MIN_PROBE_TRIS
    );
  };

  // The scan below only reaches ABS_PROBE_LIMIT; a table beyond that is found
  // only via the header pointer.
  const candidates: number[] = [];
  if (tablePtr > 0 && tablePtr < len) candidates.push(tablePtr);
  for (let base = 0; base < Math.min(ABS_PROBE_LIMIT, len); base += 4) candidates.push(base);

  for (const base of candidates) {
    if (!recValid(base)) continue;
    if (nInstances >= 2 && !recValid(base + STRIDE_OFF)) continue;
    let earliest = len;
    for (let k = 0; k < nInstances; k++) {
      const tail = base + k * STRIDE_OFF + TAIL_OFF;
      if (tail + 28 > len) break;
      const gs = u32(view, tail + 16);
      const bc = u32(view, tail + 20);
      if (gs > 0 && gs < len && bc > 0 && gs + bc <= len && gs < earliest) {
        earliest = gs;
      }
    }
    return earliest < len ? earliest : null;
  }
  return null;
}

/**
 * Read a flat 36-byte-triangle geometry region into a non-indexed position
 * array (THREE expects 3 verts × 3 floats per triangle). Applies the Z offset
 * and drops any triangle with a vertex outside ±COORD_LIMIT.
 */
function readGeometryToPositions(
  view: DataView,
  start: number,
  byteCount: number,
  bufferLength: number,
  zOff: number,
): Float32Array {
  const triCount = Math.floor(byteCount / 36);
  const positions: number[] = [];

  for (let t = 0; t < triCount; t++) {
    const base = start + t * 36;
    if (base + 36 > bufferLength) break;
    const v: number[][] = [];
    let ok = true;
    for (let i = 0; i < 3; i++) {
      const x = f32(view, base + i * 12);
      const y = f32(view, base + i * 12 + 4);
      const z = f32(view, base + i * 12 + 8) + zOff;
      if (
        Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z) ||
        x <= -COORD_LIMIT || x >= COORD_LIMIT ||
        y <= -COORD_LIMIT || y >= COORD_LIMIT ||
        z <= -COORD_LIMIT || z >= COORD_LIMIT
      ) {
        ok = false;
        break;
      }
      v.push([x, y, z]);
    }
    if (!ok) continue;
    positions.push(v[0][0], v[0][1], v[0][2], v[1][0], v[1][1], v[1][2], v[2][0], v[2][1], v[2][2]);
  }

  return new Float32Array(positions);
}



export interface ParsedCbxContainer {
  filename: string;
  instanceCount: number;
  modelCount: number;
  geoModelCount: number;
  zOffset: number;
  models: CbxModelInput[];
}

export class CbxParser {
  /**
   * Parse a `.chitubox` File (browser) into per-model geometry + support records.
   */
  static async parse(file: File): Promise<ParsedCbxContainer> {
    const buffer = await file.arrayBuffer();
    return CbxParser.parseBuffer(buffer, file.name);
  }

  /** Core parse over an ArrayBuffer (also used by tests with synthetic buffers). */
  static parseBuffer(buffer: ArrayBuffer, sourceName: string): ParsedCbxContainer {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const len = bytes.length;

    if (len < 8 || u32(view, 0) !== MAGIC) {
      throw new Error(
        `Not a .chitubox file (magic 0x${len >= 4 ? u32(view, 0).toString(16) : '????'}).`,
      );
    }

    const nInstances = u32(view, 4); // field4 = total instance count
    const fnamePtr = u32(view, 8);
    // field8 doubles as the record-table pointer: it addresses the first
    // record, whose leading member is that same filename string.
    const tablePtr = fnamePtr;

    // field12 is a base offset: a small pointer block follows it, carrying the
    // record-table delta at +8 and the mesh-section offset at +12. The record
    // table is then meshOffset + delta, which reproduces field8 exactly.
    //
    // Reading these at a hardcoded 420/424 assumes base == 412, which holds for
    // the common writer but not for a later one that moved the block to 420, nor
    // for a file with no mesh section at all (base 0, mesh 0, delta 412 -- the
    // table sits immediately after the fixed header). The rule below needs no
    // special case for any of them: verified against 161/161 files.
    const ptrBlock = u32(view, 12);
    const ptrBlockUsable = ptrBlock + 16 <= len;
    const meshOffset = ptrBlockUsable ? u32(view, ptrBlock + 12) : u32(view, 424);
    const tableDelta = ptrBlockUsable ? u32(view, ptrBlock + 8) : 444;

    const filename = decodeCString(bytes, fnamePtr, 64) || sourceName;

    // Some files have no meshOffset indirection: 0x424 falls inside the first
    // record's filename, so it decodes as text-as-u32 and points past EOF.
    // Reading through it unguarded throws a DataView range error. When it is
    // out of range, ignore it — the probe below finds the real record table,
    // and geometry is always read from the per-record pointers.
    const meshOffsetUsable = meshOffset > 0 && meshOffset + 724 <= len;
    if (!meshOffsetUsable) {
      console.warn(
        `${LOG_PREFIX} meshOffset (${meshOffset}) is out of range for a `
        + `${len}-byte file; falling back to a full-file scan for supports.`,
      );
    }

    // Primary model tri count, used only by the degenerate fallback header
    // below. A meshOffset that passes the range check can still be a non-header
    // field, reading as a nonsense count, so implausible values are discarded.
    const rawModelBytes0 = meshOffsetUsable ? u32(view, meshOffset + 720) : 0;
    const modelBytes0 = rawModelBytes0 > 0 && rawModelBytes0 <= len && rawModelBytes0 % 36 === 0
      ? rawModelBytes0
      : 0;


    // ---- Per-instance record table (authored ground truth) ----------------
    //
    // Records are 680 bytes, stride 680, one per instance (`nInstances`), the
    // first starting at `meshOffset + 444`. Each record is a 256-byte NUL-padded
    // filename followed by a 28-byte tail (7 little-endian u32/f32 fields), the
    // tail beginning at record+256:
    //
    //   record+0    cstr  filename (256 bytes, NUL-padded; a ';' separator byte
    //                     precedes the first record's name)
    //   tail+0  f32  plate X
    //   tail+4  f32  plate Y
    //   tail+8  f32  Z-lift (5.0 supported / 0.0 flat-on-plate)
    //   tail+12 u32  support pointer (0xFFFFFFFF = no Chitubox supports). The
    //                parametric record block starts at (supPtr + INLINE_PAD).
    //   tail+16 u32  geometry START offset
    //   tail+20 u32  geometry byte count (tris = bytes/36); geoEnd = start+count
    //   tail+24      record terminator (last two bytes always 0x4E 0xFF)
    //
    // Absolute field positions for record k:
    //   filename @ meshOffset + 444 + k*680
    //   tail     @ meshOffset + 700 + k*680   (= filename + 256)
    //


    const TAIL = 256; // tail offset within a record
    const STRIDE = 680;
    const NO_SUPPORT = 0xffffffff;

    // Most files put the record table at `meshOffset + 444`, but two other
    // layouts exist: a small shift from that offset (seen at -16), and no
    // meshOffset indirection at all, with the table near the top of the file.
    //
    // Probe rather than special-case. A base is accepted only when record 0
    // has a plausible geometry span and, when the file declares more than one
    // instance, the next record does too at STRIDE spacing.
    const recordLooksValid = (recBase: number): boolean => {
      const tail = recBase + TAIL;
      if (recBase < 0 || tail + 28 > len) return false;
      const geoStart = u32(view, tail + 16);
      const byteCount = u32(view, tail + 20);
      return (
        geoStart > 0
        && geoStart < len
        && byteCount > 0
        && geoStart + byteCount <= len
        && byteCount % 36 === 0
        && byteCount / 36 >= MIN_PROBE_TRIS
      );
    };

    const baseLooksValid = (recBase: number): boolean => {
      if (!recordLooksValid(recBase)) return false;
      // Only corroborate with a second record when one is actually declared.
      if (nInstances >= 2 && !recordLooksValid(recBase + STRIDE)) return false;
      return true;
    };

    const findRecordBase = (): number => {
      const expected = meshOffset + tableDelta;
      // Checked first, so a valid file can never match elsewhere by chance.
      if (meshOffset > 0 && meshOffset < len && baseLooksValid(expected)) {
        return expected;
      }
      // Header field 8 points straight at the first record in every file that
      // has a table. Most writers keep it in sync with meshOffset+444, but one
      // variant (field12 == 420, carrying explicit table bounds in fields 16/20)
      // puts the table megabytes away from meshOffset, out of reach of both the
      // nearby-shift and absolute scans below.
      if (tablePtr > 0 && tablePtr < len && baseLooksValid(tablePtr)) {
        if (tablePtr !== expected) {
          console.warn(
            `${LOG_PREFIX} record table taken from header field 8 (${tablePtr}); `
            + `meshOffset+${tableDelta} would have given ${expected}.`,
          );
        }
        return tablePtr;
      }
      // Nearby shifts, smallest displacement first.
      if (meshOffset > 0 && meshOffset < len) {
        for (let d = 1; d <= PROBE_DELTA_MAX; d++) {
          for (const cand of [expected - d, expected + d]) {
            if (baseLooksValid(cand)) {
              console.warn(
                `${LOG_PREFIX} record table found at meshOffset+${cand - meshOffset} `
                + `(expected +444).`,
              );
              return cand;
            }
          }
        }
      }
      // No usable meshOffset: scan the head of the file on a 4-byte grid.
      for (let cand = 0; cand < Math.min(ABS_PROBE_LIMIT, len); cand += 4) {
        if (baseLooksValid(cand)) {
          console.warn(
            `${LOG_PREFIX} meshOffset (${meshOffset}) unusable; record table `
            + `located at absolute offset ${cand}.`,
          );
          return cand;
        }
      }
      // Nothing matched: keep the usual base so the per-record guards below
      // report the failure as they always have.
      console.warn(
        `${LOG_PREFIX} could not locate a valid record table (meshOffset=${meshOffset}); `
        + `falling back to meshOffset+${tableDelta}.`,
      );
      return expected;
    };

    const REC_BASE = findRecordBase(); // first record (filename) start

    // Z offset: the raft sits at the most-negative authored Z, and the scene is
    // lifted by that much so the plate lands at zero.
    //
    // Read topZ/botZ out of the parametric records rather than sweeping raw
    // floats: a sweep cannot tell a plate coordinate from a Z, and support
    // blocks do not reliably precede geometry.
    let minZ = 0.0;
    let sawSupportRecord = false;
    for (let k = 0; k < nInstances; k++) {
      const tail = REC_BASE + k * STRIDE + TAIL;
      if (tail + 28 > len) break;
      const supPtr = u32(view, tail + 12);
      if (supPtr === NO_SUPPORT || supPtr === 0) continue;
      const blockBase = resolveSupportBlock(view, len, supPtr);
      if (blockBase === null) continue;
      let rb = blockBase;
      for (; rb + REC_SIZE <= len && u32(view, rb) === TAG_EA; rb += REC_SIZE) {
        const sub = u32(view, rb + 4);
        if (sub === SUMMARY_SUB) continue; // sentinel Z values, not geometry
        sawSupportRecord = true;
        const topZ = f32(view, rb + 16);
        const botZ = f32(view, rb + 28);
        for (const z of [topZ, botZ]) {
          if (!Number.isNaN(z) && z > -500.0 && z < minZ) minZ = z;
        }
      }

      // The records describe pillars and pads, but the raft they stand on is
      // only present as baked triangles, so the lowest authored record sits one
      // pad-thickness above the plate. Chitubox writes that mesh between the
      // records and the geometry (or after the geometry in the later layout);
      // scan whichever side is present for the true floor.
      const geoStart = u32(view, tail + 16);
      const geoEnd = geoStart + u32(view, tail + 20);
      const bakedStart = rb;
      const bakedEnd = geoStart > bakedStart ? geoStart : geoEnd;
      if (bakedEnd > bakedStart && bakedEnd <= len) {
        for (let i = bakedStart + 8; i + 4 <= bakedEnd; i += 12) {
          const z = f32(view, i);
          if (!Number.isNaN(z) && z > -500.0 && z < minZ) minZ = z;
        }
      }
    }
    const hasSupports = sawSupportRecord;
    const zOff = -minZ;



    interface InstanceHeader {
      index: number;
      bytes: number;
      geoStart: number;
      geoEnd: number;
      supPtr: number; // tail+12 (NO_SUPPORT if none); record block = supPtr + INLINE_PAD
      plateX: number;
      plateY: number;
      liftZ: number;
      name: string;
    }

    const headers: InstanceHeader[] = [];
    for (let k = 0; k < nInstances; k++) {
      const rec = REC_BASE + k * STRIDE;
      const tail = rec + TAIL;
      if (tail + 28 > len) {
        console.warn(`${LOG_PREFIX} instance ${k}: record tail truncated; stopping.`);
        break;
      }
      const plateX = f32(view, tail + 0);
      const plateY = f32(view, tail + 4);
      const liftZ = f32(view, tail + 8);
      const supPtr = u32(view, tail + 12);
      const geoStart = u32(view, tail + 16);
      const byteCount = u32(view, tail + 20);
      const name = decodeCString(bytes, rec, 256);

      const geoEnd = geoStart + byteCount;
      // Defensive clamp: a well-formed record has a valid geometry span. If the
      // pointers are implausible, fall back to the trailing-bytes formula so we
      // still surface some geometry rather than nothing.
      if (geoStart <= 0 || geoStart >= len || geoEnd > len || byteCount <= 0) {
        console.warn(
          `${LOG_PREFIX} instance ${k}: implausible geometry pointers `
          + `(start=${geoStart}, bytes=${byteCount}); using trailing-bytes fallback.`,
        );
        const safeBytes = byteCount > 0 && byteCount <= len ? byteCount : 0;
        headers.push({
          index: k, bytes: safeBytes, geoStart: len - safeBytes, geoEnd: len,
          supPtr: NO_SUPPORT, plateX: 0, plateY: 0, liftZ: 0, name,
        });
        continue;
      }

      headers.push({
        index: k, bytes: byteCount, geoStart, geoEnd,
        supPtr, plateX, plateY, liftZ, name,
      });
    }

    if (headers.length === 0) {
      // Degenerate fallback: synthesize a single trailing-geometry instance.
      headers.push({
        index: 0, bytes: modelBytes0,
        geoStart: len - modelBytes0, geoEnd: len,
        supPtr: NO_SUPPORT, plateX: 0, plateY: 0, liftZ: 0, name: '',
      });
    }

    const nModels = headers.length;
    // Distinct geometry count (by byte size) — for reporting.
    const nGeoModels = new Set(headers.map((h) => h.bytes)).size;

    // ---- Build models: geometry + supports, both from authored pointers ----
    //
    // Support ownership is DIRECT: each record's `supPtr` (tail+12) points at that
    // instance's own parametric block (record start = supPtr + INLINE_PAD), or is
    // 0xFFFFFFFF for an unsupported model (e.g. a reoriented duplicate copy, which
    // carries only modelled-in supports). Geometry is a single clean span
    // [geoStart, geoEnd); the support block sits outside it. No file-order /
    // byte-count inference and no embedded-block handling are needed.

    const models: CbxModelInput[] = [];
    for (const h of headers) {
      // Geometry: one straight read of the authored span.
      const positions = readGeometryToPositions(view, h.geoStart, h.bytes, len, zOff);
      const geometry = positionsToGeometry(positions);

      // Supports + braces: this instance's own block via the authored pointer.
      let supports: CbxSupport[] = [];
      let braces: CbxBrace[] = [];
      let twigs: CbxTwig[] = [];
      let junctionBranches: CbxJunctionBranch[] = [];
      if (h.supPtr !== NO_SUPPORT && h.supPtr !== 0) {
        const recBase = resolveSupportBlock(view, len, h.supPtr);
        if (recBase !== null) {
          const geoPtr = u32(view, recBase + 40); // block-end marker the chain parser uses
          cbxDebugBlocks.capture?.push({ modelIndex: h.index, recBase, geoPtr, zOff });
          const parsed = USE_GRAPH_BUILDER
            ? buildViaGraph(view, recBase, geoPtr, zOff, h.index)
            : parseSupportBlock(view, bytes, recBase, geoPtr, zOff, h.index);
          supports = parsed.supports;
          braces = parsed.braces;
          twigs = parsed.twigs;
          junctionBranches = parsed.junctionBranches;
        } else {
          console.warn(
            `${LOG_PREFIX} instance ${h.index}: no TAG record within `
            + `${INLINE_PAD_MAX} bytes of support pointer ${h.supPtr}; skipping supports.`,
          );
        }
      }

      models.push({
        index: h.index,
        filename: h.name || `model_${h.index + 1}`,
        geometry,
        supports,
        braces,
        twigs,
        junctionBranches,
        transform: { plateX: h.plateX, plateY: h.plateY, liftZ: h.liftZ },
      });
    }

    const supportedCount = models.filter((m) => m.supports.length > 0).length;
    console.log(`${LOG_PREFIX} parsed`, {
      filename,
      instanceCount: nInstances,
      models: models.length,
      distinctGeometries: nGeoModels,
      supported: supportedCount,
      unsupported: models.length - supportedCount,
      zOffset: zOff,
      supportCounts: models.map((m) => m.supports.length),
    });

    return {
      filename,
      instanceCount: nInstances,
      modelCount: nModels,
      geoModelCount: nGeoModels,
      zOffset: zOff,
      models,
    };
  }
}

/** Decode a NUL-terminated UTF-8 string of at most `max` bytes at `ptr`. */
function decodeCString(bytes: Uint8Array, ptr: number, max: number): string {
  if (ptr <= 0 || ptr >= bytes.length) return '';
  let end = ptr;
  const limit = Math.min(ptr + max, bytes.length);
  while (end < limit && bytes[end] !== 0) end++;
  try {
    return new TextDecoder('utf-8').decode(bytes.subarray(ptr, end));
  } catch {
    return '';
  }
}

/** Build a non-indexed BufferGeometry with computed normals from positions. */
function positionsToGeometry(positions: Float32Array): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.computeVertexNormals();
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return geom;
}
