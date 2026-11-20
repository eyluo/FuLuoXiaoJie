import { computeBaseWeights, scoreGraph } from "./algorithms.js";
import { resolveNodeIndex } from "./projection.js";
import type {
  ProjectedGraph,
  QueueItem,
  SandboxConfig,
  ScoreResult,
} from "./types.js";

function toIndexSet(projected: ProjectedGraph, ids?: ReadonlySet<string>): Set<number> {
  const out = new Set<number>();
  if (!ids) return out;
  for (const id of ids) {
    const idx = resolveNodeIndex(projected, id);
    if (idx !== undefined) out.add(idx);
  }
  return out;
}

/**
 * Count how many currently-unknown direct compounds would become immediately unlocked if `idx` were learned.
 */
function countDirectUnlocks(
  projected: ProjectedGraph,
  idx: number,
  satisfied: ReadonlySet<number>,
  ignored: ReadonlySet<number>
): number {
  let unlocks = 0;
  for (const e of projected.outgoing[idx]!) {
    const target = e.targetIdx;
    if (satisfied.has(target) || ignored.has(target)) continue;
    let ready = true;
    for (const pre of projected.incoming[target]!) {
      if (pre.sourceIdx !== idx && !satisfied.has(pre.sourceIdx)) {
        ready = false;
        break;
      }
    }
    if (ready) unlocks++;
  }
  return unlocks;
}

function isMatchingScoreResult(projected: ProjectedGraph, scoreRes?: ScoreResult): scoreRes is ScoreResult {
  if (!scoreRes || scoreRes.nodes.length !== projected.nodes.length) return false;
  if (projected.nodes.length === 0) return true;
  return scoreRes.byId.has(projected.nodes[0]!.id);
}

/**
 * Build a dynamic "Next to Learn" study queue using either:
 *  - "priority-topo": unlocked (+ holistic-bypass top-N) nodes ranked by active algorithm score
 *  - "greedy-unlock": iterative marginal-gain cluster picker (stopping prerequisite traversal at satisfied nodes)
 */
export function buildStudyQueue(
  projected: ProjectedGraph,
  config: SandboxConfig,
  knownIds: ReadonlySet<string>,
  ignoredIds: ReadonlySet<string> = new Set(),
  limit = 60,
  precomputedScore?: ScoreResult
): QueueItem[] {
  if (limit <= 0 || projected.nodes.length === 0) return [];
  const scoreRes = isMatchingScoreResult(projected, precomputedScore)
    ? precomputedScore
    : scoreGraph(projected, config, knownIds);
  const knownIdx = toIndexSet(projected, knownIds);
  const ignoredIdx = toIndexSet(projected, ignoredIds);
  const satisfied = new Set<number>([...knownIdx, ...ignoredIdx]);

  if (config.plannerStrategy === "greedy-unlock") {
    return buildGreedyUnlockQueue(projected, scoreRes, config, knownIdx, ignoredIdx, limit);
  }

  return buildPriorityTopoQueue(projected, scoreRes, config, satisfied, ignoredIdx, limit);
}

function buildPriorityTopoQueue(
  projected: ProjectedGraph,
  scoreRes: ScoreResult,
  config: SandboxConfig,
  satisfied: ReadonlySet<number>,
  ignoredIdx: ReadonlySet<number>,
  limit: number
): QueueItem[] {
  const n = projected.nodes.length;
  const bypassTopN = Math.max(0, Math.floor(config.holisticBypassTopN));
  const candidates: QueueItem[] = [];

  for (let i = 0; i < n; i++) {
    if (satisfied.has(i) || ignoredIdx.has(i)) continue;
    const node = projected.nodes[i]!;
    const ns = scoreRes.byId.get(node.id)!;

    const missingPrereqs: string[] = [];
    for (const e of projected.incoming[i]!) {
      if (!satisfied.has(e.sourceIdx)) {
        missingPrereqs.push(projected.nodes[e.sourceIdx]!.id);
      }
    }

    const isUnlocked = missingPrereqs.length === 0;
    const isHolisticBypass =
      !isUnlocked &&
      !node.isPrimitive &&
      bypassTopN > 0 &&
      ns.rawRank !== null &&
      ns.rawRank <= bypassTopN;

    if (!isUnlocked && !isHolisticBypass) continue;

    candidates.push({
      id: node.id,
      reason: isUnlocked ? "unlocked" : "holistic-bypass",
      score: ns.score,
      normalizedScore: ns.normalizedScore,
      rawFreqShare: ns.rawCorpusShare,
      missingPrereqs,
      unlocksCount: countDirectUnlocks(projected, i, satisfied, ignoredIdx),
    });
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.rawFreqShare !== a.rawFreqShare) return b.rawFreqShare - a.rawFreqShare;
    return a.id < b.id ? -1 : 1;
  });

  return candidates.slice(0, limit);
}

function buildGreedyUnlockQueue(
  projected: ProjectedGraph,
  scoreRes: ScoreResult,
  config: SandboxConfig,
  knownIdx: ReadonlySet<number>,
  ignoredIdx: ReadonlySet<number>,
  limit: number
): QueueItem[] {
  const n = projected.nodes.length;
  const { baseWeights, corpusShare, presetRank } = computeBaseWeights(projected, config, knownIdx);
  const bypassTopN = Math.max(0, Math.floor(config.holisticBypassTopN));
  const lambda = Math.max(0.5, config.greedyClusterExponent);

  const scoreByIdx = new Float64Array(n);
  const normScoreByIdx = new Float64Array(n);
  for (const ns of scoreRes.nodes) {
    scoreByIdx[ns.index] = ns.score;
    normScoreByIdx[ns.index] = ns.normalizedScore;
  }

  const topoPos = new Int32Array(n);
  for (let t = 0; t < n; t++) {
    topoPos[projected.topoOrder[t]!] = t;
  }

  const unlearned = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!knownIdx.has(i) && !ignoredIdx.has(i)) {
      unlearned[i] = 1;
    }
  }

  const visitedStamp = new Int32Array(n);
  const dfsStack = new Int32Array(n);
  let stamp = 0;

  const collectDynamicPrereqs = (target: number, outIndices?: number[]): { size: number; weight: number } => {
    stamp++;
    if (stamp === 0x7fffffff) {
      visitedStamp.fill(0);
      stamp = 1;
    }
    let sp = 0;
    dfsStack[sp++] = target;
    visitedStamp[target] = stamp;

    let size = 0;
    let weight = 0;
    while (sp > 0) {
      const cur = dfsStack[--sp]!;
      size++;
      weight += baseWeights[cur]!;
      if (outIndices) outIndices.push(cur);

      const inc = projected.incoming[cur]!;
      for (let k = 0; k < inc.length; k++) {
        const src = inc[k]!.sourceIdx;
        if (unlearned[src] && visitedStamp[src] !== stamp) {
          visitedStamp[src] = stamp;
          dfsStack[sp++] = src;
        }
      }
    }
    return { size, weight };
  };

  const simSatisfied = new Set<number>([...knownIdx, ...ignoredIdx]);
  const result: QueueItem[] = [];

  const markEmitted = (idx: number) => {
    unlearned[idx] = 0;
    simSatisfied.add(idx);
  };

  while (result.length < limit) {
    let bestTarget = -1;
    let bestGain = -1;
    let bestTie = -1;
    let bestIsHolistic = false;

    for (let c = 0; c < n; c++) {
      if (!unlearned[c]) continue;
      const node = projected.nodes[c]!;
      const rVal = presetRank[c]!;
      const isHolistic = !node.isPrimitive && bypassTopN > 0 && rVal > 0 && rVal <= bypassTopN;

      let clusterSize: number;
      let clusterWeight: number;

      if (isHolistic) {
        clusterSize = 1;
        clusterWeight = baseWeights[c]!;
      } else {
        const res = collectDynamicPrereqs(c);
        clusterSize = res.size;
        clusterWeight = res.weight;
      }

      if (clusterSize === 0) continue;
      const sc = scoreByIdx[c]!;
      const gain = (clusterWeight + 1e-12 * sc) / Math.pow(clusterSize, lambda);

      if (gain > bestGain || (gain === bestGain && sc > bestTie)) {
        bestGain = gain;
        bestTie = sc;
        bestTarget = c;
        bestIsHolistic = isHolistic;
      }
    }

    if (bestTarget === -1) break;

    const clusterIndices: number[] = [];
    if (bestIsHolistic) {
      clusterIndices.push(bestTarget);
    } else {
      collectDynamicPrereqs(bestTarget, clusterIndices);
      clusterIndices.sort((a, b) => topoPos[a]! - topoPos[b]!);
    }

    const targetId = projected.nodes[bestTarget]!.id;
    for (const idx of clusterIndices) {
      if (result.length >= limit) break;
      const node = projected.nodes[idx]!;
      const missingPrereqs: string[] = [];
      for (const e of projected.incoming[idx]!) {
        if (!simSatisfied.has(e.sourceIdx)) {
          missingPrereqs.push(projected.nodes[e.sourceIdx]!.id);
        }
      }

      const isTarget = idx === bestTarget;
      let reason: QueueItem["reason"];
      if (isTarget && bestIsHolistic && missingPrereqs.length > 0) {
        reason = "holistic-bypass";
      } else if (clusterIndices.length === 1) {
        reason = "unlocked";
      } else if (isTarget) {
        reason = "cluster-target";
      } else {
        reason = "cluster-prereq";
      }

      result.push({
        id: node.id,
        reason,
        score: scoreByIdx[idx]!,
        normalizedScore: normScoreByIdx[idx]!,
        rawFreqShare: corpusShare[idx]!,
        missingPrereqs,
        unlocksCount: countDirectUnlocks(projected, idx, simSatisfied, ignoredIdx),
        clusterTarget: clusterIndices.length > 1 ? targetId : undefined,
        clusterGain: bestGain,
      });
      markEmitted(idx);
    }
  }

  return result;
}
