import * as THREE from 'three';
import type { CbxBrace, CbxModelInput, CbxSupport } from './CbxConverter';

/**
 * Parser for `.ctp` (ChiTuBox **Pro**) project files.
 *
 * A sibling of `CbxParser` for the Basic `.chitubox` format. The two share
 * support semantics but differ fundamentally in how geometry is stored, so the
 * geometry reader is NOT reusable between them:
 *
 *   - Basic stores flat 36-byte triangles (each vertex repeated per face).
 *   - Pro stores an indexed mesh: a vertex array plus a u32 index array.
 *
 * Container layout: chunk markers are `TT 12 23 ab`, i.e. the little-endian
 * u32 `0xAB2312TT`.
 *
 *   0x53  file header; u32 at +0x04 is the object count
 *   0x54  per-object transform + world AABB
 *   0x55  per-object mesh pointers
 *   0x56  support index; one per support *part*, absent when unsupported
 *
 * Each object has its own 0x54/0x55 pair, matched by ordinal since the chunks
 * are not adjacent in the file.
 */

const MAGIC_CTP = 0xab231253;
const LOG_PREFIX = '[CtpParser]';

/** Reject vertices outside +/-500mm, matching the Basic parser's guard. */
const COORD_LIMIT = 500;

/** Support part roles (`field0` in a pool record). Same vocabulary as Basic. */
const ROLE_TIP = 1;
const ROLE_PILLAR = 3;
const ROLE_BASE = 4;
const ROLE_FOOT = 5;
const ROLE_KNOT = 9;

/** Stride of a `0x56` support-index record. */
const SUPPORT_INDEX_STRIDE = 40;
/** Offset within a `0x56` record of the u32 pointing at its pool record. */
const SUPPORT_INDEX_POOL_PTR = 32;
/** Stride of a support pool record. */
const POOL_STRIDE = 48;

/**
 * A role-3 record whose two endpoints differ in XY by more than this is a
 * diagonal BRACE between shafts, not a vertical pillar. Authored pillars are
 * dead-vertical; braces span at least ~0.8mm. Same threshold the Basic parser
 * uses. On lily_Arm_L this separates 546 braces from 138 real pillars -- without
 * it every brace becomes its own support and plants a spurious root on the raft.
 */
const BRACE_XY_MIN = 0.3;

/** How close a brace endpoint must be to a pillar's XY to count as attached. */
const BRACE_HOST_XY = 0.5;

/** Authored pillars shorter than this are degenerate slivers, not real parts. */
const MIN_PILLAR_LENGTH = 0.5;

function u32(view: DataView, off: number): number {
  return view.getUint32(off, true);
}

function f32(view: DataView, off: number): number {
  return view.getFloat32(off, true);
}

/** u64 as a JS number. Every value here is a file offset, well under 2^53. */
function u64(view: DataView, off: number): number {
  return Number(view.getBigUint64(off, true));
}

/** Offsets of every chunk marker with the given tag byte. */
function chunkOffsets(bytes: Uint8Array, tag: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === tag && bytes[i + 1] === 0x12 && bytes[i + 2] === 0x23 && bytes[i + 3] === 0xab) {
      out.push(i);
    }
  }
  return out;
}

type Vec3 = { x: number; y: number; z: number };
type Mat3 = [number, number, number, number, number, number, number, number, number];

interface CtpObjectTransform {
  position: Vec3;
  /** Z lift applied on top of `position`. */
  liftZ: number;
  /** World-space AABB the file declares; useful for validating the rotation. */
  aabb: Vec3;
  /** Row-major 3x3 rotation. */
  rotation: Mat3;
}

/**
 * Decode a `0x54` object chunk.
 *
 * Float layout from chunk+8:
 *   [0..2]   position
 *   [3]      Z lift
 *   [6..8]   world AABB size
 *   [9..14]  scale (1.0 throughout every sample seen)
 *   [15..17] rotation row 0
 *   [18..20] rotation row 2
 *
 * Only two rotation rows are stored; the middle row is row0 x row2. Both stored
 * rows are unit length and mutually orthogonal, so this is exact rather than an
 * approximation.
 */
function readObjectTransform(view: DataView, chunk: number, len: number): CtpObjectTransform | null {
  const base = chunk + 8;
  if (base + 21 * 4 > len) return null;

  const at = (i: number) => f32(view, base + i * 4);

  const row0: [number, number, number] = [at(15), at(16), at(17)];
  const row2: [number, number, number] = [at(18), at(19), at(20)];
  const row1: [number, number, number] = [
    row0[1] * row2[2] - row0[2] * row2[1],
    row0[2] * row2[0] - row0[0] * row2[2],
    row0[0] * row2[1] - row0[1] * row2[0],
  ];

  return {
    position: { x: at(0), y: at(1), z: at(2) },
    liftZ: at(3),
    aabb: { x: at(6), y: at(7), z: at(8) },
    rotation: [...row0, ...row1, ...row2] as Mat3,
  };
}

/**
 * Read an indexed mesh from a `0x55` chunk into a non-indexed position array.
 *
 * Chunk fields: vertex offset at +8, vertex COUNT at +16, index offset at +24,
 * index COUNT at +32. Both counts are element counts, not byte spans -- reading
 * them as byte spans yields plausible-looking floats that are not a mesh.
 *
 * The result is expanded to non-indexed triangles because that is what the
 * converter and the host geometry pipeline expect, matching the Basic path.
 */
function readIndexedMesh(view: DataView, chunk: number, len: number): Float32Array | null {
  if (chunk + 40 > len) return null;

  const vertexOffset = u64(view, chunk + 8);
  const vertexCount = u64(view, chunk + 16);
  const indexOffset = u64(view, chunk + 24);
  const indexCount = u64(view, chunk + 32);

  const vertexEnd = vertexOffset + vertexCount * 12;
  const indexEnd = indexOffset + indexCount * 4;
  if (
    vertexOffset <= 0 || vertexCount <= 0 || vertexEnd > len
    || indexOffset <= 0 || indexCount < 3 || indexEnd > len
    || indexCount % 3 !== 0
  ) {
    console.warn(
      `${LOG_PREFIX} mesh chunk at 0x${chunk.toString(16)}: implausible spans `
      + `(verts=${vertexCount}@${vertexOffset}, idx=${indexCount}@${indexOffset}); skipping.`,
    );
    return null;
  }

  const triCount = indexCount / 3;
  const out = new Float32Array(triCount * 9);
  let w = 0;
  let dropped = 0;

  for (let t = 0; t < triCount; t++) {
    const tri: number[] = [];
    let ok = true;

    for (let c = 0; c < 3; c++) {
      const vi = u32(view, indexOffset + (t * 3 + c) * 4);
      if (vi >= vertexCount) { ok = false; break; }

      const p = vertexOffset + vi * 12;
      const x = f32(view, p);
      const y = f32(view, p + 4);
      const z = f32(view, p + 8);
      if (
        Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)
        || x <= -COORD_LIMIT || x >= COORD_LIMIT
        || y <= -COORD_LIMIT || y >= COORD_LIMIT
        || z <= -COORD_LIMIT || z >= COORD_LIMIT
      ) { ok = false; break; }

      tri.push(x, y, z);
    }

    if (!ok) { dropped++; continue; }
    out.set(tri, w);
    w += 9;
  }

  if (dropped > 0) {
    console.warn(`${LOG_PREFIX} dropped ${dropped} triangle(s) with out-of-range data.`);
  }
  return w === out.length ? out : out.slice(0, w);
}

/** Build a non-indexed BufferGeometry with computed normals. */
function positionsToGeometry(positions: Float32Array): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.computeVertexNormals();
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return geom;
}

/** One decoded 48-byte support pool record. */
interface CtpPoolRecord {
  /** Part role: 1 tip, 3 pillar, 4 base pad, 5 foot, 9 knot. */
  role: number;
  sub: number;
  x: number;
  y: number;
  topZ: number;
  x2: number;
  y2: number;
  botZ: number;
  /** Radius at the top of the part; double it for a diameter. */
  paramA: number;
  /** Radius at the bottom. */
  paramB: number;
  /** Trailing field; carries the tip's penetration depth into the model. */
  extra: number;
}

function readPoolRecord(view: DataView, off: number): CtpPoolRecord {
  return {
    role: u32(view, off),
    sub: u32(view, off + 4),
    x: f32(view, off + 8),
    y: f32(view, off + 12),
    topZ: f32(view, off + 16),
    x2: f32(view, off + 20),
    y2: f32(view, off + 24),
    botZ: f32(view, off + 28),
    paramA: f32(view, off + 32),
    paramB: f32(view, off + 36),
    extra: f32(view, off + 40),
  };
}

/**
 * Read every support pool record the `0x56` index points at.
 *
 * Each `0x56` record is a 40-byte handle whose u32 at +32 is the absolute
 * offset of its 48-byte pool record. An empty index is normal and means the
 * plate carries no supports.
 */
function readSupportPool(view: DataView, bytes: Uint8Array, len: number): CtpPoolRecord[] {
  const records: CtpPoolRecord[] = [];

  for (const entry of chunkOffsets(bytes, 0x56)) {
    if (entry + SUPPORT_INDEX_STRIDE > len) continue;
    const poolPtr = u32(view, entry + SUPPORT_INDEX_POOL_PTR);
    if (poolPtr <= 0 || poolPtr + POOL_STRIDE > len) continue;
    records.push(readPoolRecord(view, poolPtr));
  }
  return records;
}

/**
 * Assemble pool records into support chains.
 *
 * Pillar-centric, mirroring the Basic parser: **one support per pillar**
 * (role 3), with the other parts matched onto it. Earlier attempts here started
 * from the foot and all failed -- a foot can carry several pillars, pool order
 * is not dependable, and leaning parts break a naive XY walk.
 *
 * Matching rules, same as Basic:
 *   - knot:  shares the pillar XY and its centre meets the pillar top
 *   - base:  shares the pillar XY and its top meets the pillar bottom
 *   - foot:  the base's own foot, or the nearest one below the pillar
 *   - tips:  assigned to the chain whose knot centre matches the tip's botZ,
 *            with XY distance from the pillar as a tiebreak
 *
 * This assigns every tip in all four support-bearing samples.
 */
function buildSupports(
  records: CtpPoolRecord[],
  zOff: number,
): { supports: CbxSupport[]; braces: CbxBrace[] } {
  // Authored joints meet to a few thousandths; parts of one support share an XY
  // to float noise. Both tolerances are far below the spacing between supports.
  const Z_EPS = 0.05;
  const XY_EPS = 0.05;
  // A tip's socket lands on its knot centre this closely.
  const TIP_Z_TOL = 0.1;

  const isBrace = (r: CtpPoolRecord) =>
    r.role === ROLE_PILLAR && Math.hypot(r.x - r.x2, r.y - r.y2) > BRACE_XY_MIN;

  const byRole = (role: number) => records.filter((r) => r.role === role);
  const pillars = byRole(ROLE_PILLAR).filter((r) => !isBrace(r));
  const knots = byRole(ROLE_KNOT);
  const bases = byRole(ROLE_BASE);
  const feet = byRole(ROLE_FOOT);
  const tips = byRole(ROLE_TIP);

  const xyNear = (a: CtpPoolRecord, b: CtpPoolRecord, tol = XY_EPS) =>
    Math.hypot(a.x - b.x, a.y - b.y) <= tol;
  const near = (a: number, b: number, tol = Z_EPS) => Math.abs(a - b) <= tol;

  interface Chain {
    pillar: CtpPoolRecord;
    knot: CtpPoolRecord | null;
    base: CtpPoolRecord | null;
    foot: CtpPoolRecord | null;
    knotCentre: number;
    tips: CtpPoolRecord[];
  }

  const chains: Chain[] = pillars.map((pillar) => {
    const knot =
      knots.find((k) => xyNear(k, pillar) && near((k.topZ + k.botZ) / 2, pillar.topZ))
      ?? knots.find((k) => near((k.topZ + k.botZ) / 2, pillar.topZ, 0.03))
      ?? null;
    const base = bases.find((b) => xyNear(b, pillar) && near(b.topZ, pillar.botZ)) ?? null;
    const foot =
      (base ? feet.find((f) => xyNear(f, base) && near(f.topZ, base.botZ)) : undefined)
      ?? feet.find((f) => xyNear(f, pillar))
      ?? null;

    return {
      pillar,
      knot,
      base,
      foot,
      knotCentre: knot ? (knot.topZ + knot.botZ) / 2 : pillar.topZ,
      tips: [],
    };
  });

  for (const tip of tips) {
    let best: Chain | null = null;
    let bestScore = Infinity;
    for (const chain of chains) {
      const dz = Math.abs(chain.knotCentre - tip.botZ);
      if (dz > TIP_Z_TOL) continue;
      // Z continuity dominates; XY only separates otherwise-equal candidates.
      const score = dz * 10 + Math.hypot(tip.x - chain.pillar.x, tip.y - chain.pillar.y);
      if (score < bestScore) {
        bestScore = score;
        best = chain;
      }
    }
    if (best) best.tips.push(tip);
  }

  const braceRecords = records.filter(isBrace);

  /**
   * True when a brace lands on this pillar's shaft. Such a pillar is a
   * structural brace host -- it never touches the model, but dropping it takes
   * the whole lattice with it (one column on lily_Arm_L carries 56 braces).
   */
  const hostsBrace = (pillar: CtpPoolRecord) =>
    braceRecords.some((b) =>
      Math.hypot(b.x - pillar.x, b.y - pillar.y) <= BRACE_HOST_XY
      || Math.hypot(b.x2 - pillar.x, b.y2 - pillar.y) <= BRACE_HOST_XY);

  const supports: CbxSupport[] = [];

  for (const chain of chains) {
    // A tipless pillar that also hosts no brace is an interior strut that
    // neither contacts the model nor anchors anything, so there is nothing to
    // rebuild. One that hosts braces is kept as a contactless column.
    if (chain.tips.length === 0 && !hostsBrace(chain.pillar)) continue;
    // Degenerate slivers (authored zero-length records) are not real parts.
    if (Math.abs(chain.pillar.topZ - chain.pillar.botZ) < MIN_PILLAR_LENGTH) continue;

    const { pillar, base, foot, knot } = chain;
    // The pad spans from whichever part sits under the pillar down to the foot.
    const padTop = base ?? foot;
    const padBottom = foot ?? base;

    supports.push({
      pillarDiameter: pillar.paramA * 2,
      pillarTopZ: pillar.topZ + zOff,
      pillarBottomZ: pillar.botZ + zOff,
      pillarX: pillar.x,
      pillarY: pillar.y,
      knotCenterZ: chain.knotCentre + zOff,
      knotDiameter: (knot?.paramA ?? pillar.paramA) * 2,
      base: padTop && padBottom
        ? {
            topRadius: padTop.paramA,
            bottomRadius: padBottom.paramB,
            topZ: padTop.topZ + zOff,
            bottomZ: padBottom.botZ + zOff,
          }
        : null,
      tips: chain.tips.map((tip) => {
        // Cone length is the full 3D contact-to-socket distance, not the Z gap:
        // slanted tips are common and a Z-only length badly understates them.
        const dx = tip.x - tip.x2;
        const dy = tip.y - tip.y2;
        const dz = tip.topZ - tip.botZ;
        return {
          x: tip.x,
          y: tip.y,
          contactZ: tip.topZ + zOff,
          attachZ: tip.botZ + zOff,
          socketX: tip.x2,
          socketY: tip.y2,
          length: Math.sqrt(dx * dx + dy * dy + dz * dz),
          contactDiameter: tip.paramA * 2,
          bodyDiameter: tip.paramB * 2,
          contactDepth: tip.extra,
        };
      }),
    });
  }

  // Diagonal role-3 records are authored shaft-to-shaft struts: on lily_Arm_L
  // 188 of 200 sampled braces land both endpoints on a real pillar. Unlike the
  // Basic format, where bracing has to be inferred, Pro stores them explicitly,
  // so they are passed straight through.
  const braces: CbxBrace[] = records.filter(isBrace).map((b) => ({
    ax: b.x,
    ay: b.y,
    az: b.topZ + zOff,
    bx: b.x2,
    by: b.y2,
    bz: b.botZ + zOff,
    diameter: b.paramA * 2,
  }));

  return { supports, braces };
}

export interface ParsedCtpContainer {
  filename: string;
  objectCount: number;
  /**
   * Z shift applied to supports so the lowest foot sits on the plate. The mesh
   * is stored in the same authored frame, so the host must lift it by the same
   * amount or model and supports end up separated by this distance.
   */
  zOffset: number;
  models: CbxModelInput[];
}

export class CtpParser {
  /** True when the buffer carries the ChiTuBox Pro magic. */
  static matches(view: DataView, len: number): boolean {
    return len >= 4 && u32(view, 0) === MAGIC_CTP;
  }

  static async parse(file: File): Promise<ParsedCtpContainer> {
    const buffer = await file.arrayBuffer();
    return CtpParser.parseBuffer(buffer, file.name);
  }

  static parseBuffer(buffer: ArrayBuffer, sourceName: string): ParsedCtpContainer {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const len = bytes.length;

    if (!CtpParser.matches(view, len)) {
      throw new Error(
        `Not a .ctp file (magic 0x${len >= 4 ? u32(view, 0).toString(16) : '????'}).`,
      );
    }

    const declared = u32(view, 4);
    const objectChunks = chunkOffsets(bytes, 0x54);
    const meshChunks = chunkOffsets(bytes, 0x55);

    if (meshChunks.length === 0) {
      throw new Error('No mesh chunk (0xAB231255) found in .ctp container.');
    }
    if (declared !== meshChunks.length) {
      console.warn(
        `${LOG_PREFIX} header declares ${declared} object(s) but the file carries `
        + `${meshChunks.length} mesh chunk(s); using the chunks found.`,
      );
    }

    // Supports live in one pool for the whole file. The per-object split for
    // multi-object files is not yet known, so they are attached to the first
    // model rather than guessed at.
    const pool = readSupportPool(view, bytes, len);
    const feet = pool.filter((r) => r.role === ROLE_FOOT);
    const zOff = feet.length > 0 ? -Math.min(...feet.map((r) => r.botZ)) : 0;

    const models: CbxModelInput[] = [];

    for (let i = 0; i < meshChunks.length; i++) {
      const positions = readIndexedMesh(view, meshChunks[i], len);
      if (!positions || positions.length === 0) continue;

      const transform = objectChunks[i] != null
        ? readObjectTransform(view, objectChunks[i], len)
        : null;
      const built = models.length === 0
        ? buildSupports(pool, zOff)
        : { supports: [], braces: [] };
      const { supports, braces } = built;

      models.push({
        index: i,
        filename: meshChunks.length === 1 ? sourceName : `${sourceName}_${i + 1}`,
        geometry: positionsToGeometry(positions),
        supports,
        braces,
        twigs: [],
        junctionBranches: [],
        // The 0x54 `position` is NOT a plate translation: mesh vertices are
        // already authored in plate space (every sample centres on the origin
        // to within 0.005mm, whatever that field says), and the supports share
        // that frame. Passing it through shifted models ~80mm off the bed while
        // their supports stayed put. Only the Z lift is applied.
        transform: {
          plateX: 0,
          plateY: 0,
          liftZ: transform?.liftZ ?? 0,
        },
      });

      console.debug(
        `${LOG_PREFIX} object ${i}: ${positions.length / 9} triangle(s), `
        + `${supports.length} support(s), ${braces.length} brace(s).`,
      );
    }

    if (models.length === 0) {
      throw new Error('No readable geometry found in .ctp container.');
    }

    console.log(
      `${LOG_PREFIX} parsed ${models.length} object(s), ${pool.length} support part(s).`,
    );

    return { filename: sourceName, objectCount: models.length, zOffset: zOff, models };
  }
}
