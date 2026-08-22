/**
 * Emit importer entities from a support graph.
 *
 * The graph (supportGraph.ts) says what is connected to what. This pass says
 * what to build from it, in the CbxSupport / CbxBrace / CbxTwig vocabulary the
 * converter already consumes, so it can stand in for the chain builder rather
 * than requiring a parallel pipeline.
 *
 * # The decomposition
 *
 * The previous emitter walked a path from each model contact down to ground and
 * called the longest shaft on that path the pillar. That collapses on trees: in
 * a tree several contacts share a trunk, resolve to the same pillar edge, and
 * only one survives. On NOSFERATU it produced 57 supports against 80, dropping
 * 26, because 83 of that file's 109 contacts live inside `tree` components.
 *
 * The rule here is structural instead of path-based:
 *
 *   a PILLAR is a maximal run of VERTICAL sub-3 edges
 *   a BRACE  is a DIAGONAL sub-3 edge
 *   a TIP    attaches to the pillar its authored socket lands on
 *   a TWIG   is a sub-12 edge (both ends on the model)
 *
 * A pillar is therefore an object in its own right rather than a by-product of
 * walking from some contact, so contacts sharing a trunk no longer compete: each
 * lands on whichever pillar it actually meets. Measured on NOSFERATU before any
 * emission: 79 maximal vertical runs against 80 authored supports, 112 diagonal
 * edges against 111 authored braces, 109 sub-1 records against 109 authored
 * tips. The structure falls out of the geometry.
 *
 * Verticality is used here as a SHAPE test, to cut the graph into runs, which is
 * what it is reliable for. It is deliberately NOT used as a load test: the
 * handoff records that requiring a vertical pillar during path selection dropped
 * 23% of supports. Those are different jobs, and nothing below walks a path.
 *
 * # Mid-air pillars
 *
 * A run that reaches no ground node is not an error. CHITUBOX builds multi-level
 * trees in which a pillar starts mid-air where braces converge; the chain
 * builder models this as `isForkJunction`, and the converter emits such a pillar
 * as a Branch parented to the convergence knot instead of a grounded trunk with
 * a root cup floating in space. 19 of NOSFERATU's 80 supports are of this kind,
 * so runs are flagged the same way here.
 *
 * # About the brace label
 *
 * Brace-vs-structure is not recoverable from the file: the host never tests
 * `sub`, braces and pillars draw as identical 60-triangle cylinders, and radius
 * does not separate them (0.40 is the most common value in both classes). The
 * label is ours to define. Defining it as "diagonal" is a shape statement, and
 * it reproduces the authored brace count to within one on NOSFERATU, which the
 * previous load-based definition ("an edge no support path walked") did not.
 */

import type { CbxBrace, CbxJunctionBranch, CbxSupport, CbxTip, CbxTwig } from './types';
import type { SupportGraph, GraphNode, GraphEdge } from './supportGraph';

/**
 * XY offset under which a sub-3 edge is a pillar segment outright.
 *
 * Authored pillars are dead vertical: 12,193 of 25,150 sub-3 records across the
 * corpus carry EXACTLY identical endpoint XY. This only has to absorb float
 * round-trip, not a real spread.
 */
const VERTICAL_XY_TOL_MM = 0.05;

/**
 * Slope (XY run over Z rise) under which a longer edge still counts as one
 * pillar segment.
 *
 * Distance alone cannot make this call. Short sub-3 records come in two kinds
 * that overlap completely in length but not in angle, and treating the second
 * kind as pillar merges two real supports into one run:
 *
 *   - a genuine pillar segment, which is vertical
 *   - a stub joining the tops of two ADJACENT pillars, which runs at ~45°
 *
 * Measured over every sub-3 record with a non-zero XY span of 0.3mm or less:
 * 427 of 430 sit at slope 0.9–1.5 (i.e. ~45°), 2 are near horizontal, and
 * exactly 1 is near vertical. The two populations are cleanly separated by
 * angle, so angle is what decides.
 */
const VERTICAL_SLOPE_MAX = 0.2;

/** How close a tip's authored socket must sit to a pillar to attach to it. */
const TIP_ATTACH_XY_TOL_MM = 0.4;
const TIP_ATTACH_Z_TOL_MM = 0.6;

/** Socket tolerance for the downward cone of a model-standing stick. */
const DOWN_ATTACH_XY_TOL_MM = 0.5;
const DOWN_ATTACH_Z_TOL_MM = 0.15;

/** A pillar bottom this far above the plate is mid-air rather than grounded. */
const MID_AIR_MM = 1.5;

/** Only lower a pillar onto its foot when there is a real gap to close. */
const FOOT_GAP_MIN_MM = 0.05;

/**
 * How far above the plate a support may end and still be extended down to it.
 *
 * CHITUBOX grounds a support on a wide sub-5 foot disk, and several feet often
 * cluster into a raised platform. We do not reproduce the feet or that platform
 * -- DF generates its own raft -- so a support that stood on one is left ending
 * in mid-air above DF's plate.
 *
 * Measured on guns.chitubox, the gaps are authored standoffs rather than noise:
 * they cluster at 1.20, 2.50 and 2.80mm, with a maximum of 6.97mm. 8mm covers
 * every one while staying far below the shortest genuine mid-air pillar, which
 * is held aloft by braces rather than hovering just over the plate.
 */
const PLATE_REACH_MAX_MM = 8.0;

export interface GraphEmitResult {
  supports: CbxSupport[];
  braces: CbxBrace[];
  twigs: CbxTwig[];
  /** Tip-bearing knots with no pillar, rebuilt as branches by the converter. */
  junctionBranches: CbxJunctionBranch[];
  /** Parts the emitter could not place, for reporting. */
  skipped: { kind: string; reason: string }[];
}

/** The record fields the emitter reads. Indices match the graph's `index`. */
export interface EmitRecord {
  sub: number;
  x: number; y: number; topZ: number;
  x2: number; y2: number; botZ: number;
  paramA: number;
  paramB: number;
  /** Contact penetration depth, when the caller has it (a tip's `extra`). */
  extra?: number;
}

function isGrounded(n: GraphNode): boolean {
  return n.feet.length > 0 || n.bases.length > 0 || n.onGroundPlane === true;
}

function isVertical(graph: SupportGraph, e: GraphEdge): boolean {
  const a = graph.nodes[e.a];
  const b = graph.nodes[e.b];
  const dxy = Math.hypot(a.x - b.x, a.y - b.y);
  if (dxy <= VERTICAL_XY_TOL_MM) return true;
  // Past the noise floor, decide on angle rather than length: a stub joining two
  // adjacent pillar tops is short but runs at ~45°, and folding it into a run
  // would weld two separate supports together.
  const dz = Math.abs(a.z - b.z);
  if (dz <= 1e-6) return false;
  return dxy / dz <= VERTICAL_SLOPE_MAX;
}

/** One physical pillar: a maximal run of vertical sub-3 edges. */
interface VerticalRun {
  topNode: number;
  bottomNode: number;
  /** Every node on the run, so a tip can attach at an interior T-junction. */
  nodes: number[];
  /** Widest authored radius on the run — the shaft radius. */
  radius: number;
}

/**
 * Glue the vertical sub-3 edges back into whole pillars.
 *
 * The graph splits a shaft at every T-junction, so one authored pillar arrives
 * as several collinear edges — 149 edges over 79 pillars on NOSFERATU. Union-find
 * over the vertical edges reassembles them.
 */
function verticalRuns(graph: SupportGraph): VerticalRun[] {
  const parent = new Int32Array(graph.nodes.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) { const nx = parent[x]; parent[x] = r; x = nx; }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (const e of graph.edges) {
    if (e.sub !== 3 || !isVertical(graph, e)) continue;
    union(e.a, e.b);
  }

  // Roots are only stable once every union is done, so group in a second pass.
  const members = new Map<number, Set<number>>();
  const radiusOf = new Map<number, number>();
  for (const e of graph.edges) {
    if (e.sub !== 3 || !isVertical(graph, e)) continue;
    const root = find(e.a);
    let set = members.get(root);
    if (!set) { set = new Set<number>(); members.set(root, set); }
    set.add(e.a);
    set.add(e.b);
    const r = Math.max(e.radiusA, e.radiusB);
    radiusOf.set(root, Math.max(radiusOf.get(root) ?? 0, r));
  }

  const runs: VerticalRun[] = [];
  for (const [root, set] of members) {
    const nodes = [...set];
    let top = nodes[0];
    let bottom = nodes[0];
    for (const id of nodes) {
      if (graph.nodes[id].z > graph.nodes[top].z) top = id;
      if (graph.nodes[id].z < graph.nodes[bottom].z) bottom = id;
    }
    runs.push({ topNode: top, bottomNode: bottom, nodes, radius: radiusOf.get(root) ?? 0 });
  }
  return runs;
}

/** The sphere radius decorating a node — the knot diameter authored there. */
function knotDiameterAt(node: GraphNode, records: EmitRecord[]): number {
  let best = 0;
  for (const idx of node.spheres) {
    const r = records[idx];
    if (r && r.paramA * 2 > best) best = r.paramA * 2;
  }
  return best;
}

/**
 * Build a tip from its record.
 *
 * The authored cone length is the full 3D slant from socket to contact, not the
 * Z gap: most tips are steeply slanted, and the Z-only value understates the
 * length badly enough that the contact renders at the wrong angle.
 */
function tipFromRecord(r: EmitRecord): CbxTip {
  const dx = r.x - r.x2;
  const dy = r.y - r.y2;
  const dz = r.topZ - r.botZ;
  return {
    x: r.x,
    y: r.y,
    contactZ: r.topZ,
    attachZ: r.botZ,
    socketX: r.x2,
    socketY: r.y2,
    length: Math.sqrt(dx * dx + dy * dy + dz * dz),
    contactDiameter: r.paramA * 2,
    bodyDiameter: r.paramB * 2,
    contactDepth: r.extra ?? 0,
  };
}

/**
 * Emit entities for one block.
 *
 * `records` must be the array the graph was built from — edge and sphere indices
 * refer into it.
 */
export function emitFromGraph(
  graph: SupportGraph,
  records: EmitRecord[],
): GraphEmitResult {
  const supports: CbxSupport[] = [];
  const braces: CbxBrace[] = [];
  const twigs: CbxTwig[] = [];
  const skipped: { kind: string; reason: string }[] = [];

  const runs = verticalRuns(graph);

  // Plate Z: the lowest run bottom in the block. A run starting well above it is
  // mid-air, which is an authored shape (a fork junction), not a failure.
  let plateZ = Infinity;
  for (const run of runs) {
    const z = graph.nodes[run.bottomNode].z;
    if (z < plateZ) plateZ = z;
  }
  if (!Number.isFinite(plateZ)) plateZ = 0;

  // --- Tips ---
  //
  // Each tip's authored socket (P2) is its attach point, so placing a tip is a
  // lookup rather than a search over paths. A tip can meet a pillar at an
  // interior T-junction as well as at its top, so every node on a run is a
  // candidate: that is what lets several contacts share one trunk.
  const attachPoints: { runIdx: number; x: number; y: number; z: number }[] = [];
  for (let i = 0; i < runs.length; i++) {
    for (const nodeId of runs[i].nodes) {
      const n = graph.nodes[nodeId];
      attachPoints.push({ runIdx: i, x: n.x, y: n.y, z: n.z });
    }
  }

  const tipsByRun = new Map<number, CbxTip[]>();
  const downByRun = new Map<number, CbxTip>();
  /** Tips whose socket is not on any pillar — they belong to a junction knot. */
  const junctionTips: EmitRecord[] = [];

  for (const r of records) {
    if (r.sub !== 1) continue;

    // A cone whose contact sits BELOW its socket points down onto the model: it
    // is the model-standing foot of a stick, and belongs to the run whose bottom
    // it hangs from rather than to the upward tip set.
    //
    // Only the FIRST such cone per run is kept: a support has one foot, and the
    // chain builder likewise takes one. A second match is a different structure
    // that happens to end nearby, so it falls through to the junction pass
    // rather than silently replacing the foot already found.
    if (r.topZ < r.botZ) {
      let placed = false;
      for (let i = 0; i < runs.length; i++) {
        if (downByRun.has(i)) continue;
        const bn = graph.nodes[runs[i].bottomNode];
        if (Math.hypot(r.x2 - bn.x, r.y2 - bn.y) > DOWN_ATTACH_XY_TOL_MM) continue;
        if (Math.abs(r.botZ - bn.z) > DOWN_ATTACH_Z_TOL_MM) continue;
        downByRun.set(i, tipFromRecord(r));
        placed = true;
        break;
      }
      // A downward cone hanging off a junction knot rather than a pillar bottom
      // is still a real contact; let the junction pass claim it.
      if (!placed) junctionTips.push(r);
      continue;
    }

    let best = -1;
    let bestD = Infinity;
    for (const ap of attachPoints) {
      const dxy = Math.hypot(r.x2 - ap.x, r.y2 - ap.y);
      if (dxy > TIP_ATTACH_XY_TOL_MM) continue;
      const dz = Math.abs(r.botZ - ap.z);
      if (dz > TIP_ATTACH_Z_TOL_MM) continue;
      const d = dxy + dz;
      if (d < bestD) { bestD = d; best = ap.runIdx; }
    }
    if (best < 0) { junctionTips.push(r); continue; }
    const list = tipsByRun.get(best);
    if (list) list.push(tipFromRecord(r));
    else tipsByRun.set(best, [tipFromRecord(r)]);
  }

  // --- Braces: diagonal sub-3 edges ---
  //
  // Emitted from the RECORD, not the graph edge: the graph splits a strut at
  // every T-junction, and emitting each half would double-count one physical
  // brace and leave a knot floating at the split.
  const diagonalRecords = new Set<number>();
  for (const e of graph.edges) {
    if (e.sub !== 3 || isVertical(graph, e)) continue;
    diagonalRecords.add(e.index);
  }
  // Emission is deferred until the junction pass below has claimed its feeders:
  // a diagonal that carries a junction branch becomes that branch's shaft, and
  // emitting it as a brace as well would build one physical strut twice.
  const consumedFeeders = new Set<number>();

  // --- Junction branches: tip-bearing knots with no pillar of their own ---
  //
  // CHITUBOX builds multi-level trees whose upper tier hangs off a knot that is
  // reached by a diagonal alone, with the tips fanning out from there. Such a
  // tip sockets onto a brace endpoint rather than onto any pillar, so the block
  // above cannot place it: measured across the corpus, ALL 868 tips that match
  // no pillar socket onto a diagonal endpoint, and none onto anything else.
  //
  // The converter already models this as a Branch parented to the pillar the
  // feeding brace comes from (see CbxJunctionBranch), so the whole upper tier is
  // recoverable rather than dropped.
  const junctionBranches: CbxJunctionBranch[] = [];
  if (junctionTips.length > 0) {
    // Group the loose tips by the junction point they share.
    const groups = new Map<string, { x: number; y: number; z: number; tips: EmitRecord[] }>();
    for (const r of junctionTips) {
      const key = `${Math.round(r.x2 / 0.1)}:${Math.round(r.y2 / 0.1)}:${Math.round(r.botZ / 0.1)}`;
      const g = groups.get(key);
      if (g) g.tips.push(r);
      else groups.set(key, { x: r.x2, y: r.y2, z: r.botZ, tips: [r] });
    }

    for (const g of groups.values()) {
      // The feeding brace: a diagonal with one end at the junction. Its OTHER end
      // is where the branch attaches to the structure below.
      const reachesPillar = (p: { x: number; y: number; z: number }): boolean =>
        attachPoints.some((ap) =>
          Math.hypot(ap.x - p.x, ap.y - p.y) <= TIP_ATTACH_XY_TOL_MM
          && Math.abs(ap.z - p.z) <= TIP_ATTACH_Z_TOL_MM);

      let parent: { x: number; y: number; z: number } | null = null;
      let diameter = 0;
      let parentOnPillar = false;
      let feederIdx = -1;
      for (const idx of diagonalRecords) {
        if (parentOnPillar) break;
        const r = records[idx];
        if (!r) continue;
        for (const e of [
          { at: { x: r.x, y: r.y, z: r.topZ }, other: { x: r.x2, y: r.y2, z: r.botZ } },
          { at: { x: r.x2, y: r.y2, z: r.botZ }, other: { x: r.x, y: r.y, z: r.topZ } },
        ]) {
          if (Math.hypot(e.at.x - g.x, e.at.y - g.y) > TIP_ATTACH_XY_TOL_MM) continue;
          if (Math.abs(e.at.z - g.z) > TIP_ATTACH_Z_TOL_MM) continue;
          // Prefer a feeder whose far end reaches a real pillar, so the branch has
          // something to parent to; a feeder that only reaches another diagonal is
          // kept as a fallback rather than discarded.
          const onPillar = reachesPillar(e.other);
          if (parent && !onPillar) continue;
          parent = e.other;
          diameter = r.paramA * 2;
          parentOnPillar = onPillar;
          feederIdx = idx;
          if (onPillar) break;
        }
      }
      if (!parent) {
        skipped.push({ kind: 'junction', reason: `${g.tips.length} tips: no feeding brace` });
        continue;
      }
      if (feederIdx >= 0) consumedFeeders.add(feederIdx);
      junctionBranches.push({
        junctionX: g.x, junctionY: g.y, junctionZ: g.z,
        parentX: parent.x, parentY: parent.y, parentZ: parent.z,
        diameter,
        tips: g.tips.map(tipFromRecord),
      });
    }
  }

  // Now that junction feeders are known, emit every diagonal that is not one.
  for (const idx of diagonalRecords) {
    if (consumedFeeders.has(idx)) continue;
    const r = records[idx];
    if (!r) continue;
    braces.push({
      ax: r.x, ay: r.y, az: r.topZ,
      bx: r.x2, by: r.y2, bz: r.botZ,
      diameter: r.paramA * 2,
    });
  }

  // --- Twigs: model-to-model struts, one per record. ---
  const twigRecords = new Set<number>();
  for (const e of graph.edges) {
    if (e.sub !== 12) continue;
    twigRecords.add(e.index);
  }
  for (const idx of twigRecords) {
    const r = records[idx];
    if (!r) continue;
    twigs.push({
      ax: r.x, ay: r.y, az: r.topZ,
      bx: r.x2, by: r.y2, bz: r.botZ,
      diameter: r.paramA * 2,
    });
  }

  // --- Pillars ---
  //
  // A run with no tip and no brace touching it is an interior strut that neither
  // reaches the model nor anchors anything. The chain builder drops those too.
  const braceTouchesRun = (run: VerticalRun): boolean => {
    for (const nodeId of run.nodes) {
      for (const ei of graph.nodes[nodeId].edges) {
        const e = graph.edges[ei];
        if (e.sub === 3 && !isVertical(graph, e)) return true;
      }
    }
    return false;
  };

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    // Tallest-first, so the primary tip is chosen deterministically.
    const tips = (tipsByRun.get(i) ?? []).sort((a, b) => b.contactZ - a.contactZ);
    const down = downByRun.get(i);
    if (tips.length === 0 && !down && !braceTouchesRun(run)) {
      skipped.push({ kind: 'pillar', reason: 'no tip and no brace' });
      continue;
    }

    const top = graph.nodes[run.topNode];
    const bottom = graph.nodes[run.bottomNode];

    // Mid-air with nothing grounding it: a branch growing out of a brace
    // convergence rather than a trunk. Emitting it as a trunk would plant a root
    // cup in mid-air, which the support model never allows.
    const fork = bottom.z - plateZ > MID_AIR_MM && !isGrounded(bottom);

    // A base pad, when the run's bottom node carries one.
    let base: CbxSupport['base'] = null;
    for (const idx of bottom.bases) {
      const r = records[idx];
      if (!r) continue;
      base = {
        topRadius: r.paramA,
        bottomRadius: r.paramB,
        topZ: Math.max(r.topZ, r.botZ),
        bottomZ: Math.min(r.topZ, r.botZ),
      };
      break;
    }

    // Ground onto the foot when a sub-5 foot sits below the run.
    let pillarBottomZ = bottom.z;
    let footed = false;
    for (const idx of bottom.feet) {
      const r = records[idx];
      if (!r) continue;
      const footBottom = Math.min(r.topZ, r.botZ);
      if (pillarBottomZ - footBottom > FOOT_GAP_MIN_MM) pillarBottomZ = footBottom;
      footed = true;
      break;
    }

    // No foot of its own, but ending just above the plate: extend it down.
    // These are the supports that stood on a foot cluster we do not reproduce.
    // Only the run's own bottom moves -- the knot, tips and pillar top are
    // untouched, so model contact is unchanged.
    if (!footed) {
      const gap = pillarBottomZ - plateZ;
      if (gap > FOOT_GAP_MIN_MM && gap <= PLATE_REACH_MAX_MM) pillarBottomZ = plateZ;
    }

    supports.push({
      pillarDiameter: run.radius * 2,
      pillarTopZ: top.z,
      pillarBottomZ,
      pillarX: top.x,
      pillarY: top.y,
      knotCenterZ: top.z,
      knotDiameter: knotDiameterAt(top, records) || run.radius * 2,
      base,
      tips,
      isForkJunction: fork,
      downwardTip: down,
    });
  }

  return { supports, braces, twigs, junctionBranches, skipped };
}
