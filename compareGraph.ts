/**
 * Per-support comparison: chain builder vs graph builder, on one file.
 *
 *   npx tsx compareGraph.ts <file.chitubox> [--verbose]
 *
 * Aggregate counts hide compensating errors -- a builder that drops 20 supports
 * and invents 20 others scores perfect on totals. So this matches support to
 * support by pillar XY and reports MISSED and SPURIOUS separately.
 */
import * as fs from 'node:fs';
import { CbxParser, decodeSupportBlockRecords, cbxDebugBlocks } from './CbxParser';
import { buildSupportGraph, type GraphRecord } from './converter/supportGraph';
import { emitFromGraph } from './converter/graphEmit';
import type { CbxSupport } from './converter/types';

/** Two pillars are the same pillar when their XY centres agree this closely. */
const MATCH_TOL_MM = 0.3;

export interface CompareResult {
  file: string;
  baseline: { supports: number; tips: number; braces: number; twigs: number };
  graph: { supports: number; tips: number; braces: number; twigs: number };
  matched: number;
  missed: CbxSupport[];
  spurious: CbxSupport[];
  /** Every support the graph emitted, for absorption analysis. */
  graphSupports: CbxSupport[];
  baseSupports: CbxSupport[];
}

function countTips(list: CbxSupport[]): number {
  return list.reduce((n, s) => n + s.tips.length + (s.downwardTip ? 1 : 0), 0);
}

/**
 * Greedy nearest-pair match on pillar XY. Supports are far enough apart relative
 * to MATCH_TOL_MM that greedy and optimal agree; this keeps the report readable.
 */
function matchByPillarXY(base: CbxSupport[], graph: CbxSupport[]) {
  const takenGraph = new Set<number>();
  const missed: CbxSupport[] = [];
  let matched = 0;
  for (const b of base) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < graph.length; i++) {
      if (takenGraph.has(i)) continue;
      const d = Math.hypot(graph[i].pillarX - b.pillarX, graph[i].pillarY - b.pillarY);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0 && bestD <= MATCH_TOL_MM) { takenGraph.add(best); matched++; }
    else missed.push(b);
  }
  const spurious = graph.filter((_, i) => !takenGraph.has(i));
  return { matched, missed, spurious };
}

export function compareFile(file: string): CompareResult {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

  // Baseline: the shipping chain builder, capturing the blocks it resolved so
  // the graph runs on exactly the same bytes.
  cbxDebugBlocks.capture = [];
  const parsed = CbxParser.parseBuffer(ab, file);
  const blocks = cbxDebugBlocks.capture;
  cbxDebugBlocks.capture = null;

  const baseSupports = parsed.models.flatMap((m) => m.supports);
  const baseBraces = parsed.models.flatMap((m) => m.braces ?? []);
  const baseTwigs = parsed.models.flatMap((m) => m.twigs ?? []);
  // A junction branch is a tip-bearing node in the chain model too, so its tips
  // must be counted or the graph looks like it is over-producing.
  const baseJbTips = parsed.models
    .flatMap((m) => m.junctionBranches ?? [])
    .reduce((n, j) => n + j.tips.length, 0);

  const view = new DataView(ab);
  const gSupports: CbxSupport[] = [];
  let gBraces = 0;
  let gTwigs = 0;
  let gJbTips = 0;
  for (const b of blocks) {
    const recs = decodeSupportBlockRecords(view, b.recBase, b.geoPtr, b.zOff);
    const graphRecs: GraphRecord[] = recs.map((r, i) => ({
      index: i,
      sub: r.sub,
      x: r.x, y: r.y, topZ: r.topZ,
      x2: r.x2, y2: r.y2, botZ: r.botZ,
      paramA: r.paramA, paramB: r.paramB,
    }));
    const graph = buildSupportGraph(graphRecs);
    const out = emitFromGraph(graph, graphRecs);
    gSupports.push(...out.supports);
    gBraces += out.braces.length;
    gTwigs += out.twigs.length;
    gJbTips += out.junctionBranches.reduce((n, j) => n + j.tips.length, 0);
  }

  const { matched, missed, spurious } = matchByPillarXY(baseSupports, gSupports);
  return {
    file,
    baseline: {
      supports: baseSupports.length,
      tips: countTips(baseSupports) + baseJbTips,
      braces: baseBraces.length,
      twigs: baseTwigs.length,
    },
    graph: {
      supports: gSupports.length,
      tips: countTips(gSupports) + gJbTips,
      braces: gBraces,
      twigs: gTwigs,
    },
    matched, missed, spurious,
    graphSupports: gSupports,
    baseSupports,
  };
}

if (process.argv[1] && process.argv[1].endsWith('compareGraph.ts')) {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const files = args.filter((a) => !a.startsWith('--'));
  if (files.length === 0) {
    console.error('usage: npx tsx compareGraph.ts <file.chitubox> [--verbose]');
    process.exit(2);
  }
  for (const f of files) {
    const r = compareFile(f);
    const b = r.baseline, g = r.graph;
    console.log(`\n${r.file}`);
    console.log(`  baseline  ${String(b.supports).padStart(4)} supports, ${String(b.tips).padStart(4)} tips, ${String(b.braces).padStart(4)} braces, ${b.twigs} twigs`);
    console.log(`  graph     ${String(g.supports).padStart(4)} supports, ${String(g.tips).padStart(4)} tips, ${String(g.braces).padStart(4)} braces, ${g.twigs} twigs`);
    console.log(`  matched by pillar XY (<${MATCH_TOL_MM}mm): ${r.matched} of ${b.supports}`);
    console.log(`  MISSED ${r.missed.length}      spurious ${r.spurious.length}`);
    if (verbose) {
      for (const m of r.missed.slice(0, 20)) {
        console.log(`    missed  x=${m.pillarX.toFixed(3)} y=${m.pillarY.toFixed(3)} topZ=${m.pillarTopZ.toFixed(3)} botZ=${m.pillarBottomZ.toFixed(3)} tips=${m.tips.length}`);
      }
      for (const s of r.spurious.slice(0, 20)) {
        console.log(`    spurious x=${s.pillarX.toFixed(3)} y=${s.pillarY.toFixed(3)} topZ=${s.pillarTopZ.toFixed(3)} botZ=${s.pillarBottomZ.toFixed(3)} tips=${s.tips.length}`);
      }
    }
  }
}
