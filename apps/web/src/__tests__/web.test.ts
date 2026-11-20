import { projectGraph, type GraphDataset, type GraphNode } from "@fuluoxiaojie/graph-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, setUnauthorizedHandler, type ProgressEntry } from "../api/client.js";
import { AudioBlobCache } from "../hooks/useAudio.js";
import {
  buildHeatmapGrid,
  fillForecast14d,
  matchPinyinAnswer,
  parseImportedCharacters,
  parsePinyinSyllable,
} from "../utils/pinyinMatch.js";
import {
  buildSatisfiedIdSet,
  computeHoverBands,
  getEffectiveNotes,
  getEffectiveStatus,
  isNodeEnrolled,
  logRankFraction,
} from "../utils/projectionHelpers.js";

function makeNode(id: string, isPrimitive = false): GraphNode {
  return {
    id,
    isPrimitive,
    strokes: 4,
    hasStrokes: true,
    strokeFile: null,
    pinyin: [],
    syllables: [],
    audio: null,
    definition: id,
    radical: id,
    decomposition: null,
    etymology: null,
    hskLevel: 1,
    freq: {
      subtlexCount: 100,
      subtlexRank: 1,
      subtlexShare: 0.01,
      jundaCount: 100,
      jundaRank: 1,
      jundaShare: 0.01,
    },
  };
}

const sampleDataset: GraphDataset = {
  meta: {
    version: "1",
    generatedAt: "2026-01-01T00:00:00Z",
    characterCount: 2,
    primitiveCount: 1,
    nodeCount: 3,
    edgeCount: 1,
    subtlexTotalCount: 1000,
    jundaTotalCount: 1000,
    subtlexCoveragePct: 100,
    jundaCoveragePct: 100,
  },
  variantMap: { "氵": "水" },
  nodes: [makeNode("水"), makeNode("氵", true), makeNode("清")],
  edges: [{ source: "氵", target: "清", multiplicity: 1, role: "semantic" }],
};

describe("Frontend Projection Helpers & Chart Geometry", () => {
  it("resolves variant-alias progress, notes, enrollment, and satisfied sets under mergeVariants=true", () => {
    const merged = projectGraph(sampleDataset, true);
    const progress: Record<string, ProgressEntry> = {
      "氵": {
        status: "known",
        source: "manual",
        notes: "three drops of water",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    };

    expect(getEffectiveStatus(merged, "水", progress)).toBe("known");
    expect(getEffectiveNotes(merged, "水", progress)).toBe("three drops of water");
    expect(isNodeEnrolled(merged, "水", new Set(["氵"]))).toBe(true);
    expect(buildSatisfiedIdSet(merged, progress).has("水")).toBe(true);

    // Under split mode, 水 remains distinct from 氵
    const split = projectGraph(sampleDataset, false);
    expect(getEffectiveStatus(split, "水", progress)).toBe("unseen");
    expect(getEffectiveStatus(split, "氵", progress)).toBe("known");
  });

  it("maps 1-indexed ranks accurately onto shared [0, 1] log scale", () => {
    expect(logRankFraction(1, 3000)).toBe(0);
    expect(logRankFraction(3000, 3000)).toBeCloseTo(1, 10);
    expect(logRankFraction(10, 1000)).toBeCloseTo(1 / 3, 10);
    expect(logRankFraction(100, 1000)).toBeCloseTo(2 / 3, 10);
  });

  it("produces strictly contiguous, non-overlapping Voronoi hover bands covering dense & sparse checkpoints", () => {
    const xs = [42, 46, 50, 58, 120, 504];
    const bands = computeHoverBands(xs, 42, 504);
    expect(bands.length).toBe(xs.length);
    expect(bands[0]!.x).toBe(42);
    for (let i = 0; i < bands.length; i++) {
      expect(bands[i]!.width).toBeGreaterThan(0);
      expect(xs[i]!).toBeGreaterThanOrEqual(bands[i]!.x);
      expect(xs[i]!).toBeLessThanOrEqual(bands[i]!.x + bands[i]!.width);
      if (i > 0) {
        // Adjacent bands meet edge-to-edge with zero overlap and zero dead zones
        expect(bands[i]!.x).toBeCloseTo(bands[i - 1]!.x + bands[i - 1]!.width, 10);
      }
    }
    const last = bands[bands.length - 1]!;
    expect(last.x + last.width).toBeCloseTo(504, 10);
  });
});

describe("AudioBlobCache LRU & API Client 401 Handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setUnauthorizedHandler(null);
  });

  it("deduplicates concurrent fetches and revokes Blob URLs on LRU eviction and clear()", async () => {
    let counter = 0;
    const revoked: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test-${++counter}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((u) => {
      revoked.push(u);
    });

    const cache = new AudioBlobCache(2);
    let fetches = 0;
    const fetcher = async () => {
      fetches++;
      return new Blob(["mp3"]);
    };

    // Concurrent calls for same key share one fetch and one Blob URL
    const [u1, u2] = await Promise.all([
      cache.getOrFetch("qing1.mp3", fetcher),
      cache.getOrFetch("qing1.mp3", fetcher),
    ]);
    expect(u1).toBe(u2);
    expect(fetches).toBe(1);

    await cache.getOrFetch("qing2.mp3", fetcher);
    // Touch qing1 so qing2 becomes LRU
    expect(cache.get("qing1.mp3")).toBe("blob:test-1");
    await cache.getOrFetch("qing3.mp3", fetcher);

    expect(cache.size).toBe(2);
    expect(revoked).toEqual(["blob:test-2"]);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(revoked).toContain("blob:test-1");
    expect(revoked).toContain("blob:test-3");
  });

  it("triggers centralized 401 handler and preserves Content-Type when custom headers are passed", async () => {
    const onUnauth = vi.fn();
    setUnauthorizedHandler(onUnauth);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(api.updateProgress("青", { status: "known" })).rejects.toThrow("Authentication required");
    expect(onUnauth).toHaveBeenCalledTimes(1);

    const reqInit = fetchSpy.mock.calls[0]?.[1];
    const hdrs = new Headers(reqInit?.headers);
    expect(hdrs.get("content-type")).toBe("application/json");
  });
});

describe("Phase 5 Pinyin Matching, Bulk Import Parsing & Stats Calendars", () => {
  it("normalizes tone-marked, numbered, ü/v/u:/uu, j/q/x/y+v, and neutral-tone pinyin answers", () => {
    expect(parsePinyinSyllable("qǐng")).toEqual({ base: "qing", tone: 3 });
    expect(parsePinyinSyllable("  QING3 ")).toEqual({ base: "qing", tone: 3 });
    expect(parsePinyinSyllable("nǚ")).toEqual({ base: "nv", tone: 3 });
    expect(parsePinyinSyllable("nu:3")).toEqual({ base: "nv", tone: 3 });
    expect(parsePinyinSyllable("nuu3")).toEqual({ base: "nv", tone: 3 });
    expect(parsePinyinSyllable("lüè")).toEqual({ base: "lve", tone: 4 });
    expect(parsePinyinSyllable("yv4")).toEqual({ base: "yu", tone: 4 });

    expect(matchPinyinAnswer("qing3", ["qǐng"], ["qing3"])).toEqual({
      status: "exact",
      matchedReading: "qǐng",
    });
    expect(matchPinyinAnswer("qǐng", ["qǐng"], ["qing3"])).toEqual({
      status: "exact",
      matchedReading: "qǐng",
    });
    expect(matchPinyinAnswer("lv4", ["lǜ", "lù"], ["lv4", "lu4"])).toEqual({
      status: "exact",
      matchedReading: "lǜ",
    });
    expect(matchPinyinAnswer("lu4", ["lǜ", "lù"], ["lv4", "lu4"])).toEqual({
      status: "exact",
      matchedReading: "lù",
    });
    // Neutral tone matches unmarked input and explicit 5
    expect(matchPinyinAnswer("de", ["de", "dí"], ["de5", "di2"])).toEqual({
      status: "exact",
      matchedReading: "de",
    });
    expect(matchPinyinAnswer("de5", ["de", "dí"], ["de5", "di2"])).toEqual({
      status: "exact",
      matchedReading: "de",
    });
    // Right syllable, wrong or omitted tone -> tone-close
    expect(matchPinyinAnswer("qing1", ["qǐng"], ["qing3"])).toEqual({
      status: "tone-close",
      matchedReading: "qǐng",
    });
    expect(matchPinyinAnswer("qing", ["qǐng"], ["qing3"])).toEqual({
      status: "tone-close",
      matchedReading: "qǐng",
    });
    // NFD combining marks present in graph.json (姆 m̄, 呣 m̀) and decomposed ü + tone
    expect(parsePinyinSyllable("m\u0304")).toEqual({ base: "m", tone: 1 });
    expect(parsePinyinSyllable("m\u0300")).toEqual({ base: "m", tone: 4 });
    expect(parsePinyinSyllable("lu\u0304\u0308")).toEqual({ base: "lv", tone: 1 });
    expect(parsePinyinSyllable("lu\u0308\u0304")).toEqual({ base: "lv", tone: 1 });
    expect(matchPinyinAnswer("m\u0304", ["mǔ", "m\u0304"], ["mu3", "m1"])).toEqual({
      status: "exact",
      matchedReading: "m\u0304",
    });
    expect(matchPinyinAnswer("m\u0300", ["ḿ", "m\u0300"], ["m2", "m4"])).toEqual({
      status: "exact",
      matchedReading: "m\u0300",
    });
    // Reject contradictory / duplicate tone markers
    expect(parsePinyinSyllable("qīng3")).toBeNull();
    expect(parsePinyinSyllable("māá")).toBeNull();
    expect(matchPinyinAnswer("qīng3", ["qǐng"], ["qing3"]).status).toBe("wrong");
    // Wrong syllable
    expect(matchPinyinAnswer("ma1", ["qǐng"], ["qing3"]).status).toBe("wrong");
    expect(matchPinyinAnswer("   ", ["qǐng"], ["qing3"]).status).toBe("empty");
  });

  it("deduplicates non-ASCII characters from CSV/TSV/freeform bulk imports", () => {
    const parsed = parseImportedCharacters("char,pinyin\n青,qing1\n请,qing3\n晴,qing2\n青,duplicate");
    expect(parsed).toEqual(["青", "请", "晴"]);
  });

  it("fills contiguous UTC 13-week heatmap grid and clamps overdue dates into Today in 14-day forecast", () => {
    const grid = buildHeatmapGrid(
      [
        { date: "2026-11-20", count: 14, againCount: 2 },
        { date: "2026-11-18", count: 5, againCount: 0 },
      ],
      "2026-11-20"
    );
    expect(grid.length).toBeGreaterThanOrEqual(85);
    expect(grid.length).toBeLessThanOrEqual(91);
    expect(grid[0]!.dayOfWeek).toBe(0); // Sunday-aligned start
    expect(grid[grid.length - 1]!.date).toBe("2026-11-20");
    expect(grid[grid.length - 1]!.count).toBe(14);
    expect(grid[grid.length - 1]!.againCount).toBe(2);

    const fc = fillForecast14d(
      [
        { date: "2026-11-18", count: 7 }, // overdue -> clamped into Today
        { date: "2026-11-20", count: 3 },
        { date: "2026-11-23", count: 4 },
      ],
      "2026-11-20"
    );
    expect(fc).toHaveLength(14);
    expect(fc[0]).toEqual({ date: "2026-11-20", label: "Today", count: 10 });
    expect(fc[1]).toEqual({ date: "2026-11-21", label: "11-21", count: 0 });
    expect(fc[3]).toEqual({ date: "2026-11-23", label: "11-23", count: 4 });
    expect(fc[13]!.date).toBe("2026-12-03");
  });
});

