import * as THREE from 'three';
import type { CbxBrace, CbxJunctionBranch, CbxModelInput, CbxSupport } from './CbxConverter';

const MAGIC_CTP = 0xab231253;
const LOG_PREFIX = '[CtpParser]';
const COORD_LIMIT = 500;
const ROLE_TIP = 1;
const ROLE_BRACE = 2;
const ROLE_PILLAR = 3;
const ROLE_BASE = 4;
const ROLE_FOOT = 5;
const ROLE_SMALL_KNOT = 7;
const ROLE_KNOT = 9;
const SUPPORT_INDEX_STRIDE = 40;
const SUPPORT_INDEX_COUNT = 0x18;
const SUPPORT_INDEX_OFFSET = 0x20;
const POOL_STRIDE = 48;
const OBJECT_RECORD_STRIDE = 0xd8;
const MESH_HEADER_STRIDE = 0x28;
const BRACE_XY_MIN = 0.3;
const BRACE_HOST_XY = 0.5;
const MIN_PILLAR_LENGTH = 0.5;
const TIP_STRUT_XY_MIN = 0.5;

function u32(view: DataView, off: number): number {
  return view.getUint32(off, true);
}

function f32(view: DataView, off: number): number {
  return view.getFloat32(off, true);
}

function u64(view: DataView, off: number): number {
  return Number(view.getBigUint64(off, true));
}

function inRange(off: number, size: number, len: number): boolean {
  return off >= 0 && size >= 0 && off + size <= len;
}

function readIndexedMesh(view: DataView, header: number, len: number): Float32Array | null {
  if (!inRange(header, MESH_HEADER_STRIDE, len)) return null;
  const vertexOffset = u64(view, header + 8);
  const vertexCount = u64(view, header + 16);
  const indexOffset = u64(view, header + 24);
  const indexCount = u64(view, header + 32);
  const vertexEnd = vertexOffset + vertexCount * 12;
  const indexEnd = indexOffset + indexCount * 4;
  if (
    vertexOffset <= 0 || vertexCount <= 0 || vertexEnd > len
    || indexOffset <= 0 || indexCount < 3 || indexEnd > len
    || indexCount % 3 !== 0
  ) {
    console.warn(`${LOG_PREFIX} invalid mesh header at 0x${header.toString(16)}`);
    return null;
  }

  const triangles = indexCount / 3;
  const out = new Float32Array(triangles * 9);
  let w = 0;
  for (let t = 0; t < triangles; t++) {
    let ok = true;
    const tri: number[] = [];
    for (let c = 0; c < 3; c++) {
      const index = u32(view, indexOffset + (t * 3 + c) * 4);
      if (index >= vertexCount) { ok = false; break; }
      const p = vertexOffset + index * 12;
      const x = f32(view, p);
      const y = f32(view, p + 4);
      const z = f32(view, p + 8);
      if (
        !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)
        || Math.abs(x) >= COORD_LIMIT || Math.abs(y) >= COORD_LIMIT || Math.abs(z) >= COORD_LIMIT
      ) { ok = false; break; }
      tri.push(x, y, z);
    }
    if (!ok) continue;
    out.set(tri, w);
    w += 9;
  }
  return w === out.length ? out : out.slice(0, w);
}

function positionsToGeometry(positions: Float32Array): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

interface PoolRecord {
  role: number;
  sub: number;
  x: number;
  y: number;
  topZ: number;
  x2: number;
  y2: number;
  botZ: number;
  paramA: number;
  paramB: number;
  extra: number;
}

function readPoolRecord(view: DataView, off: number): PoolRecord {
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

function readObjectPool(view: DataView, len: number, indexOffset: number, indexCount: number): PoolRecord[] {
  const records: PoolRecord[] = [];
  if (!inRange(indexOffset, indexCount * SUPPORT_INDEX_STRIDE, len)) return records;
  for (let i = 0; i < indexCount; i++) {
    const entry = indexOffset + i * SUPPORT_INDEX_STRIDE;
    const count = u32(view, entry + SUPPORT_INDEX_COUNT);
    const poolOffset = u64(view, entry + SUPPORT_INDEX_OFFSET);
    if (count <= 0 || !inRange(poolOffset, count * POOL_STRIDE, len)) continue;
    for (let k = 0; k < count; k++) {
      records.push(readPoolRecord(view, poolOffset + k * POOL_STRIDE));
    }
  }
  return records;
}

function buildSupports(
  records: PoolRecord[],
): { supports: CbxSupport[]; braces: CbxBrace[]; junctionBranches: CbxJunctionBranch[] } {
  const Z_EPS = 0.05;
  const XY_EPS = 0.05;
  const TIP_Z_TOL = 0.1;
  const TIP_FAN_XY = 1.0;

  const isBrace = (r: PoolRecord) =>
    r.role === ROLE_BRACE
    || (r.role === ROLE_PILLAR && Math.hypot(r.x - r.x2, r.y - r.y2) > BRACE_XY_MIN);
  const isTipStrut = (r: PoolRecord) =>
    r.role === ROLE_TIP
    && Math.abs(r.paramA - r.paramB) < 1e-3
    && Math.hypot(r.x - r.x2, r.y - r.y2) > TIP_STRUT_XY_MIN;

  const byRole = (role: number) => records.filter((r) => r.role === role);
  const pillars = byRole(ROLE_PILLAR).filter((r) => !isBrace(r));
  const knots = [...byRole(ROLE_KNOT), ...byRole(ROLE_SMALL_KNOT)];
  const bases = byRole(ROLE_BASE);
  const feet = byRole(ROLE_FOOT);
  const tips = byRole(ROLE_TIP).filter((r) => !isTipStrut(r));

  const xyNear = (a: PoolRecord, b: PoolRecord, tol = XY_EPS) =>
    Math.hypot(a.x - b.x, a.y - b.y) <= tol;
  const near = (a: number, b: number, tol = Z_EPS) => Math.abs(a - b) <= tol;

  interface Chain {
    pillar: PoolRecord;
    knot: PoolRecord | null;
    base: PoolRecord | null;
    foot: PoolRecord | null;
    knotCentre: number;
    tips: PoolRecord[];
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
      const score = dz * 10 + Math.hypot(tip.x - chain.pillar.x, tip.y - chain.pillar.y);
      if (score < bestScore) {
        bestScore = score;
        best = chain;
      }
    }
    if (best) best.tips.push(tip);
  }

  const braceRecords = records.filter(isBrace);
  const hostsBrace = (pillar: PoolRecord) =>
    braceRecords.some((b) =>
      Math.hypot(b.x - pillar.x, b.y - pillar.y) <= BRACE_HOST_XY
      || Math.hypot(b.x2 - pillar.x, b.y2 - pillar.y) <= BRACE_HOST_XY);

  const supports: CbxSupport[] = [];
  for (const chain of chains) {
    if (chain.tips.length === 0 && !hostsBrace(chain.pillar)) continue;
    if (Math.abs(chain.pillar.topZ - chain.pillar.botZ) < MIN_PILLAR_LENGTH) continue;

    const { pillar, knot, base, foot } = chain;
    const padTop = base ?? foot;
    const padBottom = foot ?? base;
    supports.push({
      pillarDiameter: pillar.paramA * 2,
      pillarTopZ: pillar.topZ,
      pillarBottomZ: pillar.botZ,
      pillarX: pillar.x,
      pillarY: pillar.y,
      knotCenterZ: chain.knotCentre,
      knotDiameter: (knot?.paramA ?? pillar.paramA) * 2,
      base: padTop && padBottom
        ? {
            topRadius: padTop.paramA,
            bottomRadius: padBottom.paramB,
            topZ: padTop.topZ,
            bottomZ: padBottom.botZ,
          }
        : null,
      tips: chain.tips.map((tip) => {
        const dx = tip.x - tip.x2;
        const dy = tip.y - tip.y2;
        const dz = tip.topZ - tip.botZ;
        return {
          x: tip.x,
          y: tip.y,
          contactZ: tip.topZ,
          attachZ: tip.botZ,
          socketX: tip.x2,
          socketY: tip.y2,
          length: Math.sqrt(dx * dx + dy * dy + dz * dz),
          contactDiameter: tip.extra > 0 ? tip.extra : tip.paramA * 2,
          bodyDiameter: tip.paramB * 2,
          contactDepth: 0,
        };
      }),
    });
  }

  const braces: CbxBrace[] = [...braceRecords, ...records.filter(isTipStrut)].map((b) => ({
    ax: b.x,
    ay: b.y,
    az: b.topZ,
    bx: b.x2,
    by: b.y2,
    bz: b.botZ,
    diameter: b.paramA * 2,
  }));

  const junctionBranches: CbxJunctionBranch[] = [];
  for (const brace of braceRecords) {
    const knot = knots.find((k) =>
      Math.hypot(k.x - brace.x, k.y - brace.y) <= XY_EPS
      && Math.abs((k.topZ + k.botZ) / 2 - brace.topZ) <= TIP_Z_TOL);
    if (!knot) continue;
    const centre = (knot.topZ + knot.botZ) / 2;
    const branchTips = tips.filter((t) =>
      Math.abs(t.botZ - centre) <= TIP_Z_TOL
      && Math.hypot(t.x2 - knot.x, t.y2 - knot.y) <= TIP_FAN_XY);
    if (branchTips.length === 0) continue;
    junctionBranches.push({
      junctionX: brace.x,
      junctionY: brace.y,
      junctionZ: brace.topZ,
      parentX: brace.x2,
      parentY: brace.y2,
      parentZ: brace.botZ,
      diameter: brace.paramA * 2,
      tips: branchTips.map((tip) => {
        const dx = tip.x - tip.x2;
        const dy = tip.y - tip.y2;
        const dz = tip.topZ - tip.botZ;
        return {
          x: tip.x,
          y: tip.y,
          contactZ: tip.topZ,
          attachZ: tip.botZ,
          socketX: tip.x2,
          socketY: tip.y2,
          length: Math.sqrt(dx * dx + dy * dy + dz * dz),
          contactDiameter: tip.extra > 0 ? tip.extra : tip.paramA * 2,
          bodyDiameter: tip.paramB * 2,
          contactDepth: 0,
        };
      }),
    });
  }

  return { supports, braces, junctionBranches };
}

export interface ParsedCtpContainer {
  filename: string;
  instanceCount: number;
  modelCount: number;
  geoModelCount: number;
  objectCount: number;
  zOffset: number;
  models: CbxModelInput[];
}

export class CtpParser {
  static matches(view: DataView, len: number): boolean {
    return len >= 4 && u32(view, 0) === MAGIC_CTP;
  }

  static async parse(file: File): Promise<ParsedCtpContainer> {
    return CtpParser.parseBuffer(await file.arrayBuffer(), file.name);
  }

  static parseBuffer(buffer: ArrayBuffer, sourceName: string): ParsedCtpContainer {
    const view = new DataView(buffer);
    const len = buffer.byteLength;
    if (len < 4) throw new Error('Not a .ctp file (too short).');
    if (!CtpParser.matches(view, len)) {
      throw new Error(`Not a .ctp file (magic 0x${u32(view, 0).toString(16)}).`);
    }

    const objectCount = u32(view, 4);
    const tableOffset = u64(view, 0x18);
    if (objectCount <= 0 || !inRange(tableOffset, objectCount * OBJECT_RECORD_STRIDE, len)) {
      throw new Error('Invalid .ctp object table.');
    }

    const models: CbxModelInput[] = [];
    for (let i = 0; i < objectCount; i++) {
      const record = tableOffset + i * OBJECT_RECORD_STRIDE;
      const meshCount = u32(view, record + 0xac);
      const meshTable = u64(view, record + 0xc0);
      const supportTable = u64(view, record + 0xc8);
      const supportCount = u64(view, record + 0xd0);
      const nameLength = u64(view, record + 0xb0);
      const nameOffset = u64(view, record + 0xb8);

      let name = sourceName;
      if (nameOffset > 0 && nameLength > 0 && inRange(nameOffset, nameLength, len)) {
        const raw = new Uint8Array(buffer, nameOffset, Math.min(nameLength, 512));
        const end = raw.indexOf(0);
        const text = raw.subarray(0, end === -1 ? raw.length : end);
        name = new TextDecoder('latin1').decode(text);
      }

      const meshes: Float32Array[] = [];
      for (let m = 0; m < meshCount; m++) {
        const mesh = readIndexedMesh(view, meshTable + m * MESH_HEADER_STRIDE, len);
        if (mesh && mesh.length > 0) meshes.push(mesh);
      }
      if (meshes.length === 0) continue;

      let total = 0;
      for (const m of meshes) total += m.length;
      const positions = new Float32Array(total);
      let offset = 0;
      for (const m of meshes) { positions.set(m, offset); offset += m.length; }

      const pool = readObjectPool(view, len, supportTable, supportCount);
      const built = buildSupports(pool);
      const positionX = f32(view, record + 0x08);
      const positionY = f32(view, record + 0x0c);
      const liftZ = f32(view, record + 0x14);

      models.push({
        index: i,
        filename: name,
        geometry: positionsToGeometry(positions),
        supports: built.supports,
        braces: built.braces,
        twigs: [],
        junctionBranches: built.junctionBranches,
        transform: {
          plateX: positionX,
          plateY: positionY,
          liftZ,
        },
      });
    }

    if (models.length === 0) throw new Error('No readable geometry in .ctp container.');
    return {
      filename: sourceName,
      instanceCount: models.length,
      modelCount: models.length,
      geoModelCount: models.filter((m) => m.geometry?.getAttribute('position')?.count).length,
      objectCount,
      zOffset: 0,
      models,
    };
  }
}
