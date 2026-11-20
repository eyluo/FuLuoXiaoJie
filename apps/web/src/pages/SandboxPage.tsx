import {
  DEFAULT_SANDBOX_CONFIG,
  resolveNodeIndex,
  type FrequencyPreset,
  type SandboxConfig,
  type ScoringAlgorithm,
  type WeightTransform,
} from "@fuluoxiaojie/graph-engine";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowUpDown, BookmarkPlus, RotateCcw, Save, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CoverageChart } from "../components/CoverageChart.js";
import { NodeDetailPanel } from "../components/NodeDetailDrawer.js";
import { RankScatterPlot } from "../components/RankScatterPlot.js";
import { useAppState } from "../hooks/useAppState.js";
import { getEffectiveStatus } from "../utils/projectionHelpers.js";

type SortKey = "rank" | "rankDelta" | "normalizedScore" | "coverageShare" | "ancestorCount";
type TableFilter = "all" | "primitives" | "hsk" | "unseen";

export function SandboxPage() {
  const {
    projected,
    scoreResult,
    sandboxConfig,
    setSandboxConfig,
    presets,
    progress,
    savePreset,
    deletePreset,
    saveSettings,
    openInExplorer,
  } = useAppState();

  const [drawerNodeId, setDrawerNodeId] = useState<string | null>(null);
  const [tableQuery, setTableQuery] = useState("");
  const [tableFilter, setTableFilter] = useState<TableFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [sortAsc, setSortAsc] = useState(true);
  const [presetName, setPresetName] = useState("");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busySave, setBusySave] = useState(false);

  const scrollParentRef = useRef<HTMLDivElement | null>(null);
  const msgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (msgTimerRef.current) clearTimeout(msgTimerRef.current);
    };
  }, []);

  // Escape closes slide-over drawer cleanly
  useEffect(() => {
    if (!drawerNodeId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerNodeId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerNodeId]);

  const showTransientMessage = (msg: string) => {
    setErrorMessage(null);
    setSaveMessage(msg);
    if (msgTimerRef.current) clearTimeout(msgTimerRef.current);
    msgTimerRef.current = setTimeout(() => setSaveMessage(null), 2400);
  };

  const patchConfig = (patch: Partial<SandboxConfig>) => {
    setSandboxConfig((prev) => ({ ...prev, ...patch }));
  };

  const filteredRows = useMemo(() => {
    if (!projected || !scoreResult) return [];
    const qRaw = tableQuery.trim();
    const q = qRaw.toLowerCase();
    const resolvedQueryIdx = qRaw ? resolveNodeIndex(projected, qRaw) : undefined;
    const resolvedQueryId = resolvedQueryIdx !== undefined ? projected.nodes[resolvedQueryIdx]!.id : null;

    const rows = scoreResult.nodes.filter((ns) => {
      const node = projected.nodes[ns.index]!;
      const status = getEffectiveStatus(projected, node.id, progress);
      if (tableFilter === "primitives" && !node.isPrimitive) return false;
      if (tableFilter === "hsk" && node.hskLevel === null) return false;
      if (tableFilter === "unseen" && status !== "unseen") return false;

      if (!q) return true;
      if (node.id === q || (resolvedQueryId && node.id === resolvedQueryId)) return true;
      if (node.pinyin.some((p) => p.toLowerCase().includes(q))) return true;
      if (node.syllables.some((s) => s.includes(q))) return true;
      return node.definition.toLowerCase().includes(q);
    });

    const sorted = [...rows];
    sorted.sort((a, b) => {
      if (sortKey === "rankDelta") {
        // Keep null-delta primitives strictly at the bottom regardless of sort direction
        if (a.rankDelta === null && b.rankDelta === null) return a.rank - b.rank;
        if (a.rankDelta === null) return 1;
        if (b.rankDelta === null) return -1;
        return sortAsc ? a.rankDelta - b.rankDelta : b.rankDelta - a.rankDelta;
      }
      let av: number;
      let bv: number;
      if (sortKey === "rank") {
        av = a.rank;
        bv = b.rank;
      } else if (sortKey === "normalizedScore") {
        av = a.normalizedScore;
        bv = b.normalizedScore;
      } else if (sortKey === "coverageShare") {
        av = a.coverageShare;
        bv = b.coverageShare;
      } else {
        av = a.ancestorCount;
        bv = b.ancestorCount;
      }
      return sortAsc ? av - bv : bv - av;
    });
    return sorted;
  }, [projected, scoreResult, tableQuery, tableFilter, sortKey, sortAsc, progress]);

  const virtualizer = useVirtualizer({
    count: filteredRows.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => 46,
    overscan: 12,
  });

  if (!projected || !scoreResult) {
    return <div className="panel panel-body">Loading Algorithm Sandbox...</div>;
  }

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc((v) => !v);
    } else {
      setSortKey(key);
      setSortAsc(key === "rank");
    }
  };

  const handleSaveDefault = async () => {
    setBusySave(true);
    setErrorMessage(null);
    try {
      await saveSettings({ sandbox: sandboxConfig });
      showTransientMessage("Saved as active default");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to save settings.");
    } finally {
      setBusySave(false);
    }
  };

  const handleCreatePreset = async () => {
    const trimmed = presetName.trim();
    if (!trimmed) return;
    setBusySave(true);
    setErrorMessage(null);
    try {
      await savePreset(trimmed);
      setPresetName("");
      showTransientMessage(`Saved preset "${trimmed}"`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to save preset.");
    } finally {
      setBusySave(false);
    }
  };

  const handleDeletePreset = async (id: string) => {
    setBusySave(true);
    setErrorMessage(null);
    try {
      await deletePreset(id);
      showTransientMessage("Preset deleted");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to delete preset.");
    } finally {
      setBusySave(false);
    }
  };

  return (
    <section aria-label="Algorithm Sandbox">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em" }}>
            DAG Propagation &amp; PageRank Sandbox
          </h1>
          <div style={{ fontSize: 13, color: "var(--ink-secondary)" }}>
            Tune frequency baselines, Zipf curves, damping, edge roles, and radical-variant contraction in real time.
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="chip chip-stone mono">
            {projected.nodes.length.toLocaleString()} nodes · {scoreResult.computeMs.toFixed(1)} ms
          </span>
          {saveMessage && <span className="chip chip-jade">{saveMessage}</span>}
        </div>
      </div>

      {errorMessage && (
        <div className="alert-error" role="alert" style={{ marginBottom: 14 }}>
          {errorMessage}
        </div>
      )}

      <div className="sandbox-layout">
        {/* Control Rail */}
        <aside className="panel sandbox-controls" aria-label="Algorithm Controls">
          <div className="panel-header">
            <h2 className="panel-title">Parameters</h2>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setSandboxConfig({ ...DEFAULT_SANDBOX_CONFIG })}
              title="Reset to defaults"
            >
              <RotateCcw size={13} /> Reset
            </button>
          </div>

          {/* Live Radical Variant & Graph Toggles */}
          <div className="control-block">
            <label htmlFor="sandbox-merge-variants-toggle" className="toggle-row">
              <div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>Merge Radical Variants</div>
                <div style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                  Contract 水/氵, 言/讠, 心/忄, 手/扌, 人/亻 into canonical nodes
                </div>
              </div>
              <button
                id="sandbox-merge-variants-toggle"
                type="button"
                role="switch"
                aria-checked={sandboxConfig.mergeVariants}
                aria-label="Merge radical variants into canonical concept nodes"
                className="switch"
                onClick={() => patchConfig({ mergeVariants: !sandboxConfig.mergeVariants })}
              />
            </label>

            <label htmlFor="sandbox-multiplicity-toggle" className="toggle-row">
              <div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>Weight Multiplicity</div>
                <div style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                  Count repeated components (e.g. 品 = 3 × 口)
                </div>
              </div>
              <button
                id="sandbox-multiplicity-toggle"
                type="button"
                role="switch"
                aria-checked={sandboxConfig.useMultiplicity}
                aria-label="Weight repeated component multiplicity"
                className="switch"
                onClick={() => patchConfig({ useMultiplicity: !sandboxConfig.useMultiplicity })}
              />
            </label>

            <label htmlFor="sandbox-remaining-mass-toggle" className="toggle-row">
              <div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>Remaining Mass Only</div>
                <div style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                  Zero base weight of already-known characters
                </div>
              </div>
              <button
                id="sandbox-remaining-mass-toggle"
                type="button"
                role="switch"
                aria-checked={sandboxConfig.onlyRemainingMass}
                aria-label="Propagate only remaining unknown character weight"
                className="switch"
                onClick={() => patchConfig({ onlyRemainingMass: !sandboxConfig.onlyRemainingMass })}
              />
            </label>
          </div>

          {/* Frequency Corpus Preset */}
          <div className="control-block">
            <label className="field-label" htmlFor="sandbox-freq-preset">
              Frequency Corpus
            </label>
            <select
              id="sandbox-freq-preset"
              className="select"
              value={sandboxConfig.frequencyPreset}
              onChange={(e) => patchConfig({ frequencyPreset: e.target.value as FrequencyPreset })}
            >
              <option value="subtlex">SUBTLEX-CH (Spoken Subtitles)</option>
              <option value="junda">Jun Da (General Written Text)</option>
              <option value="hsk">HSK 3.0 (Bands 1–9 Weighted)</option>
              <option value="blend">Custom Spoken / Written Blend</option>
            </select>

            {sandboxConfig.frequencyPreset === "blend" && (
              <div className="slider-group">
                <div className="slider-label">
                  <span>Spoken (SUBTLEX) share</span>
                  <span className="mono">{Math.round(sandboxConfig.blendSubtlexWeight * 100)}%</span>
                </div>
                <input
                  type="range"
                  aria-label="Spoken SUBTLEX blend share"
                  min={0}
                  max={1}
                  step={0.05}
                  value={sandboxConfig.blendSubtlexWeight}
                  onChange={(e) => patchConfig({ blendSubtlexWeight: Number(e.target.value) })}
                />
              </div>
            )}

            <label className="field-label" htmlFor="sandbox-zipf-transform" style={{ marginTop: 4 }}>
              Zipf Skew Transform
            </label>
            <select
              id="sandbox-zipf-transform"
              className="select"
              value={sandboxConfig.weightTransform}
              onChange={(e) => patchConfig({ weightTransform: e.target.value as WeightTransform })}
            >
              <option value="log">Log: log(1 + k·p) — tames 的/我</option>
              <option value="power">Power Law: p^γ</option>
              <option value="rank">Rank Decay: 1 / (rank + c)</option>
              <option value="raw">Raw Corpus Probability</option>
            </select>

            {sandboxConfig.weightTransform === "power" && (
              <div className="slider-group">
                <div className="slider-label">
                  <span>Exponent γ</span>
                  <span className="mono">{sandboxConfig.powerGamma.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  aria-label="Power-law exponent gamma"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={sandboxConfig.powerGamma}
                  onChange={(e) => patchConfig({ powerGamma: Number(e.target.value) })}
                />
              </div>
            )}
          </div>

          {/* Propagation Algorithm & Damping */}
          <div className="control-block">
            <label className="field-label" htmlFor="sandbox-algorithm">
              Scoring Algorithm
            </label>
            <select
              id="sandbox-algorithm"
              className="select"
              value={sandboxConfig.algorithm}
              onChange={(e) => patchConfig({ algorithm: e.target.value as ScoringAlgorithm })}
            >
              <option value="reverse-topo">DAG Reverse-Topo Propagation</option>
              <option value="pagerank">Exact DAG Personalized PageRank</option>
              <option value="coverage">Exact Ancestor Coverage (Zero Double-Count)</option>
              <option value="raw">Raw Frequency Baseline</option>
            </select>

            {(sandboxConfig.algorithm === "reverse-topo" || sandboxConfig.algorithm === "pagerank") && (
              <>
                <div className="slider-group">
                  <div className="slider-label">
                    <span>Damping (α / d)</span>
                    <span className="mono">{sandboxConfig.damping.toFixed(2)}</span>
                  </div>
                  <input
                    id="sandbox-damping-slider"
                    aria-label="Damping factor"
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={sandboxConfig.damping}
                    onChange={(e) => patchConfig({ damping: Number(e.target.value) })}
                  />
                </div>

                <div className="slider-group">
                  <div className="slider-label">
                    <span>Phonetic edge weight</span>
                    <span className="mono">{sandboxConfig.roleWeights.phonetic.toFixed(1)}×</span>
                  </div>
                  <input
                    type="range"
                    aria-label="Phonetic edge weight"
                    min={0}
                    max={3}
                    step={0.1}
                    value={sandboxConfig.roleWeights.phonetic}
                    onChange={(e) =>
                      patchConfig({
                        roleWeights: { ...sandboxConfig.roleWeights, phonetic: Number(e.target.value) },
                      })
                    }
                  />
                </div>

                <div className="slider-group">
                  <div className="slider-label">
                    <span>Semantic edge weight</span>
                    <span className="mono">{sandboxConfig.roleWeights.semantic.toFixed(1)}×</span>
                  </div>
                  <input
                    type="range"
                    aria-label="Semantic edge weight"
                    min={0}
                    max={3}
                    step={0.1}
                    value={sandboxConfig.roleWeights.semantic}
                    onChange={(e) =>
                      patchConfig({
                        roleWeights: { ...sandboxConfig.roleWeights, semantic: Number(e.target.value) },
                      })
                    }
                  />
                </div>

                <div className="slider-group">
                  <div className="slider-label">
                    <span>Structural edge weight</span>
                    <span className="mono">{sandboxConfig.roleWeights.structural.toFixed(1)}×</span>
                  </div>
                  <input
                    type="range"
                    aria-label="Structural edge weight"
                    min={0}
                    max={3}
                    step={0.1}
                    value={sandboxConfig.roleWeights.structural}
                    onChange={(e) =>
                      patchConfig({
                        roleWeights: { ...sandboxConfig.roleWeights, structural: Number(e.target.value) },
                      })
                    }
                  />
                </div>
              </>
            )}

            <div className="slider-group">
              <div className="slider-label">
                <span>Holistic bypass cutoff (top N)</span>
                <span className="mono">{sandboxConfig.holisticBypassTopN}</span>
              </div>
              <input
                type="range"
                aria-label="Holistic bypass cutoff top N"
                min={0}
                max={300}
                step={10}
                value={sandboxConfig.holisticBypassTopN}
                onChange={(e) => patchConfig({ holisticBypassTopN: Number(e.target.value) })}
              />
            </div>
          </div>

          {/* Save Default & Named Presets */}
          <div className="control-block">
            <button
              id="sandbox-save-default-btn"
              type="button"
              className="btn btn-primary"
              disabled={busySave}
              onClick={() => void handleSaveDefault()}
              style={{ width: "100%" }}
            >
              <Save size={14} /> {busySave ? "Saving..." : "Save as Active Default"}
            </button>

            <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
              <input
                className="input"
                type="text"
                maxLength={80}
                aria-label="Preset name"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && presetName.trim() && !busySave) {
                    void handleCreatePreset();
                  }
                }}
                placeholder="Save preset name..."
              />
              <button
                type="button"
                className="btn btn-icon"
                disabled={busySave || !presetName.trim()}
                onClick={() => void handleCreatePreset()}
                title="Save preset"
                aria-label="Save named preset"
              >
                <BookmarkPlus size={15} />
              </button>
            </div>

            {presets.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 4 }}>
                {presets.map((p) => (
                  <div
                    key={p.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 6,
                      padding: "5px 8px",
                      borderRadius: "var(--radius-sm)",
                      background: "var(--bg-paper)",
                    }}
                  >
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ flex: 1, justifyContent: "flex-start", padding: "2px 4px" }}
                      onClick={() =>
                        setSandboxConfig({
                          ...DEFAULT_SANDBOX_CONFIG,
                          ...p.config,
                          roleWeights: {
                            ...DEFAULT_SANDBOX_CONFIG.roleWeights,
                            ...(p.config.roleWeights ?? {}),
                          },
                        })
                      }
                    >
                      {p.name}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      disabled={busySave}
                      onClick={() => void handleDeletePreset(p.id)}
                      aria-label={`Delete preset ${p.name}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>

        {/* Main Charts + Virtualized Ranked Table */}
        <div className="sandbox-main">
          <div className="charts-grid">
            <RankScatterPlot
              projected={projected}
              scoreResult={scoreResult}
              onSelectNode={(id) => setDrawerNodeId(id)}
            />
            <CoverageChart projected={projected} config={sandboxConfig} />
          </div>

          <div className="panel">
            <div className="vtable-toolbar">
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <h2 className="panel-title">
                  Ranked Nodes ({filteredRows.length.toLocaleString()})
                </h2>
                <div className="segmented" role="tablist" aria-label="Filter ranked nodes">
                  {(
                    [
                      ["all", "All"],
                      ["primitives", "Primitives"],
                      ["hsk", "HSK 3.0"],
                      ["unseen", "Unseen"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={tableFilter === id}
                      className={tableFilter === id ? "active" : ""}
                      onClick={() => setTableFilter(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="search-input-wrap" style={{ width: 250 }}>
                <Search size={14} className="search-icon" />
                <input
                  className="input"
                  type="search"
                  aria-label="Filter ranked nodes by character, pinyin, or meaning"
                  value={tableQuery}
                  onChange={(e) => setTableQuery(e.target.value)}
                  placeholder="Filter character, pinyin, meaning..."
                />
              </div>
            </div>

            <div className="vtable-head">
              <button type="button" onClick={() => toggleSort("rank")}>
                Rank <ArrowUpDown size={11} />
              </button>
              <button type="button" onClick={() => toggleSort("rankDelta")}>
                ΔRank <ArrowUpDown size={11} />
              </button>
              <span>Glyph</span>
              <span>Pinyin</span>
              <span>Meaning</span>
              <button type="button" onClick={() => toggleSort("normalizedScore")}>
                Score <ArrowUpDown size={11} />
              </button>
              <button type="button" className="vtable-hide-sm" onClick={() => toggleSort("coverageShare")}>
                Reach % <ArrowUpDown size={11} />
              </button>
              <button type="button" className="vtable-hide-sm" onClick={() => toggleSort("ancestorCount")}>
                Family <ArrowUpDown size={11} />
              </button>
              <span className="vtable-hide-sm">Status</span>
            </div>

            <div className="vtable-scroll" ref={scrollParentRef}>
              <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
                {virtualizer.getVirtualItems().map((vRow) => {
                  const ns = filteredRows[vRow.index]!;
                  const node = projected.nodes[ns.index]!;
                  const status = getEffectiveStatus(projected, node.id, progress);
                  return (
                    <div
                      key={ns.id}
                      role="button"
                      tabIndex={0}
                      className={`vtable-row${drawerNodeId === ns.id ? " selected" : ""}`}
                      style={{ transform: `translateY(${vRow.start}px)` }}
                      onClick={() => setDrawerNodeId(ns.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setDrawerNodeId(ns.id);
                        }
                      }}
                    >
                      <span className="mono" style={{ fontWeight: 650 }}>
                        #{ns.rank}
                      </span>
                      <span
                        className="mono"
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color:
                            ns.rankDelta === null
                              ? "var(--slate)"
                              : ns.rankDelta > 0
                                ? "var(--jade)"
                                : ns.rankDelta < 0
                                  ? "var(--vermilion)"
                                  : "var(--ink-muted)",
                        }}
                      >
                        {ns.rankDelta === null
                          ? "PRIM"
                          : ns.rankDelta > 0
                            ? `+${ns.rankDelta}`
                            : String(ns.rankDelta)}
                      </span>
                      <span className="hanzi" style={{ fontSize: 22 }}>
                        {node.id}
                      </span>
                      <span style={{ color: "var(--vermilion)", fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {node.pinyin[0] ?? "—"}
                      </span>
                      <span style={{ fontSize: 12.5, color: "var(--ink-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {node.definition}
                      </span>
                      <span className="mono" style={{ fontSize: 12.5 }}>
                        {ns.normalizedScore.toFixed(1)}
                      </span>
                      <span className="mono vtable-hide-sm" style={{ fontSize: 12 }}>
                        {(ns.coverageShare * 100).toFixed(2)}%
                      </span>
                      <span className="mono vtable-hide-sm" style={{ fontSize: 12, color: "var(--ink-secondary)" }}>
                        {Math.max(0, ns.ancestorCount - 1)}
                      </span>
                      <span className="vtable-hide-sm">
                        {status === "known" ? (
                          <span className="chip chip-jade">Known</span>
                        ) : status === "learning" ? (
                          <span className="chip chip-ochre">Learning</span>
                        ) : status === "ignored" ? (
                          <span className="chip chip-stone">Ignored</span>
                        ) : (
                          <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>Unseen</span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Slide-Over Detail Drawer */}
      {drawerNodeId && (
        <div
          className="drawer-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Details for ${drawerNodeId}`}
          onClick={(e) => {
            if (e.target === e.currentTarget) setDrawerNodeId(null);
          }}
        >
          <div className="drawer-sheet">
            <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  openInExplorer(drawerNodeId);
                  setDrawerNodeId(null);
                }}
              >
                Open in DAG Explorer
              </button>
              <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>Inspecting {drawerNodeId}</span>
            </div>
            <NodeDetailPanel
              nodeId={drawerNodeId}
              onSelectNode={(id) => setDrawerNodeId(id)}
              onClose={() => setDrawerNodeId(null)}
            />
          </div>
        </div>
      )}
    </section>
  );
}
