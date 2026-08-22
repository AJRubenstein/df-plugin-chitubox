/**
 * Endpoint graph over a support block's parametric records.
 *
 * CHITUBOX does not encode a support as a chain. Its reader walks a flat record
 * array and rebuilds structure geometrically, and the records themselves are
 * emitted out of order (a pillar can appear after the tips that reference it,
 * and unrelated supports interleave). The only connectivity in the file is
 * coincidence: two records belong to the same support when they share an
 * endpoint, exactly.
 *
 * So the honest model is an undirected graph:
 *
 *   nodes  = distinct endpoints (quantised; real coincidences are exact)
 *   edges  = shaft-like records (sub 1, 2, 3, 12)
 *   caps   = sphere records (sub 7, 8, 9) decorating the node at their CENTRE
 *   anchors= feet (sub 5) and bases (sub 4) pinning whichever node they touch
 *
 * A node of degree > 2 is a branch point. That is the multi-tip junction the
 * chain builder has to special-case; here it falls out of the structure.
 *
 * Measured over 161 files / 72,974 records:
 *   - sphere |P1-P2| == 2*r1 in 15,768 / 15,768 (they are DIAMETER segments,
 *     so the joint is at the centre, not at either pole)
 *   - sphere centre lands on a shaft endpoint in 15,767 / 15,768 (0.000mm)
 *   - 67,468 distinct nodes: 76.3% degree 1, 16.4% degree 2, 7.4% degree > 2
 */

/** Quantisation for endpoint identity, in mm. Coincidences in the file are exact. */
const NODE_EPSILON_MM = 1e-3;

/**
 * Perpendicular distance under which a free endpoint is taken to land ON another
 * shaft rather than merely near it.
 *
 * Most authored T-junctions are exact -- 36.6% of free endpoints sit at <=0.05mm
 * -- but a second, smaller population sits at 0.2-0.5mm (1.7%), separated from
 * the first by a near-empty band (0.1% between 0.05 and 0.2). Those are real
 * joins too: a diagonal strut in guns.chitubox anchors 0.368mm off its host
 * pillar at t=0.198, and at a 0.05 tolerance it missed and the strut ran on
 * across the model to find something else.
 *
 * 0.5 spans both populations and stops short of the 0.5-1.0mm band (9.6%), which
 * is where unrelated neighbouring shafts start to appear.
 */
const T_JUNCTION_TOL_MM = 0.5;

/** How far along a host segment a T-junction must sit to count as interior. */
const T_JUNCTION_MIN_T = 0.001;

/**
 * Radius within which an endpoint is taken to be held by an anchor.
 *
 * Anchors are authored at a small but consistent standoff, not coincident: the
 * MINIMUM gap across 9,781 anchors is 0.00200mm and the median is the same, so a
 * 1e-3 node quantisation loses every one of them. 0.05 captures 87.8%; widening
 * to 0.6 adds five anchors in the whole corpus, so the remaining 12% are a
 * different relationship rather than a wider spread of the same one.
 */
const ANCHOR_TOL_MM = 0.05;

/**
 * An endpoint sitting on the anchor ground plane is grounded even when no
 * individual anchor record is within ANCHOR_TOL_MM: 98.5% of otherwise
 * unresolved pillar ends are exactly on that plane. Treating them as isolated
 * fragments a support that is in fact standing on the plate.
 */
const GROUND_PLANE_TOL_MM = 0.01;

/** Records whose two endpoints describe a span: tips, pillars, braces, twigs. */
export const SHAFT_SUBS = new Set([1, 2, 3, 12]);
/** Records that are a sphere expressed as a diameter segment. */
export const SPHERE_SUBS = new Set([7, 8, 9]);

export interface GraphRecord {
  /** Index into the block's record array — the caller's handle back to it. */
  index: number;
  sub: number;
  x: number; y: number; topZ: number;
  x2: number; y2: number; botZ: number;
  paramA: number;
  paramB: number;
}

export interface GraphNode {
  id: number;
  x: number; y: number; z: number;
  /** Edge indices incident on this node. */
  edges: number[];
  /** Sphere records centred here; the largest gives the joint radius. */
  spheres: number[];
  /** Foot (sub-5) records touching this node — it is on the plate. */
  feet: number[];
  /** Base (sub-4) records touching this node. */
  bases: number[];
  /** True when this node is level with the anchor ground plane. */
  onGroundPlane?: boolean;
}

export interface GraphEdge {
  /** Index into the block's record array. */
  index: number;
  sub: number;
  /** Node at (x, y, topZ). */
  a: number;
  /** Node at (x2, y2, botZ). */
  b: number;
  /** Radius at endpoint a / b, from the record's paramA / paramB. */
  radiusA: number;
  radiusB: number;
  lengthMm: number;
}

export interface SupportGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Connected components, each a list of node ids. One per support. */
  components: number[][];
}

function keyOf(x: number, y: number, z: number): string {
  const q = (v: number) => Math.round(v / NODE_EPSILON_MM);
  return `${q(x)}:${q(y)}:${q(z)}`;
}

function dist(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dx = ax - bx, dy = ay - by, dz = az - bz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Perpendicular distance from a point to a segment, plus the contact parameter. */
function pointToSegment(
  px: number, py: number, pz: number,
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): { d: number; t: number } {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const len2 = dx * dx + dy * dy + dz * dz;
  if (len2 < 1e-12) return { d: dist(px, py, pz, a.x, a.y, a.z), t: 0 };
  const t = ((px - a.x) * dx + (py - a.y) * dy + (pz - a.z) * dz) / len2;
  const tc = t < 0 ? 0 : t > 1 ? 1 : t;
  return { d: dist(px, py, pz, a.x + dx * tc, a.y + dy * tc, a.z + dz * tc), t };
}

/**
 * Build the endpoint graph for one support block.
 *
 * `records` should be every decoded record in the block, in file order, with the
 * summary (sub-6) already dropped — its coordinates are sentinels, not a placed
 * part. Z is expected to already be in whatever frame the caller wants back.
 */
export function buildSupportGraph(records: GraphRecord[]): SupportGraph {
  const nodes: GraphNode[] = [];
  const byKey = new Map<string, number>();

  const nodeAt = (x: number, y: number, z: number): number => {
    const k = keyOf(x, y, z);
    const hit = byKey.get(k);
    if (hit !== undefined) return hit;
    const id = nodes.length;
    byKey.set(k, id);
    nodes.push({ id, x, y, z, edges: [], spheres: [], feet: [], bases: [] });
    return id;
  };

  // Edges first, so every node a sphere or anchor might decorate already exists.
  const edges: GraphEdge[] = [];
  for (const r of records) {
    if (!SHAFT_SUBS.has(r.sub)) continue;
    const a = nodeAt(r.x, r.y, r.topZ);
    const b = nodeAt(r.x2, r.y2, r.botZ);
    if (a === b) continue; // degenerate: both endpoints quantise together
    const edgeIdx = edges.length;
    edges.push({
      index: r.index,
      sub: r.sub,
      a,
      b,
      radiusA: r.paramA,
      radiusB: r.paramB,
      lengthMm: dist(r.x, r.y, r.topZ, r.x2, r.y2, r.botZ),
    });
    nodes[a].edges.push(edgeIdx);
    nodes[b].edges.push(edgeIdx);
  }

  // T-junctions. A third of all joins are a shaft ending part-way ALONG another
  // shaft rather than at its end, so an endpoint-only graph drops them and every
  // branched support falls apart. Split the host edge at the contact parameter
  // and rewire both halves through the new node.
  //
  // Measured over the corpus: of 50,300 pillar endpoints, 42.4% match an
  // endpoint, 37.4% are T-junctions, 17.0% land on an anchor.
  const splitEdgeAt = (edgeIdx: number, nodeId: number): void => {
    const e = edges[edgeIdx];
    if (e.a === nodeId || e.b === nodeId) return;
    const tail = e.b;
    // Shorten the original to a..node, then add node..tail as a new edge so the
    // record stays represented by both halves.
    e.b = nodeId;
    const bEdges = nodes[tail].edges;
    const at = bEdges.indexOf(edgeIdx);
    if (at >= 0) bEdges.splice(at, 1);
    nodes[nodeId].edges.push(edgeIdx);
    const half: GraphEdge = {
      index: e.index,
      sub: e.sub,
      a: nodeId,
      b: tail,
      radiusA: e.radiusA,
      radiusB: e.radiusB,
      lengthMm: dist(
        nodes[nodeId].x, nodes[nodeId].y, nodes[nodeId].z,
        nodes[tail].x, nodes[tail].y, nodes[tail].z,
      ),
    };
    const halfIdx = edges.length;
    edges.push(half);
    nodes[nodeId].edges.push(halfIdx);
    nodes[tail].edges.push(halfIdx);
  };

  // Snapshot: only endpoints that exist before this pass can be T-junction
  // sources, and splitting appends edges we must not re-scan.
  const edgeCountBeforeSplits = edges.length;
  for (let nodeId = 0; nodeId < nodes.length; nodeId++) {
    const nd = nodes[nodeId];
    if (nd.edges.length !== 1) continue; // only a free end can be a T source
    let best: { edge: number; d: number } | null = null;
    for (let e = 0; e < edgeCountBeforeSplits; e++) {
      if (nd.edges.includes(e)) continue;
      const ea = nodes[edges[e].a];
      const eb = nodes[edges[e].b];
      const { d, t } = pointToSegment(nd.x, nd.y, nd.z, ea, eb);
      if (t <= T_JUNCTION_MIN_T || t >= 1 - T_JUNCTION_MIN_T) continue;
      if (d > T_JUNCTION_TOL_MM) continue;
      if (!best || d < best.d) best = { edge: e, d };
    }
    if (best) splitEdgeAt(best.edge, nodeId);
  }

  // Spheres decorate the node at their CENTRE. They are never edges: P1 and P2
  // are opposite poles of one sphere, so |P1-P2| is a diameter, not a span.
  for (const r of records) {
    if (!SPHERE_SUBS.has(r.sub)) continue;
    const cx = (r.x + r.x2) / 2;
    const cy = (r.y + r.y2) / 2;
    const cz = (r.topZ + r.botZ) / 2;
    const k = keyOf(cx, cy, cz);
    const hit = byKey.get(k);
    // Only attach to an EXISTING node. A sphere centred where no shaft ends is
    // decoration with nothing to decorate, and inventing a node for it would
    // add a degree-0 component the chain logic would then have to discard.
    if (hit !== undefined) nodes[hit].spheres.push(r.index);
  }

  // Feet and bases anchor whichever node they touch. Unlike shafts and spheres
  // these are NOT authored coincident -- a foot pole typically sits ~0.8mm from
  // the pillar end it grounds -- so this needs a real radius, not an exact key.
  const anchors = records.filter((r) => r.sub === 4 || r.sub === 5);
  for (const r of anchors) {
    let best: { node: number; d: number } | null = null;
    for (const nd of nodes) {
      const d = Math.min(
        dist(r.x, r.y, r.topZ, nd.x, nd.y, nd.z),
        dist(r.x2, r.y2, r.botZ, nd.x, nd.y, nd.z),
      );
      if (d <= ANCHOR_TOL_MM && (!best || d < best.d)) best = { node: nd.id, d };
    }
    if (!best) continue;
    if (r.sub === 5) nodes[best.node].feet.push(r.index);
    else nodes[best.node].bases.push(r.index);
  }

  // Ground plane. An endpoint level with the anchors' own bottom plane is
  // standing on the plate even when no anchor record is within ANCHOR_TOL_MM:
  // 98.5% of otherwise-unresolved pillar ends sit exactly on it. Without this
  // they look isolated and their support fragments.
  if (anchors.length > 0) {
    const planeVotes = new Map<number, number>();
    for (const r of anchors) {
      const key = Math.round(r.botZ / GROUND_PLANE_TOL_MM);
      planeVotes.set(key, (planeVotes.get(key) ?? 0) + 1);
    }
    let planeKey = 0;
    let planeBest = 0;
    for (const [k, v] of planeVotes) if (v > planeBest) { planeBest = v; planeKey = k; }
    const planeZ = planeKey * GROUND_PLANE_TOL_MM;
    for (const nd of nodes) {
      if (nd.feet.length > 0 || nd.bases.length > 0) continue;
      if (Math.abs(nd.z - planeZ) <= GROUND_PLANE_TOL_MM) nd.onGroundPlane = true;
    }
  }

  // Connected components: one per physically separate support.
  const seen = new Uint8Array(nodes.length);
  const components: number[][] = [];
  for (let start = 0; start < nodes.length; start++) {
    if (seen[start]) continue;
    const comp: number[] = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const id = stack.pop() as number;
      comp.push(id);
      for (const e of nodes[id].edges) {
        const other = edges[e].a === id ? edges[e].b : edges[e].a;
        if (!seen[other]) { seen[other] = 1; stack.push(other); }
      }
    }
    components.push(comp);
  }

  return { nodes, edges, components };
}

/** Nodes where more than two shafts meet — the branch points. */
export function branchNodes(graph: SupportGraph): GraphNode[] {
  return graph.nodes.filter((n) => n.edges.length > 2);
}

/** Nodes anchored to the plate by a foot, a base, or by sitting on the plane. */
export function groundedNodes(graph: SupportGraph): GraphNode[] {
  return graph.nodes.filter(
    (n) => n.feet.length > 0 || n.bases.length > 0 || n.onGroundPlane === true,
  );
}

/**
 * Bridge edges: those whose removal disconnects the graph.
 *
 * This is the load-path question — "is this edge the only route from here to
 * ground" — and it is the only defensible structural test available. The file
 * does not distinguish a brace from a pillar: the host never classifies `sub`,
 * both draw as identical 60-triangle cylinders, and radius does not separate
 * them (0.40 is the most common value in BOTH classes). So structure has to be
 * derived, and derived from load rather than from angle.
 *
 * Caveat worth stating: support graphs are overwhelmingly tree-shaped — one
 * measured block had 231 edges and only 10 independent cycles — so almost every
 * edge is a bridge. This is a good load-path test and a poor brace detector.
 * Treat "brace" as a presentation label, not a recovered fact.
 *
 * Iterative Tarjan; recursion would blow the stack on the larger blocks.
 */
export function bridgeEdges(graph: SupportGraph): Set<number> {
  const bridges = new Set<number>();
  const disc = new Int32Array(graph.nodes.length).fill(-1);
  const low = new Int32Array(graph.nodes.length);
  let timer = 0;

  for (let root = 0; root < graph.nodes.length; root++) {
    if (disc[root] !== -1) continue;
    // frame: node, parent edge, index into that node's edge list
    const stack: { v: number; pe: number; i: number }[] = [{ v: root, pe: -1, i: 0 }];
    disc[root] = low[root] = timer++;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const node = graph.nodes[top.v];
      if (top.i < node.edges.length) {
        const ei = node.edges[top.i++];
        if (ei === top.pe) continue; // do not walk back along the tree edge
        const e = graph.edges[ei];
        const to = e.a === top.v ? e.b : e.a;
        if (disc[to] === -1) {
          disc[to] = low[to] = timer++;
          stack.push({ v: to, pe: ei, i: 0 });
        } else if (disc[to] < low[top.v]) {
          low[top.v] = disc[to];
        }
      } else {
        stack.pop();
        const parent = stack.length ? stack[stack.length - 1] : null;
        if (parent) {
          if (low[top.v] < low[parent.v]) low[parent.v] = low[top.v];
          if (low[top.v] > disc[parent.v]) bridges.add(top.pe);
        }
      }
    }
  }
  return bridges;
}
