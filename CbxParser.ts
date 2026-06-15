import * as THREE from 'three';
import type { CbxModelInput, CbxSupport, CbxBrace } from './CbxConverter';

/**
 * Parser for `.chitubox` project files.
 *
 * A faithful TypeScript port of the verified Python extractor (chitubox_extract
 * v15), scoped to what DragonFruit import needs:
 *   - model mesh geometry (per distinct model), and
 *   - parametric support records (tip / pillar / base), which DragonFruit
 *     rebuilds into editable support primitives.
 *
 * Support *mesh* triangles are intentionally NOT extracted: DragonFruit
 * regenerates support geometry from the parametric records so it stays
 * re-editable. The multi-model block→geo mapping is still computed (supports
 * must attach to the correct model), which requires locating each block's
 * support-geometry end as a boundary even though those triangles aren't kept.
 *
 * Format summary (see chitubox_format_report.md for the full spec):
 *   - 4-byte LE magic 0xAB231243 at offset 0.
 *   - field4 (offset 4) = total model instance count (NOT a version).
 *   - Per-instance header blocks of 680 bytes start at mesh_offset + 720.
 *   - Parametric records are 72 bytes, tagged 0xEA342389, grouped 4-per-support,
 *     typed by a sub-index (1/3 tip, 9 pillar, 4/5 base, 2 model-header, 6 summary).
 *   - Model geometry is flat 36-byte float32 triangles (no normals/attributes).
 */

const MAGIC = 0xab231243;
const TAG_EA = 0xea342389;
const REC_SIZE = 72;

// Corrected anatomy sub-index roles (verified against SPOTLIGHT.chitubox layer
// scrub + chain-continuity analysis — see chitubox-plugin-findings.md).
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
const MODEL_HDR_SUB = 2; // skip
const SUMMARY_SUB = 6; // skip (was previously NOT skipped — bug)

const INLINE_PAD = 436;
const COORD_LIMIT = 500; // reject vertices outside ±500mm (matches Python guard)
// A sub-3 record whose two endpoints differ in XY by more than this is a brace
// (diagonal shaft-to-shaft strut) rather than a vertical pillar. Vertical pillars
// have identical endpoints (delta ~0); the smallest real braces span >1.5mm, so
// 0.8mm cleanly separates the two without catching sensor noise.
const BRACE_XY_MIN = 0.8;

const LOG_PREFIX = '[CbxParser]';

/** Little-endian readers over a DataView (mirror struct.unpack_from('<I'/'<f')). */
function u32(view: DataView, off: number): number {
  return view.getUint32(off, true);
}
function f32(view: DataView, off: number): number {
  return view.getFloat32(off, true);
}

/** One decoded 72-byte parametric record. */
interface RawRecord {
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

/** Find the first TAG_EA byte sequence in [from, to). Returns -1 if absent. */
function findFirstTag(bytes: Uint8Array, from: number, to: number): number {
  return indexOfU32(bytes, TAG_EA, from, to);
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
 * Parse all supports from one model's record block using the CHAIN model.
 *
 * A support is a vertical chain: [base pad sub-4] → pillar sub-3 → knot sub-9 →
 * one-or-more tips sub-1. The number of supports equals the number of pillar
 * (sub-3) records. Parts are stitched by:
 *   - knot: shares pillar XY, knot center (topZ+botZ)/2 ≈ pillar topZ
 *   - base: shares pillar XY, base topZ ≈ pillar botZ
 *   - tips: tip botZ ≈ knot center; assigned to the nearest such support, with
 *     XY distance from the pillar as a tiebreak so branched tips (own contact XY)
 *     and closely-stacked supports don't steal each other's tips.
 *
 * All Z values are returned in world frame (raw + zOff). Diameters are radius×2.
 * Validated against SPOTLIGHT.chitubox (7 supports, 8 tips) matching an
 * independent Cbx layer scrub.
 */
function parseSupportBlock(
  view: DataView,
  bytes: Uint8Array,
  recBase: number,
  geoPtr: number,
  zOff: number,
  modelIdx: number,
): { supports: CbxSupport[]; braces: CbxBrace[] } {
  void bytes; // reserved: support-chain parsing reads via the DataView only.
  const totalRecBytes = geoPtr - recBase;
  const totalRecs = Math.floor(totalRecBytes / REC_SIZE);

  // Decode every record in the block (world-frame Z), skipping header + summary.
  const recs: RawRecord[] = [];
  for (let i = 0; i < totalRecs; i++) {
    const base = recBase + i * REC_SIZE;
    if (u32(view, base) !== TAG_EA) continue;
    const rec = readRecord(view, base);
    if (rec.sub === MODEL_HDR_SUB || rec.sub === SUMMARY_SUB) continue;
    // Shift Z into world frame up front so all continuity math is in one frame.
    rec.topZ += zOff;
    rec.botZ += zOff;
    recs.push(rec);
  }

  // A sub-3 record is a BRACE (diagonal strut between two shafts) when its two
  // endpoints differ in XY; otherwise it is a normal vertical pillar. Splitting
  // here keeps the vertical-chain logic below unchanged and routes braces to
  // their own output (previously these diagonal struts were silently dropped as
  // "tipless pillars").
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

  const allTipRecs = recs.filter((r) => r.sub === TIP_SUB);
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
  for (const t of tips) {
    let best: Chain | null = null;
    let bestScore = Infinity;
    for (const c of chains) {
      const dz = Math.abs(c.knotCenter - t.botZ);
      if (dz > 0.1) continue;
      const dxy = Math.hypot(t.x - c.pillar.x, t.y - c.pillar.y);
      const score = dz * 10 + dxy; // Z continuity dominant, XY tiebreak
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best) best.tips.push(t);
  }

  // Ground supports to their sub-5 foot (option c). Each support sits on a wide
  // flat sub-5 disk whose bottom is exactly the plate; sometimes several feet
  // cluster into what looks like a raised "platform". We do NOT render the feet
  // (or the platform they form) — instead we ground each support to its own foot
  // bottom: lower the base pad to the foot bottom (the plate) and extend the
  // pillar down to meet it, leaving the knot/tips/pillar-top untouched so model
  // contact is unchanged. This is the principled form of the old height heuristic:
  // sub-5 is the authoritative ground anchor, so a support raised onto a platform
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

  // Materialize into CbxSupport records.
  const supports: CbxSupport[] = [];
  let tiplessPillars = 0;
  let contactlessPillars = 0;
  let groundedToFoot = 0;

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
          length: slantLength, // authored cone length (true 3D slant distance)
          contactDiameter: t.paramA * 2, // small end on the model
          bodyDiameter: t.paramB * 2, // larger socket end
          contactDepth: t.extra, // penetration into the model
        };
      }),
    };

    supports.push(support);
  }

  if (tiplessPillars > 0 || braces.length > 0 || groundedToFoot > 0 || contactlessPillars > 0) {
    // One concise line. Tipless pillars are interior lattice struts (skipped);
    // contactless pillars are grounded brace-hosts kept without a contact cone;
    // braces are shaft-to-shaft struts; grounded are supports lowered onto their
    // sub-5 foot bottom (the foot/platform geometry itself is not reproduced).
    console.debug(
      `${LOG_PREFIX} instance ${modelIdx}: ${supports.length} editable supports, `
      + `${braces.length} braces, ${tiplessPillars} interior strut pillar(s) skipped, `
      + `${contactlessPillars} contactless brace-host pillar(s), `
      + `${groundedToFoot} support(s) grounded to sub-5 foot.`,
    );
  }

  return { supports, braces };
}

/**
 * Read a flat 36-byte-triangle geometry region into a non-indexed position
 * array (THREE expects 3 verts × 3 floats per triangle). Applies the Z offset
 * and drops any triangle with a vertex outside ±COORD_LIMIT (matches Python).
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
    const meshOffset = u32(view, 424);

    const filename = decodeCString(bytes, fnamePtr, 64) || sourceName;

    // Primary model tri count lives at mesh_offset + 720.
    const modelBytes0 = u32(view, meshOffset + 720);
    let modelStart = len - Math.floor(modelBytes0 / 36) * 36;

    // Locate first TAG; absence means a no-support file.
    const firstTag = findFirstTag(bytes, meshOffset + 720, modelStart);
    const hasSupports = firstTag !== -1;

    // Z offset: most-negative plausible float in the post-header scan region.
    const scanStart = hasSupports ? firstTag : modelStart;
    let minZ = 0.0;
    for (let i = scanStart; i < len - 3; i += 4) {
      const fv = f32(view, i);
      if (!Number.isNaN(fv) && fv > -500.0 && fv < 0.0 && fv < minZ) {
        minZ = fv;
      }
    }
    const zOff = -minZ;

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
    // Verified field-by-field against guns.chitubox (11 records) and
    // SPOTLIGHT.chitubox (1 record): support pointers land exactly on each model's
    // own parametric block (tip counts match the authoring app), and geometry
    // spans match the exported OBJ/STL bounding boxes triangle-for-triangle.
    //
    // NOTE: an earlier revision read these fields 20 bytes too high (relative to
    // meshOffset+720). That single shift produced every prior symptom — wrong
    // plate placement, support mis-ownership, a phantom "embedded block", and
    // corrupted OBJ geometry. The offsets above are correct; no special-casing of
    // anomalous entries, embedded blocks, or duplicate inference is needed.

    const REC_BASE = meshOffset + 444; // first record (filename) start
    const TAIL = 256; // tail offset within a record
    const STRIDE = 680;
    const NO_SUPPORT = 0xffffffff;

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
      if (h.supPtr !== NO_SUPPORT && h.supPtr !== 0) {
        const recBase = h.supPtr + INLINE_PAD;
        if (recBase > 0 && recBase < len && u32(view, recBase) === TAG_EA) {
          const geoPtr = u32(view, recBase + 40); // block-end marker the chain parser uses
          const parsed = parseSupportBlock(view, bytes, recBase, geoPtr, zOff, h.index);
          supports = parsed.supports;
          braces = parsed.braces;
        } else {
          console.warn(
            `${LOG_PREFIX} instance ${h.index}: support pointer ${h.supPtr} (+${INLINE_PAD} `
            + `= ${recBase}) does not land on a TAG record; skipping supports.`,
          );
        }
      }

      models.push({
        index: h.index,
        filename: h.name || `model_${h.index + 1}`,
        geometry,
        supports,
        braces,
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
