/**
 * Corpus scanner: run CbxParser over every .chitubox file under one or more
 * roots and report failures.
 *
 *   npx tsx tools/scanCorpus.ts <dir> [dir...]
 *   npx tsx tools/scanCorpus.ts --quiet <dir>     only failures and the summary
 *
 * Exits non-zero if any file throws, so it can gate a commit.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CbxParser } from '../CbxParser';

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const roots = args.filter((a) => !a.startsWith('--'));

if (roots.length === 0) {
  console.error('usage: npx tsx tools/scanCorpus.ts [--quiet] <dir> [dir...]');
  process.exit(2);
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // unreadable directory — skip rather than abort the sweep
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.chitubox')) out.push(full);
  }
  return out;
}

interface Row {
  file: string;
  sizeMb: number;
  ok: boolean;
  models?: number;
  supported?: number;
  supports?: number;
  warnings: string[];
  error?: string;
  ms: number;
}

const files = roots.flatMap((r) => walk(r)).sort();
if (files.length === 0) {
  console.error(`No .chitubox files found under: ${roots.join(', ')}`);
  process.exit(2);
}

console.log(`Scanning ${files.length} file(s)...\n`);

const rows: Row[] = [];
const origWarn = console.warn;
const origLog = console.log;

for (const f of files) {
  const warnings: string[] = [];
  console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
  // The parser logs a per-instance summary via console.log; capture it too so
  // the report stays readable across a large corpus.
  console.log = () => {};
  const t0 = Date.now();
  try {
    const buf = fs.readFileSync(f);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const parsed = CbxParser.parseBuffer(ab, path.basename(f));
    const supports = parsed.models.reduce(
      (n, m) => n + (m.supports?.length ?? 0), 0,
    );
    rows.push({
      file: f,
      sizeMb: buf.byteLength / 1048576,
      ok: true,
      models: parsed.models.length,
      supported: parsed.models.filter((m) => (m.supports?.length ?? 0) > 0).length,
      supports,
      warnings,
      ms: Date.now() - t0,
    });
  } catch (err) {
    rows.push({
      file: f,
      sizeMb: fs.statSync(f).size / 1048576,
      ok: false,
      warnings,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      ms: Date.now() - t0,
    });
  } finally {
    console.warn = origWarn;
    console.log = origLog;
  }
}

for (const r of rows) {
  const name = path.basename(r.file);
  if (r.ok) {
    if (!quiet) {
      console.log(
        `  OK    ${name.padEnd(46).slice(0, 46)} `
        + `${r.sizeMb.toFixed(1).padStart(7)}MB  models=${String(r.models).padStart(3)} `
        + `supported=${String(r.supported).padStart(3)} supports=${String(r.supports).padStart(5)} `
        + `${String(r.ms).padStart(5)}ms`,
      );
    }
  } else {
    console.log(`  FAIL  ${name.padEnd(46).slice(0, 46)} ${r.sizeMb.toFixed(1).padStart(7)}MB  ${r.error}`);
    console.log(`        ${r.file}`);
  }
  for (const w of r.warnings) {
    if (!quiet || !r.ok) console.log(`        warn: ${w}`);
  }
}

const failed = rows.filter((r) => !r.ok);
const noSupports = rows.filter((r) => r.ok && r.supports === 0);
const warned = rows.filter((r) => r.warnings.length > 0);

console.log(`\n${'='.repeat(78)}`);
console.log(`  scanned   ${rows.length}`);
console.log(`  parsed    ${rows.length - failed.length}`);
console.log(`  FAILED    ${failed.length}`);
console.log(`  warnings  ${warned.length}`);
console.log(`  zero supports (parsed but empty — worth eyeballing) ${noSupports.length}`);
if (noSupports.length > 0 && !quiet) {
  for (const r of noSupports) console.log(`      ${path.basename(r.file)}`);
}
console.log('='.repeat(78));

process.exit(failed.length > 0 ? 1 : 0);
