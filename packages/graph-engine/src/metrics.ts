import { computeRawSignals, scoreGraph } from "./algorithms.js";
import { resolveNodeIndex } from "./projection.js";
import type {
  CoverageCurvePoint,
  KnownCoverageSummary,
  ProjectedGraph,
  SandboxConfig,
} from "./types.js";

const DEFAULT_CHECKPOINTS = [0, 25, 50, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 2500, 3000, 3500];

export function computeCoverageCurves(
  projected: ProjectedGraph,
  config: SandboxConfig,
  checkpoints: number[] = DEFAULT_CHECKPOINTS
): CoverageCurvePoint[] {
  const n = projected.nodes.length;
  const validCheckpoints = checkpoints.filter((cp) => cp >= 0 && cp <= n);
  if (validCheckpoints.length === 0) return [];

  const maxN = Math.min(n, Math.max(...validCheckpoints, 0));
  const { corpusShare, presetRank } = computeRawSignals(projected, config);
  const scoreRes = scoreGraph(projected, { ...config, onlyRemainingMass: false });

  const rawSeq = Array.from({ length: n }, (_, i) => i)
    .filter((i) => !projected.nodes[i]!.isPrimitive)
    .sort((a, b) => {
      const d = corpusShare[b]! - corpusShare[a]!;
      return d !== 0 ? d : a - b;
    });

  const activeSeq = simulatePriorityTopoSequence(projected, scoreRes, presetRank, config.holisticBypassTopN, maxN);
  const greedySeq = simulateGreedySequence(projected, scoreRes, corpusShare, presetRank, config, maxN);

  const evalCurve = (seq: number[]) => {
    const covAt = new Map<number, number>();
    const suppAt = new Map<number, number>();
    const learned = new Uint8Array(n);
    const cpSet = new Set(validCheckpoints);

    let totalShare = 0;
    let supportedShare = 0;
    const isSupported = new Uint8Array(n);

    const checkNodeSupported = (idx: number): boolean => {
      if (!learned[idx]) return false;
      const inc = projected.incoming[idx]!;
      for (let k = 0; k < inc.length; k++) {
        if (!learned[inc[k]!.sourceIdx]) return false;
      }
      return true;
    };

    if (cpSet.has(0)) {
      covAt.set(0, 0);
      suppAt.set(0, 0);
    }

    for (let step = 1; step <= maxN; step++) {
      const idx = seq[step - 1];
      if (idx !== undefined && !learned[idx]) {
        learned[idx] = 1;
        totalShare += corpusShare[idx]!;

        if (!isSupported[idx] && checkNodeSupported(idx)) {
          isSupported[idx] = 1;
          supportedShare += corpusShare[idx]!;
        }
        for (const e of projected.outgoing[idx]!) {
          const dst = e.targetIdx;
          if (learned[dst] && !isSupported[dst] && checkNodeSupported(dst)) {
            isSupported[dst] = 1;
            supportedShare += corpusShare[dst]!;
          }
        }
      }
      if (cpSet.has(step)) {
        covAt.set(step, totalShare * 100);
        suppAt.set(step, supportedShare * 100);
      }
    }
    return { covAt, suppAt };
  };

  const rawEval = evalCurve(rawSeq);
  const activeEval = evalCurve(activeSeq);
  const greedyEval = evalCurve(greedySeq);

  return validCheckpoints.map((cp) => ({
    learnedCount: cp,
    rawFreqCoveragePct: round2(rawEval.covAt.get(cp) ?? 0),
    activeAlgoCoveragePct: round2(activeEval.covAt.get(cp) ?? 0),
    greedyUnlockCoveragePct: round2(greedyEval.covAt.get(cp) ?? 0),
    activeSupportedCoveragePct: round2(activeEval.suppAt.get(cp) ?? 0),
    rawSupportedCoveragePct: round2(rawEval.suppAt.get(cp) ?? 0),
  }));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function simulatePriorityTopoSequence(
  projected: ProjectedGraph,
  scoreRes: ReturnType<typeof scoreGraph>,
  presetRank: Int32Array,
  holisticBypassTopN: number,
  maxN: number
): number[] {
  const n = projected.nodes.length;
  const scoreByIdx = new Float64Array(n);
  for (const ns of scoreRes.nodes) {
    scoreByIdx[ns.index] = ns.score;
  }

  const remainingDeps = new Int32Array(n);
  const inHeap = new Uint8Array(n);
  const picked = new Uint8Array(n);
  const heap: number[] = [];

  const push = (idx: number) => {
    if (inHeap[idx] || picked[idx]) return;
    inHeap[idx] = 1;
    heap.push(idx);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (scoreByIdx[heap[p]!]! >= scoreByIdx[heap[i]!]!) break;
      const tmp = heap[p]!;
      heap[p] = heap[i]!;
      heap[i] = tmp;
      i = p;
    }
  };

  const pop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      const len = heap.length;
      while (true) {
        let best = i;
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        if (l < len && scoreByIdx[heap[l]!]! > scoreByIdx[heap[best]!]!) best = l;
        if (r < len && scoreByIdx[heap[r]!]! > scoreByIdx[heap[best]!]!) best = r;
        if (best === i) break;
        const tmp = heap[i]!;
        heap[i] = heap[best]!;
        heap[best] = tmp;
        i = best;
      }
    }
    return top;
  };

  const bypassTopN = Math.max(0, Math.floor(holisticBypassTopN));
  for (let i = 0; i < n; i++) {
    remainingDeps[i] = projected.incoming[i]!.length;
    const isBypass =
      !projected.nodes[i]!.isPrimitive &&
      bypassTopN > 0 &&
      presetRank[i]! > 0 &&
      presetRank[i]! <= bypassTopN;
    if (remainingDeps[i] === 0 || isBypass) {
      push(i);
    }
  }

  const seq: number[] = [];
  while (heap.length > 0 && seq.length < maxN) {
    const u = pop();
    if (picked[u]) continue;
    picked[u] = 1;
    seq.push(u);
    for (const e of projected.outgoing[u]!) {
      const v = e.targetIdx;
      remainingDeps[v] = remainingDeps[v]! - 1;
      if (remainingDeps[v] === 0) {
        push(v);
      }
    }
  }

  return seq;
}

function simulateGreedySequence(
  projected: ProjectedGraph,
  scoreRes: ReturnType<typeof scoreGraph>,
  corpusShare: Float64Array,
  presetRank: Int32Array,
  config: SandboxConfig,
  maxN: number
): number[] {
  const n = projected.nodes.length;
  const bypassTopN = Math.max(0, Math.floor(config.holisticBypassTopN));
  const lambda = Math.max(0.5, config.greedyClusterExponent);

  const topoPos = new Int32Array(n);
  for (let t = 0; t < n; t++) topoPos[projected.topoOrder[t]!] = t;

  const charsByFreq = Array.from({ length: n }, (_, i) => i)
    .filter((i) => !projected.nodes[i]!.isPrimitive)
    .sort((a, b) => {
      const d = corpusShare[b]! - corpusShare[a]!;
      return d !== 0 ? d : a - b;
    });

  const unlearned = new Uint8Array(n);
  unlearned.fill(1);

  const visitedStamp = new Int32Array(n);
  const dfsStack = new Int32Array(n);
  let stamp = 0;

  const collectDynamicPrereqs = (target: number, outIndices?: number[]): { size: number; shareSum: number } => {
    stamp++;
    if (stamp === 0x7fffffff) {
      visitedStamp.fill(0);
      stamp = 1;
    }
    let sp = 0;
    dfsStack[sp++] = target;
    visitedStamp[target] = stamp;

    let size = 0;
    let shareSum = 0;
    while (sp > 0) {
      const cur = dfsStack[--sp]!;
      size++;
      shareSum += corpusShare[cur]!;
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
    return { size, shareSum };
  };

  const seq: number[] = [];
  const scoreByIdx = new Float64Array(n);
  for (const ns of scoreRes.nodes) scoreByIdx[ns.index] = ns.score;

  let cursor = 0;
  const activePool: number[] = [];

  const compactAndRefillPool = () => {
    let write = 0;
    for (let read = 0; read < activePool.length; read++) {
      const idx = activePool[read]!;
      if (unlearned[idx]) {
        activePool[write++] = idx;
      }
    }
    activePool.length = write;

    while (activePool.length < 350 && cursor < charsByFreq.length) {
      const idx = charsByFreq[cursor++]!;
      if (unlearned[idx]) {
        activePool.push(idx);
      }
    }
  };

  while (seq.length < maxN) {
    compactAndRefillPool();
    if (activePool.length === 0) break;

    let bestPoolPos = -1;
    let bestTarget = -1;
    let bestGain = -1;
    let bestHolistic = false;

    for (let p = 0; p < activePool.length; p++) {
      const c = activePool[p]!;
      const rVal = presetRank[c]!;
      const isHolistic = bypassTopN > 0 && rVal > 0 && rVal <= bypassTopN;
      let size: number;
      let shareSum: number;

      if (isHolistic) {
        size = 1;
        shareSum = corpusShare[c]!;
      } else {
        const res = collectDynamicPrereqs(c);
        size = res.size;
        shareSum = res.shareSum;
      }

      if (size === 0) continue;
      const gain = (shareSum + 1e-12 * scoreByIdx[c]!) / Math.pow(size, lambda);
      if (gain > bestGain) {
        bestGain = gain;
        bestTarget = c;
        bestPoolPos = p;
        bestHolistic = isHolistic;
      }
    }

    if (bestTarget === -1) break;
    const last = activePool.pop()!;
    if (bestPoolPos < activePool.length) {
      activePool[bestPoolPos] = last;
    }

    const cluster: number[] = [];
    if (bestHolistic) {
      cluster.push(bestTarget);
    } else {
      collectDynamicPrereqs(bestTarget, cluster);
      cluster.sort((a, b) => topoPos[a]! - topoPos[b]!);
    }

    for (const idx of cluster) {
      if (seq.length >= maxN) break;
      seq.push(idx);
      unlearned[idx] = 0;
    }
  }

  return seq;
}

export function computeKnownCoverage(
  projected: ProjectedGraph,
  knownIds: ReadonlySet<string>
): KnownCoverageSummary {
  const knownIndices = new Set<number>();
  for (const id of knownIds) {
    const idx = resolveNodeIndex(projected, id);
    if (idx !== undefined) knownIndices.add(idx);
  }

  let knownChars = 0;
  let totalChars = 0;
  let knownPrimitives = 0;
  let totalPrimitives = 0;
  let subtlexCov = 0;
  let jundaCov = 0;
  const hskCoverage: Record<number, { known: number; total: number }> = {
    1: { known: 0, total: 0 },
    2: { known: 0, total: 0 },
    3: { known: 0, total: 0 },
    4: { known: 0, total: 0 },
    5: { known: 0, total: 0 },
    6: { known: 0, total: 0 },
    7: { known: 0, total: 0 },
  };

  for (let i = 0; i < projected.nodes.length; i++) {
    const node = projected.nodes[i]!;
    const isKnown = knownIndices.has(i);
    if (node.isPrimitive) {
      totalPrimitives++;
      if (isKnown) knownPrimitives++;
    } else {
      totalChars++;
      if (isKnown) {
        knownChars++;
        subtlexCov += node.freq.subtlexShare;
        jundaCov += node.freq.jundaShare;
      }
    }
    if (node.hskLevel !== null && hskCoverage[node.hskLevel]) {
      hskCoverage[node.hskLevel]!.total++;
      if (isKnown) hskCoverage[node.hskLevel]!.known++;
    }
  }

  return {
    knownChars,
    totalChars,
    knownPrimitives,
    totalPrimitives,
    subtlexCoveragePct: round2(subtlexCov * 100),
    jundaCoveragePct: round2(jundaCov * 100),
    hskCoverage,
  };
}
