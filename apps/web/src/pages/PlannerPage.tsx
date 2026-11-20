import { buildStudyQueue, type QueueItem } from "@fuluoxiaojie/graph-engine";
import {
  Check,
  Download,
  ExternalLink,
  Plus,
  Save,
  Sparkles,
  Upload,
  Volume2,
} from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client.js";
import { BulkImportModal } from "../components/BulkImportModal.js";
import { NodeDetailPanel } from "../components/NodeDetailDrawer.js";
import { useAppState } from "../hooks/useAppState.js";
import { useMandarinAudio } from "../hooks/useAudio.js";
import { triggerBlobDownload } from "../utils/pinyinMatch.js";
import { isNodeEnrolled } from "../utils/projectionHelpers.js";

type ReasonFilter = "all" | "unlocked" | "holistic-bypass" | "cluster";

export function PlannerPage() {
  const {
    projected,
    sandboxConfig,
    setSandboxConfig,
    knownIds,
    ignoredIds,
    enrolledNodeIds,
    scoreResult,
    coverageSummary,
    updateNodeProgress,
    bulkImportProgress,
    enrollNodes,
    ensureServerMergeModeAligned,
    saveSettings,
    openInExplorer,
  } = useAppState();
  const { playSyllable } = useMandarinAudio();

  const [queueLimit, setQueueLimit] = useState(60);
  const [hidePrimitives, setHidePrimitives] = useState(false);
  const [hideEnrolled, setHideEnrolled] = useState(false);
  const [reasonFilter, setReasonFilter] = useState<ReasonFilter>("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [drawerNodeId, setDrawerNodeId] = useState<string | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);

  const [deckTitle, setDeckTitle] = useState("FuLuoXiaoJie (弗洛小姐)");
  const [exportingFormat, setExportingFormat] = useState<"csv" | "apkg" | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [busyRowIds, setBusyRowIds] = useState<Set<string>>(() => new Set());
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!drawerNodeId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerNodeId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerNodeId]);

  // Defer sandbox slider updates paired with matching scoreResult so slider drags stay responsive
  const calcInput = useMemo(
    () => ({ config: sandboxConfig, score: scoreResult }),
    [sandboxConfig, scoreResult]
  );
  const deferredCalc = useDeferredValue(calcInput);

  const rawQueue = useMemo(() => {
    if (!projected) return [] as QueueItem[];
    return buildStudyQueue(
      projected,
      deferredCalc.config,
      knownIds,
      ignoredIds,
      queueLimit,
      deferredCalc.score ?? undefined
    );
  }, [projected, deferredCalc, knownIds, ignoredIds, queueLimit]);

  const visibleQueue = useMemo(() => {
    if (!projected) return [] as QueueItem[];
    return rawQueue.filter((item) => {
      const idx = projected.idToIndex.get(item.id);
      if (idx === undefined) return false;
      const node = projected.nodes[idx]!;
      if (hidePrimitives && node.isPrimitive) return false;
      if (hideEnrolled && isNodeEnrolled(projected, item.id, enrolledNodeIds)) return false;
      if (reasonFilter === "unlocked" && item.reason !== "unlocked") return false;
      if (reasonFilter === "holistic-bypass" && item.reason !== "holistic-bypass") return false;
      if (reasonFilter === "cluster" && item.reason !== "cluster-prereq" && item.reason !== "cluster-target") {
        return false;
      }
      return true;
    });
  }, [projected, rawQueue, hidePrimitives, hideEnrolled, enrolledNodeIds, reasonFilter]);

  const queueCounts = useMemo(() => {
    let unlocked = 0;
    let bypass = 0;
    let cluster = 0;
    for (const q of rawQueue) {
      if (q.reason === "unlocked") unlocked++;
      else if (q.reason === "holistic-bypass") bypass++;
      else cluster++;
    }
    return { unlocked, bypass, cluster };
  }, [rawQueue]);

  // Prune checkbox selections that are no longer visible in the queue
  useEffect(() => {
    const visibleSet = new Set(visibleQueue.map((q) => q.id));
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visibleSet.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [visibleQueue]);

  const flashStatus = (msg: string) => {
    setStatusMessage(msg);
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => setStatusMessage(null), 3200);
  };

  if (!projected) {
    return <div className="panel panel-body">Loading study planner...</div>;
  }

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allVisibleSelected =
    visibleQueue.length > 0 && visibleQueue.every((q) => selectedIds.has(q.id));

  const toggleSelectAll = () => {
    if (allVisibleSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(visibleQueue.map((q) => q.id)));
    }
  };

  const handleRowEnroll = async (id: string) => {
    setBusyRowIds((prev) => new Set(prev).add(id));
    setErrorMsg(null);
    try {
      const res = await enrollNodes([id]);
      flashStatus(`Added ${id} to SRS (${res.createdCards} new card${res.createdCards === 1 ? "" : "s"}).`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : `Failed to enroll ${id}.`);
    } finally {
      setBusyRowIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleRowKnown = async (id: string) => {
    setBusyRowIds((prev) => new Set(prev).add(id));
    setErrorMsg(null);
    try {
      await updateNodeProgress(id, { status: "known" });
      flashStatus(`Marked ${id} as Known — queue recalculated.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : `Failed to mark ${id} known.`);
    } finally {
      setBusyRowIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleBatchEnroll = async () => {
    const ids = Array.from(selectedIds).slice(0, 200);
    if (ids.length === 0) return;
    setBatchBusy(true);
    setErrorMsg(null);
    try {
      const res = await enrollNodes(ids);
      setSelectedIds(new Set());
      flashStatus(`Enrolled ${res.enrolledNodes.length} characters (${res.createdCards} FSRS cards created).`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Batch enrollment failed.");
    } finally {
      setBatchBusy(false);
    }
  };

  const handleBatchKnown = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBatchBusy(true);
    setErrorMsg(null);
    try {
      const res = await bulkImportProgress({ mode: "list", nodeIds: ids, status: "known" });
      setSelectedIds(new Set());
      flashStatus(`Marked ${res.importedCount} characters as Known.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Batch update failed.");
    } finally {
      setBatchBusy(false);
    }
  };

  const handleSavePlannerSettings = async () => {
    setSavingConfig(true);
    setErrorMsg(null);
    try {
      await saveSettings({ sandbox: sandboxConfig });
      setSavedNotice(true);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSavedNotice(false), 1800);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Could not save planner settings.");
    } finally {
      setSavingConfig(false);
    }
  };

  const handleAnkiExport = async (format: "csv" | "apkg") => {
    const targetIds =
      selectedIds.size > 0
        ? Array.from(selectedIds)
        : visibleQueue.map((q) => q.id);

    if (targetIds.length === 0) {
      setErrorMsg("No characters in the current queue to export.");
      return;
    }

    setExportingFormat(format);
    setErrorMsg(null);
    try {
      await ensureServerMergeModeAligned();
      const { blob, filename } = await api.exportAnkiBlob({
        format,
        nodeIds: targetIds.slice(0, 1000),
        deckTitle: deckTitle.trim() || "FuLuoXiaoJie (弗洛小姐)",
      });
      triggerBlobDownload(blob, filename);
      flashStatus(
        `Exported ${Math.min(targetIds.length, 1000)} characters as ${format.toUpperCase()}.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : `Anki ${format.toUpperCase()} export failed.`);
    } finally {
      setExportingFormat(null);
    }
  };

  const renderReasonChip = (item: QueueItem) => {
    if (item.reason === "unlocked") {
      return <span className="chip chip-jade">Unlocked</span>;
    }
    if (item.reason === "holistic-bypass") {
      return (
        <span
          className="chip chip-ochre"
          title={`Top-${sandboxConfig.holisticBypassTopN} frequency bypass — skips unlearned parts: ${item.missingPrereqs.join(", ")}`}
        >
          Holistic Bypass · skips {item.missingPrereqs.join(" ")}
        </span>
      );
    }
    if (item.reason === "cluster-prereq") {
      return (
        <span className="chip chip-slate">
          Prereq → {item.clusterTarget}
        </span>
      );
    }
    return <span className="chip chip-vermilion">Cluster Target</span>;
  };

  const exportCount = selectedIds.size > 0 ? selectedIds.size : visibleQueue.length;

  return (
    <div className="planner-grid">
      {/* Left Sticky Controls Sidebar */}
      <aside className="panel sandbox-controls" aria-label="Study planner controls">
        <div className="panel-header">
          <h1 className="panel-title">Study Planner</h1>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={savingConfig}
            onClick={() => void handleSavePlannerSettings()}
          >
            <Save size={13} /> {savedNotice ? "Saved" : savingConfig ? "Saving..." : "Save"}
          </button>
        </div>

        {/* Queue Strategy */}
        <div className="control-block">
          <span className="field-label" style={{ marginBottom: 0 }}>
            Queue Strategy
          </span>
          <div className="segmented" style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
            <button
              type="button"
              className={sandboxConfig.plannerStrategy === "priority-topo" ? "active" : ""}
              onClick={() =>
                setSandboxConfig((prev) => ({ ...prev, plannerStrategy: "priority-topo" }))
              }
            >
              Priority Topo
            </button>
            <button
              type="button"
              className={sandboxConfig.plannerStrategy === "greedy-unlock" ? "active" : ""}
              onClick={() =>
                setSandboxConfig((prev) => ({ ...prev, plannerStrategy: "greedy-unlock" }))
              }
            >
              Greedy Unlock
            </button>
          </div>
          <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>
            {sandboxConfig.plannerStrategy === "priority-topo"
              ? "Ranks all currently unlocked characters (plus holistic bypasses) by your active DAG score."
              : "Picks minimal prerequisite clusters with the highest marginal corpus gain per learned character."}
          </div>
        </div>

        {/* Holistic Bypass & Greedy Lambda */}
        <div className="control-block">
          <div className="slider-group">
            <div className="slider-label">
              <span>Holistic Bypass (Top-N)</span>
              <span className="mono">{sandboxConfig.holisticBypassTopN}</span>
            </div>
            <input
              type="range"
              aria-label="Holistic bypass top-N characters"
              min={0}
              max={300}
              step={5}
              value={sandboxConfig.holisticBypassTopN}
              onChange={(e) =>
                setSandboxConfig((prev) => ({
                  ...prev,
                  holisticBypassTopN: Number(e.target.value),
                }))
              }
            />
            <span style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
              Allows ultra-common words like <span className="hanzi">的</span> into your queue before rare sub-parts like <span className="hanzi">勺</span>.
            </span>
          </div>

          {sandboxConfig.plannerStrategy === "greedy-unlock" && (
            <div className="slider-group">
              <div className="slider-label">
                <span>Cluster Size Penalty (λ)</span>
                <span className="mono">{sandboxConfig.greedyClusterExponent.toFixed(2)}</span>
              </div>
              <input
                type="range"
                aria-label="Greedy cluster size penalty exponent"
                min={0.5}
                max={2.0}
                step={0.05}
                value={sandboxConfig.greedyClusterExponent}
                onChange={(e) =>
                  setSandboxConfig((prev) => ({
                    ...prev,
                    greedyClusterExponent: Number(e.target.value),
                  }))
                }
              />
              <span style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                Higher λ favors small immediate unlocks; lower λ bundles deeper families together.
              </span>
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontSize: 12.5, color: "var(--ink-secondary)" }}>Queue Window</span>
            <div className="segmented">
              {[25, 60, 120, 200].map((lim) => (
                <button
                  key={lim}
                  type="button"
                  className={queueLimit === lim ? "active" : ""}
                  onClick={() => setQueueLimit(lim)}
                >
                  {lim}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Display Filters */}
        <div className="control-block">
          <span className="field-label" style={{ marginBottom: 0 }}>
            Queue Filters
          </span>
          <label className="toggle-row" htmlFor="planner-hide-primitives">
            <span style={{ fontSize: 12.5 }}>Hide bound primitives</span>
            <button
              id="planner-hide-primitives"
              type="button"
              role="switch"
              aria-checked={hidePrimitives}
              aria-label="Hide bound primitives"
              className="switch"
              onClick={() => setHidePrimitives((v) => !v)}
            />
          </label>
          <label className="toggle-row" htmlFor="planner-hide-enrolled">
            <span style={{ fontSize: 12.5 }}>Hide already in SRS</span>
            <button
              id="planner-hide-enrolled"
              type="button"
              role="switch"
              aria-checked={hideEnrolled}
              aria-label="Hide already in SRS"
              className="switch"
              onClick={() => setHideEnrolled((v) => !v)}
            />
          </label>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {(
              [
                ["all", `All (${rawQueue.length})`],
                ["unlocked", `Unlocked (${queueCounts.unlocked})`],
                ["holistic-bypass", `Bypass (${queueCounts.bypass})`],
                ["cluster", `Clusters (${queueCounts.cluster})`],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`btn btn-sm ${reasonFilter === id ? "btn-primary" : ""}`}
                onClick={() => setReasonFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Bulk Progress Import */}
        <div className="control-block">
          <span className="field-label" style={{ marginBottom: 0 }}>
            Seed Existing Knowledge
          </span>
          <button
            type="button"
            className="btn"
            style={{ width: "100%" }}
            onClick={() => setShowImportModal(true)}
          >
            <Upload size={14} /> Bulk Import (HSK / Top-N / Text / CSV)
          </button>
          {coverageSummary && (
            <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>
              Currently <strong className="mono">{coverageSummary.knownChars}</strong> known chars ·{" "}
              <strong className="mono">{coverageSummary.subtlexCoveragePct.toFixed(1)}%</strong> spoken coverage.
            </div>
          )}
        </div>

        {/* Anki Export */}
        <div className="control-block">
          <span className="field-label" style={{ marginBottom: 0 }}>
            Export Queue to Anki
          </span>
          <input
            type="text"
            className="input"
            aria-label="Anki deck title"
            value={deckTitle}
            maxLength={100}
            onChange={(e) => setDeckTitle(e.target.value)}
            placeholder="Anki deck title"
          />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={exportingFormat !== null || exportCount === 0}
              onClick={() => void handleAnkiExport("apkg")}
            >
              <Download size={13} />
              {exportingFormat === "apkg" ? "Building..." : ".apkg Deck"}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={exportingFormat !== null || exportCount === 0}
              onClick={() => void handleAnkiExport("csv")}
            >
              <Download size={13} />
              {exportingFormat === "csv" ? "Building..." : ".csv Sheet"}
            </button>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
            {selectedIds.size > 0
              ? `Exports your ${selectedIds.size} selected characters (.apkg embeds offline syllable MP3s).`
              : `Exports top ${exportCount} visible queue items (.apkg embeds offline syllable MP3s).`}
          </div>
        </div>
      </aside>

      {/* Main Queue Workspace */}
      <section className="panel" style={{ minWidth: 0 }}>
        <div className="panel-header" style={{ flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 7, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={toggleSelectAll}
                disabled={visibleQueue.length === 0}
                aria-label="Select all visible queue items"
              />
              <span className="panel-title">
                Next to Learn ({visibleQueue.length})
              </span>
            </label>
            <span className="chip chip-stone mono">
              {sandboxConfig.algorithm} · {sandboxConfig.frequencyPreset}
            </span>
          </div>

          {selectedIds.size > 0 ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span className="chip chip-vermilion mono">{selectedIds.size} selected</span>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={batchBusy}
                onClick={() => void handleBatchEnroll()}
              >
                <Plus size={13} /> Enroll Selected in SRS
              </button>
              <button
                type="button"
                className="btn btn-sm btn-jade"
                disabled={batchBusy}
                onClick={() => void handleBatchKnown()}
              >
                <Check size={13} /> Mark Selected Known
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={batchBusy}
                onClick={() => setSelectedIds(new Set())}
              >
                Clear
              </button>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>
              Click any character to inspect its DAG family, or enroll directly into FSRS review.
            </div>
          )}
        </div>

        {(errorMsg || statusMessage) && (
          <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
            {errorMsg && (
              <div className="alert-error" role="alert">
                {errorMsg}
              </div>
            )}
            {statusMessage && (
              <div className="alert-success" role="status">
                {statusMessage}
              </div>
            )}
          </div>
        )}

        {visibleQueue.length === 0 ? (
          <div className="panel-body" style={{ textAlign: "center", padding: "40px 20px" }}>
            <Sparkles size={28} style={{ color: "var(--jade)", marginBottom: 8 }} />
            <h2 style={{ margin: "0 0 6px", fontSize: 16 }}>
              {rawQueue.length === 0 ? "Queue Complete!" : "No Characters Match Active Filters"}
            </h2>
            <p style={{ margin: "0 auto 16px", maxWidth: 420, color: "var(--ink-secondary)", fontSize: 13 }}>
              {rawQueue.length === 0
                ? "Every remaining character in this projection is already marked known or ignored."
                : "Try clearing one of the queue filters on the left to see unlocked candidates."}
            </p>
            {rawQueue.length > 0 && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setHidePrimitives(false);
                  setHideEnrolled(false);
                  setReasonFilter("all");
                }}
              >
                Reset Filters
              </button>
            )}
          </div>
        ) : (
          <div>
            {visibleQueue.map((item, idx) => {
              const nodeIdx = projected.idToIndex.get(item.id);
              const node = nodeIdx !== undefined ? projected.nodes[nodeIdx]! : null;
              if (!node) return null;

              const enrolled = isNodeEnrolled(projected, node.id, enrolledNodeIds);
              const isBusy = busyRowIds.has(node.id);
              const checked = selectedIds.has(node.id);

              return (
                <div key={item.id} className="queue-card">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={batchBusy}
                    onChange={() => toggleSelect(node.id)}
                    aria-label={`Select ${node.id}`}
                  />

                  <span
                    className="mono"
                    style={{ width: 28, fontSize: 12, color: "var(--ink-muted)", flexShrink: 0 }}
                  >
                    #{idx + 1}
                  </span>

                  <button
                    type="button"
                    className="queue-glyph-btn"
                    onClick={() => setDrawerNodeId(node.id)}
                    title={`Inspect ${node.id}`}
                    aria-label={`Inspect ${node.id}`}
                  >
                    <span className="hanzi">{node.id}</span>
                  </button>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                      {node.pinyin[0] ? (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          style={{ padding: "2px 6px", color: "var(--vermilion)", fontWeight: 650 }}
                          onClick={() => void playSyllable(node.audio, node.id)}
                          aria-label={`Play pronunciation ${node.pinyin[0]}`}
                        >
                          <Volume2 size={13} /> {node.pinyin[0]}
                        </button>
                      ) : (
                        <span className="chip chip-stone">Primitive</span>
                      )}

                      {node.hskLevel !== null && (
                        <span className="chip chip-slate">
                          HSK {node.hskLevel === 7 ? "7–9" : node.hskLevel}
                        </span>
                      )}

                      {renderReasonChip(item)}

                      {enrolled && <span className="chip chip-ochre">In SRS</span>}
                    </div>

                    <div
                      style={{
                        marginTop: 3,
                        fontSize: 13,
                        color: "var(--ink)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                      title={node.definition}
                    >
                      {node.definition}
                    </div>

                    <div
                      className="mono"
                      style={{
                        marginTop: 4,
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 12,
                        fontSize: 11.5,
                        color: "var(--ink-muted)",
                      }}
                    >
                      <span>Score {item.normalizedScore.toFixed(1)}</span>
                      <span>Unlocks +{item.unlocksCount} direct</span>
                      <span>Corpus {(item.rawFreqShare * 100).toFixed(3)}%</span>
                    </div>
                  </div>

                  <div className="queue-row-actions">
                    <button
                      type="button"
                      className={`btn btn-sm ${enrolled ? "" : "btn-primary"}`}
                      disabled={batchBusy || isBusy || enrolled}
                      onClick={() => void handleRowEnroll(node.id)}
                    >
                      {enrolled ? "Enrolled" : "+ SRS"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={batchBusy || isBusy}
                      onClick={() => void handleRowKnown(node.id)}
                      title="Mark as already known"
                    >
                      <Check size={13} /> Known
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost btn-icon"
                      onClick={() => openInExplorer(node.id)}
                      title={`Open ${node.id} in DAG Explorer`}
                      aria-label={`Open ${node.id} in DAG Explorer`}
                    >
                      <ExternalLink size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Slide-over Node Detail Drawer */}
      {drawerNodeId && (
        <div
          className="drawer-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Character details for ${drawerNodeId}`}
          onClick={() => setDrawerNodeId(null)}
        >
          <div className="drawer-sheet" onClick={(e) => e.stopPropagation()}>
            <NodeDetailPanel
              nodeId={drawerNodeId}
              onSelectNode={(id) => setDrawerNodeId(id)}
              onClose={() => setDrawerNodeId(null)}
            />
          </div>
        </div>
      )}

      {/* Bulk Import Modal */}
      {showImportModal && <BulkImportModal onClose={() => setShowImportModal(false)} />}
    </div>
  );
}
