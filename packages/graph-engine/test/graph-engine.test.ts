import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SANDBOX_CONFIG,
  buildStudyQueue,
  computeBaseWeights,
  computeCoverageCurves,
  computeKnownCoverage,
  computePersonalizedPageRank,
  computeReverseTopoPropagation,
  extractSubgraph,
  projectGraph,
  scoreGraph,
  type GraphDataset,
  type GraphNode,
  type SandboxConfig,
} from "../src/index.js";

function makeNode(
  id: string,
  share: number,
  opts: Partial<GraphNode> = {}
): GraphNode {
  return {
    id,
    isPrimitive: opts.isPrimitive ?? false,
    strokes: opts.strokes ?? 4,
    hasStrokes: opts.hasStrokes ?? true,
    strokeFile: opts.strokeFile ?? null,
    pinyin: opts.pinyin ?? [],
    syllables: opts.syllables ?? [],
    audio: opts.audio ?? null,
    definition: opts.definition ?? id,
    radical: opts.radical ?? id,
    decomposition: opts.decomposition ?? null,
    etymology: opts.etymology ?? null,
    hskLevel: opts.hskLevel ?? 1,
    freq: {
      subtlexCount: Math.round(share * 1_000_000),
      subtlexRank: share > 0 ? 1 : null,
      subtlexShare: share,
      jundaCount: Math.round(share * 1_000_000),
      jundaRank: share > 0 ? 1 : null,
      jundaShare: share,
      ...(opts.freq ?? {}),
    },
  };
}

function makeToyDataset(): GraphDataset {
  const nodes: GraphNode[] = [
    makeNode("木", 0.02),
    makeNode("林", 0.01),
    makeNode("森", 0.005),
    makeNode("口", 0.03),
    makeNode("品", 0.015),
    makeNode("日", 0.025),
    makeNode("月", 0.025),
    makeNode("明", 0.04),
    makeNode("水", 0.03),
    makeNode("氵", 0, { isPrimitive: true }),
    makeNode("青", 0.01),
    makeNode("清", 0.035),
    makeNode("白", 0.02),
    makeNode("勺", 0.0005),
    makeNode("的", 0.15),
  ];

  return {
    meta: {
      version: "test",
      generatedAt: "2026-01-01T00:00:00Z",
      characterCount: 14,
      primitiveCount: 1,
      nodeCount: nodes.length,
      edgeCount: 10,
      subtlexTotalCount: 1_000_000,
      jundaTotalCount: 1_000_000,
      subtlexCoveragePct: 100,
      jundaCoveragePct: 100,
    },
    variantMap: { "氵": "水" },
    nodes,
    edges: [
      { source: "木", target: "林", multiplicity: 2, role: "structural" },
      { source: "木", target: "森", multiplicity: 1, role: "structural" },
      { source: "林", target: "森", multiplicity: 1, role: "structural" },
      { source: "口", target: "品", multiplicity: 3, role: "structural" },
      { source: "日", target: "明", multiplicity: 1, role: "semantic" },
      { source: "月", target: "明", multiplicity: 1, role: "semantic" },
      { source: "氵", target: "清", multiplicity: 1, role: "semantic" },
      { source: "青", target: "清", multiplicity: 1, role: "phonetic" },
      { source: "白", target: "的", multiplicity: 1, role: "structural" },
      { source: "勺", target: "的", multiplicity: 1, role: "phonetic" },
    ],
  };
}

describe("Synthetic Toy DAG Math", () => {
  it("conserves mass across diamond paths in reverse-topo propagation when alpha=1", () => {
    const toy = makeToyDataset();
    const proj = projectGraph(toy, false);
    const cfg: SandboxConfig = {
      ...DEFAULT_SANDBOX_CONFIG,
      mergeVariants: false,
      weightTransform: "raw",
      damping: 1.0,
      roleWeights: { semantic: 1, phonetic: 1, structural: 1 },
      onlyRemainingMass: false,
    };
    const { baseWeights } = computeBaseWeights(proj, cfg);
    const scores = computeReverseTopoPropagation(proj, baseWeights, cfg);

    expect(scores[proj.idToIndex.get("木")!]).toBeCloseTo(0.035, 10);
    expect(scores[proj.idToIndex.get("口")!]).toBeCloseTo(0.045, 10);
    expect(scores[proj.idToIndex.get("日")!]).toBeCloseTo(0.045, 10);
    expect(scores[proj.idToIndex.get("月")!]).toBeCloseTo(0.045, 10);
  });

  it("avoids diamond double-counting in bitset ancestor coverage", () => {
    const toy = makeToyDataset();
    const proj = projectGraph(toy, false);
    const cfg: SandboxConfig = {
      ...DEFAULT_SANDBOX_CONFIG,
      mergeVariants: false,
      weightTransform: "raw",
      algorithm: "coverage",
      onlyRemainingMass: false,
    };
    const res = scoreGraph(proj, cfg);
    const mu = res.byId.get("木")!;
    expect(mu.ancestorCount).toBe(3);
    expect(mu.coverageShare).toBeCloseTo(0.035, 10);
    expect(mu.score).toBeCloseTo(0.035, 10);
  });

  it("computes exact closed-form Personalized PageRank for d=0, d=0.85, d=0.99, and d=1.0", () => {
    // 2-node DAG A -> B with w=[0, 1]: exact stationary solution is A = d/(1+d), B = 1/(1+d)
    const twoNode: GraphDataset = {
      ...makeToyDataset(),
      variantMap: {},
      nodes: [makeNode("A", 0, { isPrimitive: true }), makeNode("B", 1.0)],
      edges: [{ source: "A", target: "B", multiplicity: 1, role: "structural" }],
    };
    const p2 = projectGraph(twoNode, false);
    for (const d of [0, 0.5, 0.85, 0.99, 1.0]) {
      const cfg: SandboxConfig = {
        ...DEFAULT_SANDBOX_CONFIG,
        algorithm: "pagerank",
        weightTransform: "raw",
        damping: d,
        onlyRemainingMass: false,
      };
      const { baseWeights } = computeBaseWeights(p2, cfg);
      const r = computePersonalizedPageRank(p2, baseWeights, cfg);
      const a = r[p2.idToIndex.get("A")!]!;
      const b = r[p2.idToIndex.get("B")!]!;
      expect(a + b).toBeCloseTo(1.0, 12);
      expect(a).toBeCloseTo(d / (1 + d), 12);
      expect(b).toBeCloseTo(1 / (1 + d), 12);
    }

    // Toy graph check
    const toy = makeToyDataset();
    const proj = projectGraph(toy, false);
    const cfg: SandboxConfig = {
      ...DEFAULT_SANDBOX_CONFIG,
      mergeVariants: false,
      algorithm: "pagerank",
      damping: 0.85,
      onlyRemainingMass: false,
    };
    const { baseWeights } = computeBaseWeights(proj, cfg);
    const ppr = computePersonalizedPageRank(proj, baseWeights, cfg);
    let sum = 0;
    for (let i = 0; i < ppr.length; i++) sum += ppr[i]!;
    expect(sum).toBeCloseTo(1.0, 12);
    expect(ppr[proj.idToIndex.get("氵")!]).toBeGreaterThan(0);
  });

  it("genuinely disables propagation along roles with weight 0 while preserving PPR normalization", () => {
    const toy = makeToyDataset();
    const proj = projectGraph(toy, false);
    const zeroRolesCfg: SandboxConfig = {
      ...DEFAULT_SANDBOX_CONFIG,
      mergeVariants: false,
      weightTransform: "raw",
      damping: 0.85,
      roleWeights: { semantic: 0, phonetic: 0, structural: 0 },
      onlyRemainingMass: false,
    };
    const { baseWeights } = computeBaseWeights(proj, zeroRolesCfg);
    const prop = computeReverseTopoPropagation(proj, baseWeights, zeroRolesCfg);
    // With all roleWeights=0, no mass flows out of any compound
    expect(prop[proj.idToIndex.get("氵")!]).toBe(0);
    expect(prop[proj.idToIndex.get("日")!]).toBeCloseTo(0.025, 12);

    // PPR with all roleWeights=0 reduces cleanly to normalized v with sum === 1
    const ppr = computePersonalizedPageRank(proj, baseWeights, zeroRolesCfg);
    let sum = 0;
    for (let i = 0; i < ppr.length; i++) sum += ppr[i]!;
    expect(sum).toBeCloseTo(1.0, 12);
    expect(ppr[proj.idToIndex.get("氵")!]).toBe(0);

    // Phonetic-only propagation: 明 (semantic-only edges) sends 0 to 日/月; 清 sends 100% of alpha*score to 青
    const phoneticOnlyCfg: SandboxConfig = {
      ...zeroRolesCfg,
      roleWeights: { semantic: 0, phonetic: 1, structural: 0 },
    };
    const propPho = computeReverseTopoPropagation(proj, baseWeights, phoneticOnlyCfg);
    expect(propPho[proj.idToIndex.get("日")!]).toBeCloseTo(0.025, 12);
    expect(propPho[proj.idToIndex.get("氵")!]).toBe(0);
    expect(propPho[proj.idToIndex.get("青")!]).toBeCloseTo(0.01 + 0.85 * 0.035, 12);
  });

  it("resolves contracted variant IDs cleanly across scoreGraph, buildStudyQueue, and computeKnownCoverage", () => {
    const toy = makeToyDataset();
    const merged = projectGraph(toy, true);

    expect(merged.idToIndex.has("氵")).toBe(false);
    expect(merged.mergedFrom["水"]).toEqual(["氵"]);

    // Knowing contracted variant "氵" resolves to "水" in all three consumers
    const scoreRes = scoreGraph(
      merged,
      { ...DEFAULT_SANDBOX_CONFIG, mergeVariants: true, onlyRemainingMass: true },
      new Set(["氵"])
    );
    expect(scoreRes.byId.get("水")!.rawWeight).toBe(0);

    const topoQueue = buildStudyQueue(
      merged,
      { ...DEFAULT_SANDBOX_CONFIG, mergeVariants: true, plannerStrategy: "priority-topo" },
      new Set(["氵"])
    );
    expect(topoQueue.some((q) => q.id === "水")).toBe(false);

    const greedyQueue = buildStudyQueue(
      merged,
      { ...DEFAULT_SANDBOX_CONFIG, mergeVariants: true, plannerStrategy: "greedy-unlock" },
      new Set(["氵"])
    );
    expect(greedyQueue.some((q) => q.id === "水")).toBe(false);

    const ignoredQueue = buildStudyQueue(
      merged,
      { ...DEFAULT_SANDBOX_CONFIG, mergeVariants: true, plannerStrategy: "priority-topo" },
      new Set(),
      new Set(["氵"])
    );
    expect(ignoredQueue.some((q) => q.id === "水")).toBe(false);

    const cov = computeKnownCoverage(merged, new Set(["氵"]));
    expect(cov.knownChars).toBe(1);
    expect(cov.subtlexCoveragePct).toBeCloseTo(3.0, 2);
  });

  it("stops dynamic prerequisite DFS at already-satisfied nodes in greedy-unlock (chain A -> B -> C with B known)", () => {
    const chain: GraphDataset = {
      ...makeToyDataset(),
      variantMap: {},
      nodes: [
        makeNode("A", 0, { isPrimitive: true }),
        makeNode("B", 0.01),
        makeNode("C", 0.2),
      ],
      edges: [
        { source: "A", target: "B", multiplicity: 1, role: "structural" },
        { source: "B", target: "C", multiplicity: 1, role: "structural" },
      ],
    };
    const proj = projectGraph(chain, false);
    const queue = buildStudyQueue(
      proj,
      { ...DEFAULT_SANDBOX_CONFIG, holisticBypassTopN: 0, plannerStrategy: "greedy-unlock" },
      new Set(["B"]),
      new Set(),
      10
    );
    // C's direct prerequisite B is already known -> C MUST be emitted first as "unlocked" without forcing A!
    expect(queue[0]!.id).toBe("C");
    expect(queue[0]!.reason).toBe("unlocked");
    expect(queue[0]!.missingPrereqs).toEqual([]);
  });

  it("rejects cyclic graphs cleanly in projectGraph", () => {
    const cyclic: GraphDataset = {
      ...makeToyDataset(),
      nodes: [makeNode("A", 0.5), makeNode("B", 0.5)],
      edges: [
        { source: "A", target: "B", multiplicity: 1, role: "structural" },
        { source: "B", target: "A", multiplicity: 1, role: "structural" },
      ],
      variantMap: {},
    };
    expect(() => projectGraph(cyclic, false)).toThrow(/not a DAG/i);
  });

  it("handles bitsets accurately across 32-bit word boundaries (indices 0, 31, 32, 63, 69)", () => {
    const nodes: GraphNode[] = [];
    const edges = [];
    for (let i = 0; i < 70; i++) {
      nodes.push(makeNode(`N${i}`, 0.01));
      if (i > 0) {
        edges.push({ source: `N${i - 1}`, target: `N${i}`, multiplicity: 1, role: "structural" as const });
      }
    }
    const ds: GraphDataset = { ...makeToyDataset(), variantMap: {}, nodes, edges };
    const proj = projectGraph(ds, false);
    const res = scoreGraph(proj, {
      ...DEFAULT_SANDBOX_CONFIG,
      algorithm: "coverage",
      weightTransform: "raw",
      onlyRemainingMass: false,
    });
    expect(res.byId.get("N0")!.ancestorCount).toBe(70);
    expect(res.byId.get("N31")!.ancestorCount).toBe(39);
    expect(res.byId.get("N32")!.ancestorCount).toBe(38);
    expect(res.byId.get("N63")!.ancestorCount).toBe(7);
    expect(res.byId.get("N69")!.ancestorCount).toBe(1);
    expect(res.byId.get("N0")!.coverageShare).toBeCloseTo(0.7, 10);
  });

  it("enforces soft gating with tunable holistic bypass on 的 = 白 + 勺", () => {
    const toy = makeToyDataset();
    const proj = projectGraph(toy, true);

    const strictQueue = buildStudyQueue(
      proj,
      { ...DEFAULT_SANDBOX_CONFIG, holisticBypassTopN: 0, plannerStrategy: "priority-topo" },
      new Set()
    );
    expect(strictQueue.some((q) => q.id === "的")).toBe(false);

    const bypassQueue = buildStudyQueue(
      proj,
      { ...DEFAULT_SANDBOX_CONFIG, holisticBypassTopN: 3, plannerStrategy: "priority-topo" },
      new Set()
    );
    const deItem = bypassQueue.find((q) => q.id === "的");
    expect(deItem).toBeDefined();
    expect(deItem!.reason).toBe("holistic-bypass");
    expect(deItem!.missingPrereqs.sort()).toEqual(["勺", "白"]);
  });

  it("emits unique, component-first clusters in greedy-unlock planner and handles all-known cleanly", () => {
    const toy = makeToyDataset();
    const proj = projectGraph(toy, true);
    const queue = buildStudyQueue(
      proj,
      { ...DEFAULT_SANDBOX_CONFIG, holisticBypassTopN: 0, plannerStrategy: "greedy-unlock" },
      new Set(),
      new Set(["勺"]),
      50
    );
    const ids = queue.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("勺");
    const pos = new Map(ids.map((id, i) => [id, i]));
    for (const e of proj.edges) {
      const src = proj.nodes[e.sourceIdx]!.id;
      const dst = proj.nodes[e.targetIdx]!.id;
      if (pos.has(src) && pos.has(dst)) {
        expect(pos.get(src)!).toBeLessThan(pos.get(dst)!);
      }
    }

    const allKnown = new Set(proj.nodes.map((n) => n.id));
    const emptyScore = scoreGraph(proj, { ...DEFAULT_SANDBOX_CONFIG, algorithm: "pagerank" }, allKnown);
    for (const ns of emptyScore.nodes) {
      expect(Number.isNaN(ns.score)).toBe(false);
      expect(Number.isNaN(ns.normalizedScore)).toBe(false);
    }
    expect(buildStudyQueue(proj, DEFAULT_SANDBOX_CONFIG, allKnown)).toEqual([]);
  });
});

describe("Real Compiled Simplified Mandarin DAG (data/graph.json)", () => {
  const graphPath = resolve(process.cwd(), "../../data/graph.json");
  const dataset = JSON.parse(readFileSync(graphPath, "utf-8")) as GraphDataset;

  it("projects cleanly in both split and merged modes and demonstrates real pedagogical rank shifts", () => {
    const split = projectGraph(dataset, false);
    const merged = projectGraph(dataset, true);
    expect(split.nodes.length).toBeGreaterThan(4000);
    expect(merged.nodes.length).toBeLessThan(split.nodes.length);

    const splitScore = scoreGraph(split, { ...DEFAULT_SANDBOX_CONFIG, mergeVariants: false, onlyRemainingMass: false });
    const waterRad = splitScore.byId.get("氵")!;
    expect(waterRad.rawWeight).toBe(0);
    expect(waterRad.rank).toBeLessThanOrEqual(30);

    const mergedScore = scoreGraph(merged, { ...DEFAULT_SANDBOX_CONFIG, mergeVariants: true, onlyRemainingMass: false });
    const qing = mergedScore.byId.get("青")!;
    expect(qing.rankDelta).not.toBeNull();
    expect(qing.rankDelta!).toBeGreaterThan(100);

    const shuiSplit = splitScore.byId.get("水")!;
    const shuiMerged = mergedScore.byId.get("水")!;
    expect(shuiMerged.ancestorCount).toBeGreaterThan(shuiSplit.ancestorCount + 100);
    expect(shuiMerged.rank).toBeLessThan(shuiSplit.rank);
  });

  it("recomputes all 4 algorithms rapidly on the full ~4,200-node DAG", () => {
    const merged = projectGraph(dataset, true);
    // Warm up reachability cache and V8 JIT before measuring
    for (const algorithm of ["coverage", "reverse-topo", "pagerank", "raw"] as const) {
      scoreGraph(merged, { ...DEFAULT_SANDBOX_CONFIG, algorithm });
    }

    for (const algorithm of ["reverse-topo", "pagerank", "coverage", "raw"] as const) {
      const res = scoreGraph(merged, { ...DEFAULT_SANDBOX_CONFIG, algorithm });
      expect(res.nodes.length).toBe(merged.nodes.length);
      expect(res.computeMs).toBeLessThan(100);
    }
  });

  it("computes complete monotonic coverage curves with zero dropped characters at full graph", () => {
    const merged = projectGraph(dataset, true);
    const n = merged.nodes.length;
    const curves = computeCoverageCurves(
      merged,
      { ...DEFAULT_SANDBOX_CONFIG, holisticBypassTopN: 30 },
      [-10, 0, 50, 200, 500, 1000, n]
    );
    // Negative checkpoint filtered out cleanly
    expect(curves.map((c) => c.learnedCount)).toEqual([0, 50, 200, 500, 1000, n]);
    for (let i = 1; i < curves.length; i++) {
      expect(curves[i]!.rawFreqCoveragePct).toBeGreaterThanOrEqual(curves[i - 1]!.rawFreqCoveragePct);
      expect(curves[i]!.activeAlgoCoveragePct).toBeGreaterThanOrEqual(curves[i - 1]!.activeAlgoCoveragePct);
      expect(curves[i]!.greedyUnlockCoveragePct).toBeGreaterThanOrEqual(curves[i - 1]!.greedyUnlockCoveragePct);
    }
    const at500 = curves.find((c) => c.learnedCount === 500)!;
    expect(at500.activeSupportedCoveragePct).toBeGreaterThan(at500.rawSupportedCoveragePct);

    // At full graph N, greedyUnlock must reach the exact same total corpus coverage as rawFreq (zero dropped chars!)
    const atEnd = curves[curves.length - 1]!;
    expect(atEnd.greedyUnlockCoveragePct).toBeCloseTo(atEnd.rawFreqCoveragePct, 2);
    expect(atEnd.activeAlgoCoveragePct).toBeCloseTo(atEnd.rawFreqCoveragePct, 2);

    const cov = computeKnownCoverage(merged, new Set(["的", "我", "你", "是", "了"]));
    expect(cov.knownChars).toBe(5);
    expect(cov.subtlexCoveragePct).toBeGreaterThan(10);
  });

  it("extracts focused neighborhood subgraphs with accurate truncation boundaries and maxNodes<=0 guard", () => {
    const merged = projectGraph(dataset, true);
    const sub = extractSubgraph(merged, "氵", 2, 1, 30);
    expect(sub.focusId).toBe("水");
    expect(sub.nodes.length).toBe(30);
    expect(sub.truncated).toBe(true);
    expect(sub.edges.length).toBeGreaterThan(0);

    // Exact boundary cases flagged by adversarial audit
    const cap1 = extractSubgraph(merged, "人", 2, 1, 1);
    expect(cap1.nodes.length).toBe(1);
    expect(cap1.truncated).toBe(true);

    const cap0 = extractSubgraph(merged, "水", 2, 1, 0);
    expect(cap0.nodes.length).toBe(0);
    expect(cap0.truncated).toBe(true);
  });
});
