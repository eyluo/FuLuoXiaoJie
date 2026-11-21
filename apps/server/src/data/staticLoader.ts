import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { projectGraph, type GraphDataset, type ProjectedGraph } from "@fuluoxiaojie/graph-engine";

export interface ExampleWord {
  word: string;
  pinyin: string;
  numbered: string;
  gloss: string;
  freq: number;
  audio?: string;
}

export type ExamplesMap = Record<string, ExampleWord[]>;

const STROKE_FILE_RE = /^u[0-9a-f]{4,6}\.json$/;
const AUDIO_FILE_RE = /^(?:[a-zv]+[1-5]|w_[0-9a-f]{4,64})\.mp3$/;

export interface StaticDataStore {
  staticDataDir: string;
  graph: GraphDataset;
  graphJsonRaw: string;
  examples: ExamplesMap;
  examplesJsonRaw: string;
  rawProjection: ProjectedGraph;
  mergedProjection: ProjectedGraph;
  getProjection(mergeVariants: boolean): ProjectedGraph;
  readStrokeFile(filename: string): string | null;
  readAudioFile(filename: string): Uint8Array | null;
}

export function loadStaticDataStore(staticDataDir: string): StaticDataStore {
  const graphPath = resolve(staticDataDir, "graph.json");
  const examplesPath = resolve(staticDataDir, "examples.json");

  if (!existsSync(graphPath)) {
    throw new Error(`Missing compiled graph.json at ${graphPath}. Run 'pnpm run data:build' first.`);
  }
  const graphJsonRaw = readFileSync(graphPath, "utf-8");
  const graph = JSON.parse(graphJsonRaw) as GraphDataset;

  const examplesJsonRaw = existsSync(examplesPath) ? readFileSync(examplesPath, "utf-8") : "{}";
  const examples = JSON.parse(examplesJsonRaw) as ExamplesMap;

  const rawProjection = projectGraph(graph, false);
  const mergedProjection = projectGraph(graph, true);

  const strokesDir = resolve(staticDataDir, "strokes");
  const audioDir = resolve(staticDataDir, "audio");

  return {
    staticDataDir,
    graph,
    graphJsonRaw,
    examples,
    examplesJsonRaw,
    rawProjection,
    mergedProjection,
    getProjection(mergeVariants: boolean) {
      return mergeVariants ? mergedProjection : rawProjection;
    },
    readStrokeFile(filename: string): string | null {
      if (!STROKE_FILE_RE.test(filename)) return null;
      const fullPath = resolve(strokesDir, filename);
      if (!fullPath.startsWith(strokesDir + "/")) return null;
      if (!existsSync(fullPath)) return null;
      return readFileSync(fullPath, "utf-8");
    },
    readAudioFile(filename: string): Uint8Array | null {
      if (!AUDIO_FILE_RE.test(filename)) return null;
      const fullPath = resolve(audioDir, filename);
      if (!fullPath.startsWith(audioDir + "/")) return null;
      if (!existsSync(fullPath)) return null;
      return readFileSync(fullPath);
    },
  };
}
