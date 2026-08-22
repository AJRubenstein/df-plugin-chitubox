/**
 * Classify the components of a support graph into the roles the importer needs.
 *
 * The graph (supportGraph.ts) says what is connected to what. This pass says
 * what each connected piece IS, using only measurable properties — never record
 * order, never a fixed grouping.
 *
 * Shape census over 161 files / 12,668 components, which is what these rules are
 * fitted to:
 *
 *   28.3%  1 pillar, no tip, ungrounded      -> a BRACE (97.7% diagonal, median 2.41mm)
 *   25.8%  1 tip + 1 pillar, grounded        -> the plain support
 *    7.7%  4+ tips, 1 pillar, 1 branch node  -> a FAN off a single shaft
 *    6.5%  4+ tips, 4+ pillars, 3+ branches  -> a TREE
 *    2.9%  1 twig, ungrounded                -> model-to-model TWIG
 *
 * The remainder are the same shapes with smaller tip counts.
 */

import type { SupportGraph, GraphNode } from './supportGraph';

/** XY offset above which a lone shaft is a diagonal strut rather than a pillar. */
const BRACE_XY_MIN_MM = 0.2;

export type ComponentKind =
  /** A diagonal strut between two other supports. Not a support in its own right. */
  | 'brace'
  /** A short strut whose both ends contact the model. */
  | 'twig'
  /**
   * Spans between two parts of the model instead of standing on the plate:
   * ungrounded, with a contact at each end. The .chitubox signature is a tip
   * pointing DOWN from the pillar bottom, which in graph terms is simply a
   * second contact on an ungrounded component.
   *
   * 324 across the corpus: 248 with exactly 2 contacts, the rest fanning to as
   * many as 11.
   */
  | 'stick'
  /** One contact, one shaft to the plate. */
  | 'simple'
  /** Several contacts radiating from one shared node. */
  | 'fan'
  /** Multiple shafts and branch points. */
  | 'tree'
  /** Grounded shaft with no contact — a stub the file authored but nothing uses. */
  | 'orphan';

export interface ClassifiedComponent {
  kind: ComponentKind;
  /** Node ids, as given by the graph. */
  nodes: number[];
  /** Edge indices belonging to this component. */
  edges: number[];
  /** Nodes carrying a model contact (a tip's free end). */
  contactNodes: number[];
  /** Nodes anchored to the plate. */
  groundNodes: number[];
  /** Nodes where more than two shafts meet. */
  branchNodes: number[];
}

function edgesOf(graph: SupportGraph, nodeIds: number[]): number[] {
  const set = new Set<number>();
  for (const id of nodeIds) for (const e of graph.nodes[id].edges) set.add(e);
  return [...set];
}

function isGrounded(n: GraphNode): boolean {
  return n.feet.length > 0 || n.bases.length > 0 || n.onGroundPlane === true;
}

/**
 * A tip's free end is where it meets the model: the endpoint of a sub-1/2 edge
 * that no other edge shares. The other end joins the structure.
 */
function contactNodesOf(graph: SupportGraph, nodeIds: number[], edges: number[]): number[] {
  const out: number[] = [];
  for (const id of nodeIds) {
    const nd = graph.nodes[id];
    if (nd.edges.length !== 1) continue;
    const e = graph.edges[nd.edges[0]];
    if (e.sub !== 1 && e.sub !== 2) continue;
    if (isGrounded(nd)) continue; // a tip that ends on the plate is not a contact
    out.push(id);
  }
  void edges;
  return out;
}

export function classifyComponent(graph: SupportGraph, nodeIds: number[]): ClassifiedComponent {
  const edges = edgesOf(graph, nodeIds);
  const subs = edges.map((e) => graph.edges[e].sub);
  const contactNodes = contactNodesOf(graph, nodeIds, edges);
  const groundNodes = nodeIds.filter((id) => isGrounded(graph.nodes[id]));
  const branchNodes = nodeIds.filter((id) => graph.nodes[id].edges.length > 2);

  const base: Omit<ClassifiedComponent, 'kind'> = {
    nodes: nodeIds, edges, contactNodes, groundNodes, branchNodes,
  };

  // A lone twig record is a model-to-model strut: both its ends are contacts.
  if (edges.length === 1 && subs[0] === 12) return { kind: 'twig', ...base };

  // A lone ungrounded shaft that runs diagonally is a brace between two other
  // supports. It carries no contact and stands on nothing, so it can only be
  // bracing. 3,497 of 3,579 such components are diagonal.
  if (edges.length === 1 && subs[0] === 3 && groundNodes.length === 0) {
    const e = graph.edges[edges[0]];
    const a = graph.nodes[e.a];
    const b = graph.nodes[e.b];
    if (Math.hypot(a.x - b.x, a.y - b.y) > BRACE_XY_MIN_MM) return { kind: 'brace', ...base };
  }

  // No model contact anywhere: nothing for this piece to hold up.
  if (contactNodes.length === 0) return { kind: 'orphan', ...base };

  // Ungrounded but contacting the model at more than one place: the structure is
  // held BY the model at both ends rather than by the plate. That is a stick,
  // and it must be tested before the fan/tree split, which assumes a grounded
  // shaft running down from the contacts.
  if (groundNodes.length === 0 && contactNodes.length >= 2) {
    return { kind: 'stick', ...base };
  }

  // Several shafts meeting at more than one place is a tree; at exactly one, a
  // fan. Both differ from 'simple' only in how many contacts share a shaft.
  if (branchNodes.length > 1) return { kind: 'tree', ...base };
  if (branchNodes.length === 1 || contactNodes.length > 1) return { kind: 'fan', ...base };
  return { kind: 'simple', ...base };
}

export function classifyGraph(graph: SupportGraph): ClassifiedComponent[] {
  return graph.components.map((c) => classifyComponent(graph, c));
}
