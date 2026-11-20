export type EdgeRole = "semantic" | "phonetic" | "structural";

export interface NodeEtymology {
  type: "pictophonetic" | "ideographic" | "pictographic";
  semantic?: string;
  phonetic?: string;
  hint?: string;
}

export interface NodeFrequency {
  subtlexCount: number;
  subtlexRank: number | null;
  subtlexShare: number;
  jundaCount: number;
  jundaRank: number | null;
  jundaShare: number;
}

export interface GraphNode {
  id: string;
  isPrimitive: boolean;
  strokes: number;
  hasStrokes: boolean;
  strokeFile: string | null;
  pinyin: string[];
  syllables: string[];
  audio: string | null;
  definition: string;
  radical: string | null;
  decomposition: string | null;
  etymology: NodeEtymology | null;
  hskLevel: number | null;
  freq: NodeFrequency;
}

export interface GraphEdge {
  source: string;
  target: string;
  multiplicity: number;
  role: EdgeRole;
}

export interface GraphMeta {
  version: string;
  generatedAt: string;
  characterCount: number;
  primitiveCount: number;
  nodeCount: number;
  edgeCount: number;
  subtlexTotalCount: number;
  jundaTotalCount: number;
  subtlexCoveragePct: number;
  jundaCoveragePct: number;
}

export interface GraphDataset {
  meta: GraphMeta;
  variantMap: Record<string, string>;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface IndexedEdge {
  sourceIdx: number;
  targetIdx: number;
  multiplicity: number;
  role: EdgeRole;
}

export interface ProjectedGraph {
  mergeVariants: boolean;
  nodes: GraphNode[];
  edges: IndexedEdge[];
  idToIndex: Map<string, number>;
  /** Direct components (prerequisites) of each node: incoming[targetIdx] */
  incoming: IndexedEdge[][];
  /** Direct compounds using each node: outgoing[sourceIdx] */
  outgoing: IndexedEdge[][];
  /** Topological order (indices): components appear strictly before compounds */
  topoOrder: Int32Array;
  /** Canonical ID -> list of contracted variant glyphs when mergeVariants=true */
  mergedFrom: Record<string, string[]>;
  /** Any original glyph -> canonical node ID in this projection */
  canonicalOf: Record<string, string>;
}

export type FrequencyPreset = "subtlex" | "junda" | "hsk" | "blend";
export type WeightTransform = "log" | "power" | "rank" | "raw";
export type ScoringAlgorithm = "reverse-topo" | "pagerank" | "coverage" | "raw";
export type PlannerStrategy = "priority-topo" | "greedy-unlock";

export interface RoleWeights {
  semantic: number;
  phonetic: number;
  structural: number;
}

export interface SandboxConfig {
  mergeVariants: boolean;
  frequencyPreset: FrequencyPreset;
  blendSubtlexWeight: number;
  weightTransform: WeightTransform;
  logScale: number;
  powerGamma: number;
  rankOffset: number;
  algorithm: ScoringAlgorithm;
  damping: number;
  useMultiplicity: boolean;
  roleWeights: RoleWeights;
  onlyRemainingMass: boolean;
  holisticBypassTopN: number;
  plannerStrategy: PlannerStrategy;
  greedyClusterExponent: number;
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  mergeVariants: true,
  frequencyPreset: "subtlex",
  blendSubtlexWeight: 0.5,
  weightTransform: "log",
  logScale: 5000,
  powerGamma: 0.5,
  rankOffset: 25,
  algorithm: "reverse-topo",
  damping: 0.85,
  useMultiplicity: true,
  roleWeights: {
    semantic: 1.2,
    phonetic: 1.5,
    structural: 1.0,
  },
  onlyRemainingMass: true,
  holisticBypassTopN: 50,
  plannerStrategy: "priority-topo",
  greedyClusterExponent: 1.15,
};

export interface NodeScore {
  id: string;
  index: number;
  rawWeight: number;
  rawCorpusShare: number;
  score: number;
  normalizedScore: number;
  rank: number;
  rawRank: number | null;
  rankDelta: number | null;
  coverageShare: number;
  ancestorCount: number;
}

export interface ScoreResult {
  config: SandboxConfig;
  nodes: NodeScore[];
  byId: Map<string, NodeScore>;
  computeMs: number;
}

export type QueueReason = "unlocked" | "holistic-bypass" | "cluster-prereq" | "cluster-target";

export interface QueueItem {
  id: string;
  reason: QueueReason;
  score: number;
  normalizedScore: number;
  rawFreqShare: number;
  missingPrereqs: string[];
  unlocksCount: number;
  clusterTarget?: string;
  clusterGain?: number;
}

export interface SubgraphResult {
  focusId: string;
  nodes: Array<{
    id: string;
    distance: number; // negative = upstream component, 0 = focus, positive = downstream compound
    node: GraphNode;
  }>;
  edges: GraphEdge[];
  truncated: boolean;
}

export interface CoverageCurvePoint {
  learnedCount: number;
  rawFreqCoveragePct: number;
  activeAlgoCoveragePct: number;
  greedyUnlockCoveragePct: number;
  activeSupportedCoveragePct: number;
  rawSupportedCoveragePct: number;
}

export interface KnownCoverageSummary {
  knownChars: number;
  totalChars: number;
  knownPrimitives: number;
  totalPrimitives: number;
  subtlexCoveragePct: number;
  jundaCoveragePct: number;
  hskCoverage: Record<number, { known: number; total: number }>;
}
