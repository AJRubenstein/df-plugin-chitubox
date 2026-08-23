/**
 * Corpus-wide per-file comparison: chain builder vs graph builder.
 *
 *   npx tsx tools/corpusCompare.ts <dir> [dir...]
 *
 * Per-file, and per-support within each file. Totals alone would let a builder
 * that drops 20 supports and invents 20 others look perfect.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { compareFile } from './compareGraph';

function walk(dir: string, out: string[] = []): string[] {
  let e: fs.Dirent[];
  try { e = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of e) {
    const f = path.join(dir, d.name);
    if (d.isDirectory()) walk(f, out);
    else if (d.name.toLowerCase().endsWith('.chitubox')) out.push(f);
  }
  return out;
}

const files = process.argv.slice(2).flatMap((r) => walk(r)).sort();
interface Row {
  file: string; missed: number; spurious: number;
  bs: number; gs: number; bt: number; gt: number; bb: number; gb: number;
  warnings: string[]; err?: string;
}
const rows: Row[] = [];
const origLog = console.log;
const origWarn = console.warn;

for (const f of files) {
  // The parser's per-instance chatter would bury the report, so console.log is
  // dropped for the duration of the parse. Warnings are KEPT -- an unplaced part
  // is the kind of difference this tool exists to surface -- and reported per
  // file below. Restored in `finally` so a throw cannot leave the process mute.
  const warnings: string[] = [];
  console.log = () => {};
  console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
  try {
    const r = compareFile(f);
    rows.push({
      file: path.basename(f),
      missed: r.missed.length, spurious: r.spurious.length,
      bs: r.baseline.supports, gs: r.graph.supports,
      bt: r.baseline.tips, gt: r.graph.tips,
      bb: r.baseline.braces, gb: r.graph.braces,
      warnings,
    });
  } catch (e) {
    rows.push({
      file: path.basename(f), missed: -1, spurious: -1,
      bs: 0, gs: 0, bt: 0, gt: 0, bb: 0, gb: 0,
      warnings, err: String(e).slice(0, 80),
    });
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
}

const ok = rows.filter((r) => !r.err);
const failed = rows.filter((r) => r.err);
const perfect = ok.filter((r) => r.missed === 0 && r.spurious === 0);
console.log(`files=${rows.length}  parsed=${ok.length}  threw=${failed.length}`);
console.log(`exact per-support match: ${perfect.length}/${ok.length}`);
const totMissed = ok.reduce((n, r) => n + r.missed, 0);
const totSpur = ok.reduce((n, r) => n + r.spurious, 0);
const totBs = ok.reduce((n, r) => n + r.bs, 0);
const totGs = ok.reduce((n, r) => n + r.gs, 0);
const totBt = ok.reduce((n, r) => n + r.bt, 0);
const totGt = ok.reduce((n, r) => n + r.gt, 0);
const totBb = ok.reduce((n, r) => n + r.bb, 0);
const totGb = ok.reduce((n, r) => n + r.gb, 0);
console.log(`supports baseline=${totBs} graph=${totGs}   tips baseline=${totBt} graph=${totGt}   braces baseline=${totBb} graph=${totGb}`);
console.log(`MISSED total=${totMissed}   spurious total=${totSpur}`);
const worst = ok.filter((r) => r.missed > 0 || r.spurious > 0)
  .sort((a, b) => (b.missed + b.spurious) - (a.missed + a.spurious));
console.log(`\nfiles with any difference: ${worst.length}`);
for (const r of worst.slice(0, 30)) {
  console.log(`  ${r.file.padEnd(46)} missed=${String(r.missed).padStart(3)} spur=${String(r.spurious).padStart(3)}  sup ${r.bs}->${r.gs}  tips ${r.bt}->${r.gt}  brace ${r.bb}->${r.gb}`);
}
for (const r of failed) console.log(`  THREW ${r.file}: ${r.err}`);

// Parser warnings are the point of this tool as much as the counts are: an
// unplaced part is a real difference, so surface it rather than dropping it.
const warned = rows.filter((r) => r.warnings.length > 0);
if (warned.length > 0) {
  console.log(`\nfiles with parser warnings: ${warned.length}`);
  for (const r of warned) {
    for (const w of r.warnings) console.warn(`  ${r.file}: ${w}`);
  }
}
