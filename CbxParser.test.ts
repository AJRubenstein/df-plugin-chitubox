import { describe, it } from 'node:test';
import assert from 'node:assert';
import { CbxParser } from './CbxParser';

/**
 * Builds a synthetic single-model `.chitubox` buffer whose support records form
 * ONE chain: [base pad sub-4] → pillar sub-3 → knot sub-9 → tip(s) sub-1,
 * stitched by the continuity rule (each part's botZ ≈ the part-below's topZ).
 *
 * Records are written in raw (pre-z-offset) frame. The parser derives the
 * z-offset from the most-negative plausible float, so we choose raw Z values
 * whose most-negative is a known constant.
 */
function buildChainBlob(opts?: {
  /** Extra tips sharing the same knot (branched support). */
  extraTips?: Array<{ x: number; y: number; contactZ: number; cD: number; bD: number }>;
  withBase?: boolean;
}): { buffer: ArrayBuffer; zOff: number } {
  const MAGIC = 0xab231243;
  const TAG = 0xea342389;
  const REC = 72;

  // Raw-frame Z plan (world = raw + zOff). Choose raft bottom = -10.0 so the
  // most-negative plausible float in the scan is -10.0 → zOff = 10.0.
  const RAFT_BOT = -10.0;
  const zOff = 10.0;

  // Chain (raw frame):
  //   base pad: botZ -10.0 → topZ -8.5   (only if withBase)
  //   pillar:   botZ -8.5  → topZ -5.0   (or -10 → -5 without base)
  //   knot:     center -5.0 (botZ -5.6, topZ -4.4 → diameter 1.2)
  //   tip:      botZ -5.0 (= knot center) → topZ -1.0 (contact)
  const withBase = opts?.withBase ?? false;
  const pillarBot = withBase ? -8.5 : RAFT_BOT;
  const pillarTop = -5.0;
  const knotBot = -5.6;
  const knotTop = -4.4; // center -5.0, diameter 1.2
  const tipBot = -5.0;
  const tipTop = -1.0; // contact; world 9.0

  const records: Array<[number, number, number, number, number, number, number, number]> = [];
  // [sub, x, y, topZ, botZ, paramA, paramB, extra]
  records.push([6, 0, 0, -1e8, -1e9, 1, 1, 0]); // summary (must be skipped)
  if (withBase) records.push([4, 5, 5, pillarBot, RAFT_BOT, 0.65, 1.95, 0]); // base pad
  records.push([3, 5, 5, pillarTop, pillarBot, 0.65, 0.65, 0]); // pillar (paramA*2 = 1.3)
  records.push([9, 5, 5, knotTop, knotBot, 0.676, 0.676, 0]); // knot (diameter via topZ-botZ = 1.2)
  records.push([1, 4, 4, tipTop, tipBot, 0.175, 0.45, 0.2]); // primary tip (cD 0.35, bD 0.90)
  for (const t of opts?.extraTips ?? []) {
    records.push([1, t.x, t.y, t.contactZ, tipBot, t.cD / 2, t.bD / 2, 0.2]);
  }

  // Build a single-instance container using the VERIFIED record layout:
  //   record start (filename) @ meshOffset + 444
  //   tail (28 bytes)         @ meshOffset + 700  (filename + 256)
  //   tail+0/4/8  plateX/plateY/liftZ (f32)
  //   tail+12     supPtr  (record block = supPtr + INLINE_PAD)
  //   tail+16     geoStart
  //   tail+20     byteCount
  // The support TAG records live at supPtr + INLINE_PAD; geometry at geoStart.
  const INLINE_PAD = 436;
  const meshOffset = 0x200;
  const recStart = meshOffset + 444;
  const tailOff = recStart + 256; // meshOffset + 700

  const tris = [
    [[0, 0, -3.0], [1, 0, -3.0], [0, 1, -2.5]],
    [[0, 0, -3.0], [0, 1, -2.5], [-1, 0, -2.0]],
  ];
  const modelBytes = tris.length * 36;

  // Layout the regions after the record tail. The support block must start at a
  // (supPtr + INLINE_PAD) offset; we place records first, then geometry.
  const recBase = tailOff + 64; // first TAG record
  const supPtr = recBase - INLINE_PAD; // so supPtr + INLINE_PAD == recBase
  const geoPtr = recBase + records.length * REC; // block-end marker (tail+40 of rec0)
  const geoStart = geoPtr; // geometry immediately follows the records
  const totalLen = geoStart + modelBytes;

  const fname = 'Chain.stl\u0000';

  const buf = new ArrayBuffer(totalLen);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, 1, true); // nInstances
  dv.setUint32(424, meshOffset, true);

  // Filename + record tail.
  for (let i = 0; i < fname.length; i++) u8[recStart + i] = fname.charCodeAt(i);
  dv.setFloat32(tailOff + 0, 0, true); // plateX
  dv.setFloat32(tailOff + 4, 0, true); // plateY
  dv.setFloat32(tailOff + 8, 5.0, true); // liftZ
  dv.setUint32(tailOff + 12, supPtr >>> 0, true); // supPtr
  dv.setUint32(tailOff + 16, geoStart, true); // geoStart
  dv.setUint32(tailOff + 20, modelBytes, true); // byteCount
  u8[tailOff + 26] = 0x4e; // terminator marker (last two bytes 0x4E 0xFF)
  u8[tailOff + 27] = 0xff;

  records.forEach(([sub, x, y, topZ, botZ, a, b, extra], i) => {
    const off = recBase + i * REC;
    dv.setUint32(off + 0, TAG, true);
    dv.setUint32(off + 4, sub, true);
    dv.setFloat32(off + 8, x, true);
    dv.setFloat32(off + 12, y, true);
    dv.setFloat32(off + 16, topZ, true);
    // Second endpoint (+20/+24) equals the first for a vertical pillar/tip; a
    // brace would differ here. Writing it explicitly avoids a 0,0 default that
    // would misclassify the record as a diagonal brace.
    dv.setFloat32(off + 20, x, true);
    dv.setFloat32(off + 24, y, true);
    dv.setFloat32(off + 28, botZ, true);
    dv.setFloat32(off + 32, a, true);
    dv.setFloat32(off + 36, b, true);
    dv.setUint32(off + 40, geoPtr, true);
    dv.setUint32(off + 44, 0, true);
    dv.setFloat32(off + 48, extra, true);
  });

  for (let t = 0; t < tris.length; t++) {
    const off = geoStart + t * 36;
    for (let i = 0; i < 3; i++) {
      dv.setFloat32(off + i * 12 + 0, tris[t][i][0], true);
      dv.setFloat32(off + i * 12 + 4, tris[t][i][1], true);
      dv.setFloat32(off + i * 12 + 8, tris[t][i][2], true);
    }
  }

  return { buffer: buf, zOff };
}

describe('CbxParser.parseBuffer — chain model', () => {
  it('rejects a buffer without the chitubox magic', () => {
    const bad = new ArrayBuffer(16);
    new DataView(bad).setUint32(0, 0x12345678, true);
    assert.throws(() => CbxParser.parseBuffer(bad, 'bad.chitubox'), /Not a \.chitubox file/);
  });

  it('parses one support per pillar (sub-3), skipping summary (sub-6)', () => {
    const { buffer } = buildChainBlob();
    const r = CbxParser.parseBuffer(buffer, 'chain.chitubox');
    assert.equal(r.models.length, 1);
    assert.equal(r.models[0].supports.length, 1);
  });

  it('decodes authored pillar diameter (paramA×2), NOT the knot sphere', () => {
    const { buffer } = buildChainBlob();
    const s = CbxParser.parseBuffer(buffer, 'c').models[0].supports[0];
    assert.ok(Math.abs(s.pillarDiameter - 1.3) < 1e-3, `pillarDiameter ${s.pillarDiameter}`);
    // Knot sphere diameter is separate and ~1.2 here, must not be confused.
    assert.ok(Math.abs(s.knotDiameter - 1.2) < 1e-2, `knotDiameter ${s.knotDiameter}`);
  });

  it('treats sub-3 as the pillar, not a tip (the core grouping fix)', () => {
    const { buffer } = buildChainBlob();
    const s = CbxParser.parseBuffer(buffer, 'c').models[0].supports[0];
    // Exactly one tip from the single sub-1 record; the sub-3 pillar is NOT a tip.
    assert.equal(s.tips.length, 1);
  });

  it('maps tip diameters correctly: contact (small) = paramA×2, body = paramB×2', () => {
    const { buffer } = buildChainBlob();
    const tip = CbxParser.parseBuffer(buffer, 'c').models[0].supports[0].tips[0];
    assert.ok(Math.abs(tip.contactDiameter - 0.35) < 1e-3, `contact ${tip.contactDiameter}`);
    assert.ok(Math.abs(tip.bodyDiameter - 0.9) < 1e-3, `body ${tip.bodyDiameter}`);
    assert.ok(tip.contactDiameter < tip.bodyDiameter, 'contact end must be smaller');
  });

  it('computes authored tip length = contactZ − attachZ', () => {
    const { buffer } = buildChainBlob();
    const tip = CbxParser.parseBuffer(buffer, 'c').models[0].supports[0].tips[0];
    // raw tip topZ -1.0, botZ -5.0 → length 4.0
    assert.ok(Math.abs(tip.length - 4.0) < 1e-3, `length ${tip.length}`);
  });

  it('groups multiple sub-1 tips on one knot as a branched support', () => {
    const { buffer } = buildChainBlob({
      extraTips: [{ x: 1, y: 1, contactZ: -2.0, cD: 0.25, bD: 0.8 }],
    });
    const s = CbxParser.parseBuffer(buffer, 'c').models[0].supports[0];
    assert.equal(s.tips.length, 2, 'one support with two tip branches');
  });

  it('captures an authored base pad when present (sub-4)', () => {
    const { buffer } = buildChainBlob({ withBase: true });
    const s = CbxParser.parseBuffer(buffer, 'c').models[0].supports[0];
    assert.ok(s.base, 'expected a base pad');
    assert.ok(Math.abs(s.base!.bottomRadius - 1.95) < 1e-3);
  });
});

/**
 * Real-file regression against the verified SPOTLIGHT reconstruction (7 supports,
 * 8 tips, including branched support IV). Ground truth comes from an independent
 * Cbx layer scrub, NOT the (previously-buggy) Python oracle.
 *
 * Auto-skips when the fixture is absent.
 */
describe('CbxParser real-file regression (SPOTLIGHT.chitubox)', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const fixture = path.join(__dirname, 'SPOTLIGHT.chitubox');
  const present = fs.existsSync(fixture);

  // Verified ground truth (world frame). Each entry: pillar diameter, base?,
  // and tips as [contactZ, contactD, bodyD].
  const GROUND_TRUTH = {
    zOffset: 11.5696,
    modelTriangles: 100128,
    supportCount: 7,
    tipCount: 8,
    supports: [
      { pillarD: 1.3, base: false, tips: [[5.791, 0.35, 0.9]] },
      { pillarD: 1.3, base: false, tips: [[5.746, 0.35, 0.9]] },
      { pillarD: 1.3, base: false, tips: [[5.202, 0.35, 0.9]] },
      { pillarD: 1.3, base: false, tips: [[6.927, 0.25, 0.8], [5.478, 0.25, 0.8]] },
      { pillarD: 1.3, base: false, tips: [[5.711, 0.55, 1.1]] },
      { pillarD: 1.3, base: true, tips: [[10.535, 0.35, 0.9]] },
      { pillarD: 1.3, base: true, tips: [[10.543, 0.35, 0.9]] },
    ],
  };

  it('reproduces the verified 7-support reconstruction', { skip: !present ? 'fixture absent' : false }, () => {
    const node = fs.readFileSync(fixture);
    const ab = node.buffer.slice(node.byteOffset, node.byteOffset + node.byteLength);
    const r = CbxParser.parseBuffer(ab, 'SPOTLIGHT.chitubox');

    assert.ok(Math.abs(r.zOffset - GROUND_TRUTH.zOffset) < 1e-3, `zOffset ${r.zOffset}`);
    const model = r.models[0];
    assert.equal(
      (model.geometry?.getAttribute('position')?.count ?? 0) / 3,
      GROUND_TRUTH.modelTriangles,
    );

    const supports = model.supports;
    assert.equal(supports.length, GROUND_TRUTH.supportCount, 'support count');
    const totalTips = supports.reduce((a, s) => a + s.tips.length, 0);
    assert.equal(totalTips, GROUND_TRUTH.tipCount, 'total tip count');

    // Match each expected support to a parsed one by its (sorted) tip contact Zs.
    const normParsed = (s: any) =>
      s.tips.map((t: any) => Math.round(t.contactZ * 1000)).sort((a: number, b: number) => a - b).join(',');
    const normExpected = (s: any) =>
      s.tips.map((t: any[]) => Math.round(t[0] * 1000)).sort((a: number, b: number) => a - b).join(',');
    const expectedKeys = GROUND_TRUTH.supports.map(normExpected).sort();
    const gotKeys = supports.map(normParsed).sort();
    assert.deepEqual(gotKeys, expectedKeys, 'support→tip grouping must match');

    // Every support has the correct authored pillar diameter (1.30), not 1.352.
    for (const s of supports) {
      assert.ok(Math.abs(s.pillarDiameter - 1.3) < 1e-2, `pillarD ${s.pillarDiameter}`);
    }

    // Branched support IV present: exactly one support with two tips.
    const branched = supports.filter((s) => s.tips.length === 2);
    assert.equal(branched.length, 1, 'exactly one branched support');

    // Base pads only on the two tall supports.
    assert.equal(supports.filter((s) => s.base).length, 2, 'two supports with base pads');
  });
});
