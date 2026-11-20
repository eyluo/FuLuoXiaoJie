import { resolveNodeIndex, type ProjectedGraph } from "@fuluoxiaojie/graph-engine";
import type { NodeStatus, ProgressEntry } from "../api/client.js";

/**
 * Resolve effective progress entry for a node in the active projection.
 * Under mergeVariants=true, falls back cleanly to contracted variant aliases (e.g. 氵 -> 水)
 * so progress saved in split mode stays visible when merged.
 */
export function getEffectiveProgress(
  projected: ProjectedGraph,
  nodeId: string,
  progress: Record<string, ProgressEntry>
): ProgressEntry | undefined {
  const direct = progress[nodeId];
  if (direct) return direct;

  if (!projected.mergeVariants) return undefined;
  const aliases = projected.mergedFrom[nodeId];
  if (!aliases || aliases.length === 0) return undefined;

  let best: ProgressEntry | undefined;
  const priority: Record<NodeStatus, number> = { known: 4, learning: 3, ignored: 2, unseen: 1 };
  for (const alias of aliases) {
    const entry = progress[alias];
    if (!entry) continue;
    if (!best || priority[entry.status] > priority[best.status]) {
      best = entry;
    }
  }
  return best;
}

export function getEffectiveStatus(
  projected: ProjectedGraph,
  nodeId: string,
  progress: Record<string, ProgressEntry>
): NodeStatus {
  return getEffectiveProgress(projected, nodeId, progress)?.status ?? "unseen";
}

export function getEffectiveNotes(
  projected: ProjectedGraph,
  nodeId: string,
  progress: Record<string, ProgressEntry>
): string {
  const direct = progress[nodeId]?.notes;
  if (direct) return direct;
  if (projected.mergeVariants) {
    for (const alias of projected.mergedFrom[nodeId] ?? []) {
      const n = progress[alias]?.notes;
      if (n) return n;
    }
  }
  return "";
}

/**
 * Check whether a node (or any of its contracted variants when mergeVariants=true) is enrolled in SRS.
 */
export function isNodeEnrolled(
  projected: ProjectedGraph,
  nodeId: string,
  enrolledNodeIds: ReadonlySet<string>
): boolean {
  if (enrolledNodeIds.has(nodeId)) return true;
  if (projected.mergeVariants) {
    for (const alias of projected.mergedFrom[nodeId] ?? []) {
      if (enrolledNodeIds.has(alias)) return true;
    }
  }
  return false;
}

/**
 * Build the set of canonical node IDs considered satisfied (known or ignored) in the active projection.
 */
export function buildSatisfiedIdSet(
  projected: ProjectedGraph,
  progress: Record<string, ProgressEntry>
): Set<string> {
  const out = new Set<string>();
  for (const [rawId, entry] of Object.entries(progress)) {
    if (entry.status !== "known" && entry.status !== "ignored") continue;
    const idx = resolveNodeIndex(projected, rawId);
    if (idx !== undefined) {
      out.add(projected.nodes[idx]!.id);
    }
  }
  return out;
}

/**
 * Compute log-scale normalized coordinate in [0, 1] for 1-indexed ranks [1..maxRank].
 */
export function logRankFraction(rank: number, maxRank: number): number {
  if (maxRank <= 1) return 0;
  const clamped = Math.max(1, Math.min(maxRank, rank));
  return Math.log10(clamped) / Math.log10(maxRank);
}

/**
 * Compute non-overlapping midpoint/Voronoi hover bands [leftX, rightX] for sorted x coordinates.
 */
export function computeHoverBands(xs: number[], minX: number, maxX: number): Array<{ x: number; width: number }> {
  return xs.map((cx, i) => {
    const left = i === 0 ? minX : (xs[i - 1]! + cx) / 2;
    const right = i === xs.length - 1 ? maxX : (cx + xs[i + 1]!) / 2;
    return { x: left, width: Math.max(1, right - left) };
  });
}
