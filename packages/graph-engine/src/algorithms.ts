import { resolveNodeIndex } from "./projection.js";
import type {
  EdgeRole,
  NodeScore,
  ProjectedGraph,
  SandboxConfig,
  ScoreResult,
} from "./types.js";

/**
 * Compact CSR reachability cache computed once per ProjectedGraph using bitsets to
 * deduplicate diamond paths, then flattened into dense Int32Arrays (~200 KB total).
 */
export interface ReachabilityCache {
  /** CSR offsets (length N+1) into ancestorIndices (all c >= u, i.e., u plus compounds containing u) */
  ancestorOffsets: Int32Array;
  ancestorIndices: Int32Array;
  ancestorCounts: Int32Array;
  /** CSR offsets (length N+1) into prereqIndices (all u <= c, i.e., c plus recursive components of c) */
  prereqOffsets: Int32Array;
  prereqIndices: Int32Array;
}

const reachabilityCacheMap = new WeakMap<ProjectedGraph, ReachabilityCache>();

function flattenBitsetsToCsr(
  bits: Uint32Array,
  n: number,
  words: number
): { offsets: Int32Array; indices: Int32Array; counts: Int32Array } {
  const counts = new Int32Array(n);
  const offsets = new Int32Array(n + 1);
  let total = 0;

  for (let i = 0; i < n; i++) {
    let count = 0;
    const off = i * words;
    for (let w = 0; w < words; w++) {
      let val = bits[off + w]!;
      while (val !== 0) {
        val = (val & (val - 1)) >>> 0;
        count++;
      }
    }
    counts[i] = count;
    offsets[i] = total;
    total += count;
  }
  offsets[n] = total;

  const indices = new Int32Array(total);
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    const off = i * words;
    for (let w = 0; w < words; w++) {
      let word = bits[off + w]!;
      const baseIdx = w << 5;
      while (word !== 0) {
        const lsb = (word & -word) >>> 0;
        indices[cursor++] = baseIdx + (31 - Math.clz32(lsb));
        word = (word ^ lsb) >>> 0;
      }
    }
  }

  return { offsets, indices, counts };
}

export function getReachabilityCache(projected: ProjectedGraph): ReachabilityCache {
  const existing = reachabilityCacheMap.get(projected);
  if (existing) return existing;

  const n = projected.nodes.length;
  const words = Math.ceil(n / 32);
  const ancestorBits = new Uint32Array(n * words);
  const prereqBits = new Uint32Array(n * words);

  for (let i = 0; i < n; i++) {
    const w = i >>> 5;
    const bit = (1 << (i & 31)) >>> 0;
    ancestorBits[i * words + w] = bit;
    prereqBits[i * words + w] = bit;
  }

  const topo = projected.topoOrder;

  // Forward topological pass -> exact prerequisite closures (prereqBits)
  for (let t = 0; t < n; t++) {
    const c = topo[t]!;
    const inc = projected.incoming[c]!;
    const cOff = c * words;
    for (let k = 0; k < inc.length; k++) {
      const u = inc[k]!.sourceIdx;
      const uOff = u * words;
      for (let w = 0; w < words; w++) {
        prereqBits[cOff + w] = (prereqBits[cOff + w]! | prereqBits[uOff + w]!) >>> 0;
      }
    }
  }

  // Reverse topological pass -> exact ancestor/compound closures (ancestorBits)
  for (let t = n - 1; t >= 0; t--) {
    const c = topo[t]!;
    const inc = projected.incoming[c]!;
    const cOff = c * words;
    for (let k = 0; k < inc.length; k++) {
      const u = inc[k]!.sourceIdx;
      const uOff = u * words;
      for (let w = 0; w < words; w++) {
        ancestorBits[uOff + w] = (ancestorBits[uOff + w]! | ancestorBits[cOff + w]!) >>> 0;
      }
    }
  }

  const ancCsr = flattenBitsetsToCsr(ancestorBits, n, words);
  const preCsr = flattenBitsetsToCsr(prereqBits, n, words);

  const cache: ReachabilityCache = {
    ancestorOffsets: ancCsr.offsets,
    ancestorIndices: ancCsr.indices,
    ancestorCounts: ancCsr.counts,
    prereqOffsets: preCsr.offsets,
    prereqIndices: preCsr.indices,
  };
  reachabilityCacheMap.set(projected, cache);
  return cache;
}

export function getRoleWeight(role: EdgeRole, config: SandboxConfig): number {
  const val = config.roleWeights[role];
  return Number.isFinite(val) && val > 0 ? val : 0;
}

/**
 * Compute raw corpus share (used for text coverage reporting) and preset signal (used for weight transforms).
 */
export function computeRawSignals(
  projected: ProjectedGraph,
  config: SandboxConfig
): { corpusShare: Float64Array; presetSignal: Float64Array; presetRank: Int32Array } {
  const n = projected.nodes.length;
  const corpusShare = new Float64Array(n);
  const presetSignal = new Float64Array(n);
  const blendW = Math.min(1, Math.max(0, config.blendSubtlexWeight));

  let hskSum = 0;
  for (let i = 0; i < n; i++) {
    const node = projected.nodes[i]!;
    if (node.isPrimitive) {
      corpusShare[i] = 0;
      presetSignal[i] = 0;
      continue;
    }
    const sub = Math.max(0, node.freq.subtlexShare);
    const jun = Math.max(0, node.freq.jundaShare);

    if (config.frequencyPreset === "subtlex") {
      corpusShare[i] = sub;
      presetSignal[i] = sub;
    } else if (config.frequencyPreset === "junda") {
      corpusShare[i] = jun;
      presetSignal[i] = jun;
    } else if (config.frequencyPreset === "blend") {
      const mixed = blendW * sub + (1 - blendW) * jun;
      corpusShare[i] = mixed;
      presetSignal[i] = mixed;
    } else {
      corpusShare[i] = 0.5 * sub + 0.5 * jun;
      if (node.hskLevel !== null && node.hskLevel >= 1 && node.hskLevel <= 7) {
        const bandWeight = Math.pow(2, 7 - node.hskLevel) + 0.15 * (sub + jun) * 1000;
        presetSignal[i] = bandWeight;
        hskSum += bandWeight;
      } else {
        presetSignal[i] = 0;
      }
    }
  }

  if (config.frequencyPreset === "hsk" && hskSum > 0) {
    for (let i = 0; i < n; i++) {
      presetSignal[i] = presetSignal[i]! / hskSum;
    }
  }

  const rankedIndices: number[] = [];
  for (let i = 0; i < n; i++) {
    if (presetSignal[i]! > 0) rankedIndices.push(i);
  }
  rankedIndices.sort((a, b) => {
    const diff = presetSignal[b]! - presetSignal[a]!;
    if (diff !== 0) return diff;
    return projected.nodes[a]!.id < projected.nodes[b]!.id ? -1 : 1;
  });

  const presetRank = new Int32Array(n);
  for (let r = 0; r < rankedIndices.length; r++) {
    presetRank[rankedIndices[r]!] = r + 1;
  }

  return { corpusShare, presetSignal, presetRank };
}

/**
 * Compute base weights w_0(u) after Zipf transform and optional known-node zeroing.
 */
export function computeBaseWeights(
  projected: ProjectedGraph,
  config: SandboxConfig,
  knownIndices?: ReadonlySet<number>
): {
  baseWeights: Float64Array;
  fullBaseWeights: Float64Array;
  corpusShare: Float64Array;
  presetRank: Int32Array;
} {
  const n = projected.nodes.length;
  const { corpusShare, presetSignal, presetRank } = computeRawSignals(projected, config);
  const fullBaseWeights = new Float64Array(n);
  const baseWeights = new Float64Array(n);

  const logScale = Math.max(1, config.logScale);
  const gamma = Math.min(1, Math.max(0.05, config.powerGamma));
  const rankOffset = Math.max(1, config.rankOffset);

  for (let i = 0; i < n; i++) {
    const p = presetSignal[i]!;
    if (p <= 0) {
      fullBaseWeights[i] = 0;
      baseWeights[i] = 0;
      continue;
    }
    let w = p;
    if (config.weightTransform === "log") {
      w = Math.log1p(logScale * p);
    } else if (config.weightTransform === "power") {
      w = Math.pow(p, gamma);
    } else if (config.weightTransform === "rank") {
      const r = presetRank[i]!;
      w = r > 0 ? 1 / (r + rankOffset) : 0;
    }
    fullBaseWeights[i] = w;
    baseWeights[i] = config.onlyRemainingMass && knownIndices?.has(i) ? 0 : w;
  }

  return { baseWeights, fullBaseWeights, corpusShare, presetRank };
}

/**
 * Exact O(V + E) reverse-topological propagation (compounds -> components).
 */
export function computeReverseTopoPropagation(
  projected: ProjectedGraph,
  baseWeights: Float64Array,
  config: SandboxConfig
): Float64Array {
  const n = projected.nodes.length;
  const scores = new Float64Array(baseWeights);
  const alpha = Math.min(1, Math.max(0, config.damping));
  const topo = projected.topoOrder;
  const wSem = getRoleWeight("semantic", config);
  const wPho = getRoleWeight("phonetic", config);
  const wStr = getRoleWeight("structural", config);

  const roleW = (r: EdgeRole) => (r === "phonetic" ? wPho : r === "semantic" ? wSem : wStr);

  for (let t = n - 1; t >= 0; t--) {
    const c = topo[t]!;
    const sc = scores[c]!;
    if (sc === 0 || alpha === 0) continue;
    const inc = projected.incoming[c]!;
    if (inc.length === 0) continue;

    let denom = 0;
    for (let k = 0; k < inc.length; k++) {
      const e = inc[k]!;
      const mult = config.useMultiplicity ? e.multiplicity : 1;
      denom += mult * roleW(e.role);
    }
    if (denom <= 0) continue;

    const factor = (alpha * sc) / denom;
    for (let k = 0; k < inc.length; k++) {
      const e = inc[k]!;
      const mult = config.useMultiplicity ? e.multiplicity : 1;
      const share = mult * roleW(e.role);
      if (share > 0) {
        scores[e.sourceIdx] = scores[e.sourceIdx]! + factor * share;
      }
    }
  }

  return scores;
}

/**
 * Exact closed-form O(V + E) Personalized PageRank solver on a verified DAG.
 *
 * For a DAG with compound->component stochastic matrix P, restart vector v (||v||_1 = 1),
 * and dangling-sink redistribution via v, the stationary equation
 *   r = d * P * r + (1 - d + d * sinkMass(r)) * v   with ||r||_1 = 1
 * has exact solution r = u / ||u||_1 where u = (I - d * P)^(-1) * v = v + d * P * u,
 * computed to machine precision in a single reverse-topological pass for all d in [0, 1]
 * without periodic oscillation or iteration-cap truncation.
 */
export function computePersonalizedPageRank(
  projected: ProjectedGraph,
  baseWeights: Float64Array,
  config: SandboxConfig
): Float64Array {
  const n = projected.nodes.length;
  let wSum = 0;
  for (let i = 0; i < n; i++) wSum += baseWeights[i]!;
  if (wSum <= 0) {
    return new Float64Array(n);
  }

  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    v[i] = baseWeights[i]! / wSum;
  }

  const d = Math.min(1, Math.max(0, config.damping));
  const u = computeReverseTopoPropagation(projected, v, { ...config, damping: d });

  let uSum = 0;
  for (let i = 0; i < n; i++) uSum += u[i]!;
  if (uSum > 0) {
    for (let i = 0; i < n; i++) {
      u[i] = u[i]! / uSum;
    }
  }
  return u;
}

/**
 * Exact ancestor reachability / coverage scoring using cached dense CSR ancestor lists (zero diamond double-counting, <1ms).
 */
export function computeBitsetCoverageScores(
  projected: ProjectedGraph,
  baseWeights: Float64Array,
  corpusShare: Float64Array
): { coverageWeights: Float64Array; coverageShares: Float64Array; ancestorCounts: Int32Array } {
  const n = projected.nodes.length;
  const cache = getReachabilityCache(projected);
  const { ancestorOffsets, ancestorIndices, ancestorCounts } = cache;
  const coverageWeights = new Float64Array(n);
  const coverageShares = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const start = ancestorOffsets[i]!;
    const end = ancestorOffsets[i + 1]!;
    if (end - start === 1) {
      coverageWeights[i] = baseWeights[i]!;
      coverageShares[i] = corpusShare[i]!;
      continue;
    }
    let wAcc = 0;
    let sAcc = 0;
    for (let p = start; p < end; p++) {
      const idx = ancestorIndices[p]!;
      wAcc += baseWeights[idx]!;
      sAcc += corpusShare[idx]!;
    }
    coverageWeights[i] = wAcc;
    coverageShares[i] = sAcc;
  }

  return { coverageWeights, coverageShares, ancestorCounts };
}

/**
 * Run the selected scoring algorithm and produce ranked NodeScores + rank deltas.
 */
export function scoreGraph(
  projected: ProjectedGraph,
  config: SandboxConfig,
  knownIds?: ReadonlySet<string>
): ScoreResult {
  const t0 = performance.now();
  const n = projected.nodes.length;

  let knownIndices: Set<number> | undefined;
  if (knownIds && knownIds.size > 0) {
    knownIndices = new Set<number>();
    for (const id of knownIds) {
      const idx = resolveNodeIndex(projected, id);
      if (idx !== undefined) knownIndices.add(idx);
    }
  }

  const { baseWeights, fullBaseWeights, corpusShare, presetRank } = computeBaseWeights(
    projected,
    config,
    knownIndices
  );

  const { coverageWeights, coverageShares, ancestorCounts } = computeBitsetCoverageScores(
    projected,
    baseWeights,
    corpusShare
  );

  let rawScores: Float64Array;
  if (config.algorithm === "reverse-topo") {
    rawScores = computeReverseTopoPropagation(projected, baseWeights, config);
  } else if (config.algorithm === "pagerank") {
    rawScores = computePersonalizedPageRank(projected, baseWeights, config);
  } else if (config.algorithm === "coverage") {
    rawScores = coverageWeights;
  } else {
    rawScores = baseWeights;
  }

  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => {
    const sDiff = rawScores[b]! - rawScores[a]!;
    if (sDiff !== 0) return sDiff;
    const wDiff = fullBaseWeights[b]! - fullBaseWeights[a]!;
    if (wDiff !== 0) return wDiff;
    return projected.nodes[a]!.id < projected.nodes[b]!.id ? -1 : 1;
  });

  const maxScore = order.length > 0 ? rawScores[order[0]!]! : 0;
  const nodes: NodeScore[] = new Array(n);
  const byId = new Map<string, NodeScore>();

  for (let r = 0; r < n; r++) {
    const idx = order[r]!;
    const gNode = projected.nodes[idx]!;
    const score = rawScores[idx]!;
    const rank = r + 1;
    const rawRankVal = presetRank[idx]!;
    const rawRank = rawRankVal > 0 ? rawRankVal : null;
    const rankDelta = rawRank !== null ? rawRank - rank : null;
    const item: NodeScore = {
      id: gNode.id,
      index: idx,
      rawWeight: baseWeights[idx]!,
      rawCorpusShare: corpusShare[idx]!,
      score,
      normalizedScore: maxScore > 0 ? (score / maxScore) * 100 : 0,
      rank,
      rawRank,
      rankDelta,
      coverageShare: coverageShares[idx]!,
      ancestorCount: ancestorCounts[idx]!,
    };
    nodes[r] = item;
    byId.set(gNode.id, item);
  }

  return {
    config,
    nodes,
    byId,
    computeMs: performance.now() - t0,
  };
}
