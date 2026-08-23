/**
 * Layout invariants for the .chitubox container, asserted against a real corpus.
 *
 * These encode what we believe the format IS, independently of what the parser
 * does with it. A failure means either the belief is wrong or a new writer has
 * appeared - both worth knowing before the parser is changed.
 *
 * The corpus lives outside the repo. Set CBX_CORPUS to a semicolon- or
 * comma-separated list of directories; without it these tests skip.
 *
 *   CBX_CORPUS="/path/to/corpus;/another/corpus" npx tsx --test CbxLayout.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MAGIC = 0xab231243;
const TAG = 0xea342389;
const STRIDE = 680; // record-table entry
const TAIL = 256; // tail offset within a record
const REC = 72; // parametric support record
const NO_SUPPORT = 0xffffffff;
const PRINTABLE = /^[\x20-\x7e]+$/;

function corpusRoots(): string[] {
  const raw = process.env.CBX_CORPUS;
  if (!raw) return [];
  return raw.split(/[;,]/).map((s) => s.trim()).filter(Boolean).filter((dir) => {
    try { return fs.statSync(dir).isDirectory(); } catch { return false; }
  });
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.chitubox')) out.push(full);
  }
  return out;
}

interface Cbx {
  file: string;
  view: DataView;
  len: number;
  u32: (o: number) => number;
  nInstances: number;
  field8: number;
  ptrBlock: number;
  tableDelta: number;
  meshOffset: number;
  table: number;
}

function load(file: string): Cbx | null {
  const buf = fs.readFileSync(file);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const len = buf.byteLength;
  if (len < 600) return null;
  const u32 = (o: number) => view.getUint32(o, true);
  if (u32(0) !== MAGIC) return null; // different container; asserted separately
  const ptrBlock = u32(12);
  if (ptrBlock + 16 > len) return null;
  return {
    file,
    view,
    len,
    u32,
    nInstances: u32(4),
    field8: u32(8),
    ptrBlock,
    tableDelta: u32(ptrBlock + 8),
    meshOffset: u32(ptrBlock + 12),
    table: u32(ptrBlock + 12) + u32(ptrBlock + 8),
  };
}

function recordName(c: Cbx, k: number): string {
  const off = c.table + k * STRIDE;
  const bytes = new Uint8Array(c.view.buffer, c.view.byteOffset + off, 256);
  const end = bytes.indexOf(0);
  return Buffer.from(bytes.subarray(0, end === -1 ? 256 : end)).toString('latin1');
}

/** Walk the contiguous TAG run from `blockPtr`. */
function tagRunEnd(c: Cbx, blockPtr: number): { end: number; count: number } {
  let p = blockPtr;
  let count = 0;
  while (p + REC <= c.len && c.u32(p) === TAG) {
    count++;
    p += REC;
  }
  return { end: p, count };
}

function at(c: Cbx, k: number): string {
  return path.basename(c.file) + ' record ' + k;
}

const roots = corpusRoots();
const files = roots.flatMap((r) => walk(r)).sort();
const corpus = files.map(load).filter((c): c is Cbx => c !== null);
const skip = roots.length === 0
  ? 'CBX_CORPUS not set'
  : (corpus.length === 0 ? 'no parsable .chitubox files under ' + roots.join(', ') : false);

describe('.chitubox layout invariants', { skip }, () => {
  it('every file declares the container magic', () => {
    for (const f of files) {
      const buf = fs.readFileSync(f);
      if (buf.byteLength < 4) continue;
      const magic = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true);
      assert.strictEqual(
        magic,
        MAGIC,
        path.basename(f) + ': magic 0x' + magic.toString(16) + ' is a different container',
      );
    }
  });

  it('the record table is meshOffset + delta, both located via field12', () => {
    for (const c of corpus) {
      assert.strictEqual(
        c.meshOffset + c.tableDelta,
        c.field8,
        path.basename(c.file) + ': meshOffset(' + c.meshOffset + ') + delta(' + c.tableDelta
        + ') != field8(' + c.field8 + '); field12=' + c.ptrBlock,
      );
    }
  });

  it('the record table lies wholly inside the file', () => {
    for (const c of corpus) {
      assert.ok(c.table > 0 && c.table < c.len, path.basename(c.file) + ': table out of range');
      assert.ok(
        c.table + c.nInstances * STRIDE <= c.len,
        path.basename(c.file) + ': table overruns EOF (n=' + c.nInstances + ')',
      );
    }
  });

  it('every record carries a printable filename', () => {
    for (const c of corpus) {
      for (let k = 0; k < c.nInstances; k++) {
        const name = recordName(c, k);
        assert.ok(name.length > 0, at(c, k) + ' has an empty filename');
        assert.ok(PRINTABLE.test(name), at(c, k) + ' filename not printable: ' + JSON.stringify(name));
      }
    }
  });

  it('every record declares whole triangles inside the file', () => {
    for (const c of corpus) {
      for (let k = 0; k < c.nInstances; k++) {
        const tail = c.table + k * STRIDE + TAIL;
        const geoStart = c.u32(tail + 16);
        const byteCount = c.u32(tail + 20);
        assert.ok(geoStart > 0 && geoStart < c.len, at(c, k) + ': geoStart out of range');
        assert.ok(byteCount > 0, at(c, k) + ': empty geometry');
        assert.ok(geoStart + byteCount <= c.len, at(c, k) + ': geometry overruns EOF');
        assert.strictEqual(byteCount % 36, 0, at(c, k) + ': ' + byteCount + ' is not whole triangles');
      }
    }
  });

  it('a support pointer resolves to its TAG block via supPtr + 4', () => {
    for (const c of corpus) {
      for (let k = 0; k < c.nInstances; k++) {
        const tail = c.table + k * STRIDE + TAIL;
        const supPtr = c.u32(tail + 12);
        if (supPtr === NO_SUPPORT || supPtr === 0) continue;
        assert.ok(supPtr > 0 && supPtr + 8 <= c.len, at(c, k) + ': supPtr out of range');
        const blockPtr = c.u32(supPtr + 4);
        assert.ok(blockPtr > 0 && blockPtr + 4 <= c.len, at(c, k) + ': block pointer out of range');
        assert.strictEqual(c.u32(blockPtr), TAG, at(c, k) + ': supPtr+4 does not land on a TAG');
      }
    }
  });

  it('the support block declares at least as many records as it uses', () => {
    // supPtr+0 is the ALLOCATED slot count, not the used one: one block in the
    // corpus declares 337 and writes 329, leaving eight zeroed slots. So the
    // run may be shorter, never longer, and the slack must be zero-filled.
    // This is why the parser counts the TAG run rather than trusting the field.
    for (const c of corpus) {
      for (let k = 0; k < c.nInstances; k++) {
        const tail = c.table + k * STRIDE + TAIL;
        const supPtr = c.u32(tail + 12);
        if (supPtr === NO_SUPPORT || supPtr === 0) continue;
        const declared = c.u32(supPtr);
        const blockPtr = c.u32(supPtr + 4);
        const run = tagRunEnd(c, blockPtr);
        assert.ok(run.count > 0, at(c, k) + ': support block has no TAG entries');
        assert.ok(
          run.count <= declared,
          at(c, k) + ': TAG run of ' + run.count + ' exceeds the declared ' + declared,
        );
        const slackEnd = blockPtr + declared * REC;
        if (run.count < declared && slackEnd <= c.len) {
          const slack = new Uint8Array(
            c.view.buffer,
            c.view.byteOffset + run.end,
            slackEnd - run.end,
          );
          assert.ok(
            slack.every((b) => b === 0),
            at(c, k) + ': unused slots between ' + run.end + ' and ' + slackEnd + ' are not zeroed',
          );
        }
      }
    }
  });

  it('the region between support records and geometry is whole triangles', () => {
    // Chitubox bakes a support mesh there. We do not import it, but the size
    // being a clean multiple of 36 is what identifies it as a triangle soup
    // rather than an unmodelled structure.
    for (const c of corpus) {
      for (let k = 0; k < c.nInstances; k++) {
        const tail = c.table + k * STRIDE + TAIL;
        const supPtr = c.u32(tail + 12);
        const geoStart = c.u32(tail + 16);
        if (supPtr === NO_SUPPORT || supPtr === 0) continue;
        const run = tagRunEnd(c, c.u32(supPtr + 4));
        const gap = geoStart - run.end;
        if (gap <= 0) continue; // geometry precedes the support block here
        assert.strictEqual(
          gap % 36,
          0,
          at(c, k) + ': baked-support region is ' + gap + ' bytes, not whole triangles',
        );
      }
    }
  });

  it('reports the corpus it validated', () => {
    const models = corpus.reduce((a, c) => a + c.nInstances, 0);
    const variants = [...new Set(corpus.map((c) => c.ptrBlock))].sort((a, b) => a - b);
    console.log(
      '      validated ' + corpus.length + ' file(s), ' + models
      + ' model record(s), field12 values seen: ' + variants.join(', '),
    );
    assert.ok(corpus.length > 0);
  });
});
