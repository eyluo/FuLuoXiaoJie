import type {
  EdgeRole,
  GraphDataset,
  GraphEdge,
  GraphNode,
  IndexedEdge,
  ProjectedGraph,
  SubgraphResult,
} from "./types.js";

const ROLE_PRIORITY: Record<EdgeRole, number> = {
  phonetic: 3,
  semantic: 2,
  structural: 1,
};

function resolveCanonical(id: string, variantMap: Record<string, string>): string {
  let cur = id;
  const seen = new Set<string>();
  while (Object.prototype.hasOwnProperty.call(variantMap, cur) && !seen.has(cur)) {
    seen.add(cur);
    cur = variantMap[cur]!;
  }
  return cur;
}

/**
 * Project a GraphDataset into a compact indexed DAG with optional live radical-variant merging.
 * Enforces strict acyclicity via Kahn's topological sort.
 */
export function projectGraph(dataset: GraphDataset, mergeVariants: boolean): ProjectedGraph {
  const originalIds = new Set(dataset.nodes.map((n) => n.id));
  const canonicalOf: Record<string, string> = {};
  const mergedFrom: Record<string, string[]> = {};

  for (const node of dataset.nodes) {
    if (!mergeVariants) {
      canonicalOf[node.id] = node.id;
    } else {
      const target = resolveCanonical(node.id, dataset.variantMap);
      const canon = originalIds.has(target) ? target : node.id;
      canonicalOf[node.id] = canon;
      if (canon !== node.id) {
        if (!mergedFrom[canon]) mergedFrom[canon] = [];
        mergedFrom[canon]!.push(node.id);
      }
    }
  }

  const keptNodes: GraphNode[] = [];
  const idToIndex = new Map<string, number>();

  for (const node of dataset.nodes) {
    if (canonicalOf[node.id] !== node.id) {
      continue;
    }
    const idx = keptNodes.length;
    idToIndex.set(node.id, idx);
    keptNodes.push(node);
  }

  // Deduplicate & combine parallel edges after optional variant contraction
  const edgeAccumulator = new Map<string, IndexedEdge>();
  for (const edge of dataset.edges) {
    const srcId = canonicalOf[edge.source];
    const dstId = canonicalOf[edge.target];
    if (!srcId || !dstId || srcId === dstId) {
      continue;
    }
    const sourceIdx = idToIndex.get(srcId);
    const targetIdx = idToIndex.get(dstId);
    if (sourceIdx === undefined || targetIdx === undefined) {
      continue;
    }
    const key = `${sourceIdx}:${targetIdx}`;
    const existing = edgeAccumulator.get(key);
    if (!existing) {
      edgeAccumulator.set(key, {
        sourceIdx,
        targetIdx,
        multiplicity: edge.multiplicity,
        role: edge.role,
      });
    } else {
      existing.multiplicity += edge.multiplicity;
      if (ROLE_PRIORITY[edge.role] > ROLE_PRIORITY[existing.role]) {
        existing.role = edge.role;
      }
    }
  }

  const n = keptNodes.length;
  const incoming: IndexedEdge[][] = Array.from({ length: n }, () => []);
  const outgoing: IndexedEdge[][] = Array.from({ length: n }, () => []);
  const indeg = new Int32Array(n);
  const edges: IndexedEdge[] = [];

  for (const e of edgeAccumulator.values()) {
    edges.push(e);
    outgoing[e.sourceIdx]!.push(e);
    incoming[e.targetIdx]!.push(e);
    indeg[e.targetIdx] = (indeg[e.targetIdx] ?? 0) + 1;
  }

  // Kahn's topological sort (components strictly before compounds)
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) {
    if (indeg[i] === 0) {
      queue[tail++] = i;
    }
  }

  const topoOrder = new Int32Array(n);
  let outPos = 0;
  while (head < tail) {
    const u = queue[head++]!;
    topoOrder[outPos++] = u;
    const outs = outgoing[u]!;
    for (let k = 0; k < outs.length; k++) {
      const v = outs[k]!.targetIdx;
      const nextDeg = (indeg[v] ?? 1) - 1;
      indeg[v] = nextDeg;
      if (nextDeg === 0) {
        queue[tail++] = v;
      }
    }
  }

  if (outPos !== n) {
    throw new Error(
      `Projected graph (mergeVariants=${mergeVariants}) is not a DAG: resolved ${outPos}/${n} nodes`
    );
  }

  return {
    mergeVariants,
    nodes: keptNodes,
    edges,
    idToIndex,
    incoming,
    outgoing,
    topoOrder,
    mergedFrom,
    canonicalOf,
  };
}

/**
 * Resolve an arbitrary glyph (including a contracted variant like "氵" when mergeVariants=true)
 * to its active node index in the projection.
 */
export function resolveNodeIndex(projected: ProjectedGraph, id: string): number | undefined {
  const direct = projected.idToIndex.get(id);
  if (direct !== undefined) return direct;
  const canon = projected.canonicalOf[id];
  return canon ? projected.idToIndex.get(canon) : undefined;
}

/**
 * Extract a focused neighborhood DAG around `focusId` for smooth browser visualization.
 * Negative distances are upstream components (prerequisites); positive distances are downstream compounds.
 */
export function extractSubgraph(
  projected: ProjectedGraph,
  focusId: string,
  upstreamDepth = 3,
  downstreamDepth = 1,
  maxNodes = 80,
  downstreamRankOrder?: Map<string, number>
): SubgraphResult {
  const focusIdx = resolveNodeIndex(projected, focusId);
  if (focusIdx === undefined) {
    return { focusId, nodes: [], edges: [], truncated: false };
  }
  const actualFocusId = projected.nodes[focusIdx]!.id;
  if (maxNodes <= 0) {
    return { focusId: actualFocusId, nodes: [], edges: [], truncated: true };
  }

  const distances = new Map<number, number>([[focusIdx, 0]]);
  let truncated = false;

  // 1. BFS upstream (all recursive prerequisites up to upstreamDepth)
  const upQueue: Array<{ idx: number; depth: number }> = [{ idx: focusIdx, depth: 0 }];
  while (upQueue.length > 0) {
    const cur = upQueue.shift()!;
    if (cur.depth >= upstreamDepth) continue;
    for (const e of projected.incoming[cur.idx]!) {
      if (!distances.has(e.sourceIdx)) {
        if (distances.size >= maxNodes) {
          truncated = true;
          break;
        }
        distances.set(e.sourceIdx, -(cur.depth + 1));
        upQueue.push({ idx: e.sourceIdx, depth: cur.depth + 1 });
      }
    }
    if (truncated) break;
  }

  // 2. BFS downstream (most important compounds first; always detect truncation at exact maxNodes boundary)
  const downQueue: Array<{ idx: number; depth: number }> = [{ idx: focusIdx, depth: 0 }];
  while (downQueue.length > 0) {
    const cur = downQueue.shift()!;
    if (cur.depth >= downstreamDepth) continue;
    const rawOuts = projected.outgoing[cur.idx]!;
    if (rawOuts.length === 0) continue;

    if (distances.size >= maxNodes) {
      // Check whether any unvisited downstream neighbor would be dropped
      for (const e of rawOuts) {
        if (!distances.has(e.targetIdx)) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
      continue;
    }

    const outs = [...rawOuts];
    outs.sort((a, b) => {
      if (downstreamRankOrder) {
        const ra = downstreamRankOrder.get(projected.nodes[a.targetIdx]!.id) ?? Number.MAX_SAFE_INTEGER;
        const rb = downstreamRankOrder.get(projected.nodes[b.targetIdx]!.id) ?? Number.MAX_SAFE_INTEGER;
        if (ra !== rb) return ra - rb;
      }
      return projected.nodes[b.targetIdx]!.freq.subtlexCount - projected.nodes[a.targetIdx]!.freq.subtlexCount;
    });
    for (const e of outs) {
      if (!distances.has(e.targetIdx)) {
        if (distances.size >= maxNodes) {
          truncated = true;
          break;
        }
        distances.set(e.targetIdx, cur.depth + 1);
        downQueue.push({ idx: e.targetIdx, depth: cur.depth + 1 });
      }
    }
    if (truncated) break;
  }

  const includedIndices = new Set(distances.keys());
  const subEdges: GraphEdge[] = [];
  for (const idx of includedIndices) {
    for (const e of projected.outgoing[idx]!) {
      if (includedIndices.has(e.targetIdx)) {
        subEdges.push({
          source: projected.nodes[e.sourceIdx]!.id,
          target: projected.nodes[e.targetIdx]!.id,
          multiplicity: e.multiplicity,
          role: e.role,
        });
      }
    }
  }

  const subNodes = Array.from(distances.entries()).map(([idx, distance]) => ({
    id: projected.nodes[idx]!.id,
    distance,
    node: projected.nodes[idx]!,
  }));

  return {
    focusId: actualFocusId,
    nodes: subNodes,
    edges: subEdges,
    truncated,
  };
}
