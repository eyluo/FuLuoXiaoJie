import { resolveNodeIndex } from "@fuluoxiaojie/graph-engine";
import { Check, EyeOff, Plus, Trash2, Volume2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { NodeStatus } from "../api/client.js";
import { useAppState } from "../hooks/useAppState.js";
import { useMandarinAudio } from "../hooks/useAudio.js";
import { getEffectiveNotes, getEffectiveStatus, isNodeEnrolled } from "../utils/projectionHelpers.js";
import { StrokeViewer } from "./StrokeViewer.js";

interface NodeDetailProps {
  nodeId: string;
  onSelectNode: (id: string) => void;
  onClose?: () => void;
}

export function NodeDetailPanel({ nodeId, onSelectNode, onClose }: NodeDetailProps) {
  const {
    projected,
    scoreResult,
    examples,
    progress,
    enrolledNodeIds,
    updateNodeProgress,
    enrollNodes,
    unenrollNode,
  } = useAppState();
  const { playSyllable, speakWord } = useMandarinAudio();

  const resolvedIdx = projected ? resolveNodeIndex(projected, nodeId) : undefined;
  const node = resolvedIdx !== undefined && projected ? projected.nodes[resolvedIdx]! : null;
  const score = node && scoreResult ? scoreResult.byId.get(node.id) ?? null : null;
  const status: NodeStatus =
    node && projected ? getEffectiveStatus(projected, node.id, progress) : "unseen";
  const persistedNotes =
    node && projected ? getEffectiveNotes(projected, node.id, progress) : "";
  const isEnrolled =
    node && projected ? isNodeEnrolled(projected, node.id, enrolledNodeIds) : false;

  const [notesDraft, setNotesDraft] = useState(persistedNotes);
  const [savingNodeIds, setSavingNodeIds] = useState<Set<string>>(() => new Set());
  const [savedNotice, setSavedNotice] = useState(false);
  const [busyNodeIds, setBusyNodeIds] = useState<Set<string>>(() => new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  const activeNodeIdRef = useRef<string | null>(node?.id ?? null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  activeNodeIdRef.current = node?.id ?? null;

  const busyAction = node ? busyNodeIds.has(node.id) : false;
  const savingNotes = node ? savingNodeIds.has(node.id) : false;

  // Reset transient feedback only when switching to a different character
  useEffect(() => {
    setSavedNotice(false);
    setActionError(null);
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, [node?.id]);

  // Keep draft textarea synchronized with persisted notes without wiping the Saved toast
  useEffect(() => {
    setNotesDraft(persistedNotes);
  }, [node?.id, persistedNotes]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const { directComponents, directCompounds, mergedVariants } = useMemo(() => {
    if (!projected || resolvedIdx === undefined || !node) {
      return { directComponents: [], directCompounds: [], mergedVariants: [] as string[] };
    }
    const comps = projected.incoming[resolvedIdx]!.map((e) => ({
      node: projected.nodes[e.sourceIdx]!,
      role: e.role,
      multiplicity: e.multiplicity,
    }));
    const cmpds = [...projected.outgoing[resolvedIdx]!]
      .map((e) => ({
        node: projected.nodes[e.targetIdx]!,
        role: e.role,
        rank: scoreResult?.byId.get(projected.nodes[e.targetIdx]!.id)?.rank ?? 99999,
      }))
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 18);

    return {
      directComponents: comps,
      directCompounds: cmpds,
      mergedVariants: projected.mergedFrom[node.id] ?? [],
    };
  }, [projected, resolvedIdx, node, scoreResult]);

  if (!node) {
    return (
      <div className="panel panel-body" style={{ color: "var(--ink-muted)" }}>
        Select any character or primitive to inspect its structure, scores, stroke order, and examples.
      </div>
    );
  }

  const nodeExamples = examples[node.id] ?? [];

  const addId = (setter: Dispatch<SetStateAction<Set<string>>>, id: string) => {
    setter((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };
  const removeId = (setter: Dispatch<SetStateAction<Set<string>>>, id: string) => {
    setter((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const handleSetStatus = async (nextStatus: NodeStatus) => {
    const targetId = node.id;
    addId(setBusyNodeIds, targetId);
    setActionError(null);
    try {
      await updateNodeProgress(targetId, { status: nextStatus });
    } catch (err) {
      if (activeNodeIdRef.current === targetId) {
        setActionError(err instanceof Error ? err.message : "Could not update character status.");
      }
    } finally {
      removeId(setBusyNodeIds, targetId);
    }
  };

  const handleSaveNotes = async () => {
    const targetId = node.id;
    addId(setSavingNodeIds, targetId);
    setActionError(null);
    try {
      await updateNodeProgress(targetId, { notes: notesDraft });
      if (activeNodeIdRef.current === targetId) {
        setSavedNotice(true);
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
          if (activeNodeIdRef.current === targetId) setSavedNotice(false);
        }, 1800);
      }
    } catch (err) {
      if (activeNodeIdRef.current === targetId) {
        setActionError(err instanceof Error ? err.message : "Could not save mnemonic note.");
      }
    } finally {
      removeId(setSavingNodeIds, targetId);
    }
  };

  const handleEnrollToggle = async () => {
    const targetId = node.id;
    addId(setBusyNodeIds, targetId);
    setActionError(null);
    try {
      if (isEnrolled) await unenrollNode(targetId);
      else await enrollNodes([targetId]);
    } catch (err) {
      if (activeNodeIdRef.current === targetId) {
        setActionError(err instanceof Error ? err.message : "Could not update SRS enrollment.");
      }
    } finally {
      removeId(setBusyNodeIds, targetId);
    }
  };

  const rankDelta = score?.rankDelta ?? null;

  return (
    <aside className="panel detail-panel" aria-label={`Details for ${node.id}`}>
      {/* Hero Header */}
      <div className="detail-hero">
        <div className="hero-glyph-box">{node.id}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
              {node.pinyin.length > 0 ? (
                node.pinyin.map((py, i) => {
                  const syl = node.syllables[i];
                  return (
                    <button
                      key={`${py}-${i}`}
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void playSyllable(syl ? `${syl}.mp3` : node.audio, node.id)}
                      title={`Play pronunciation ${py}`}
                      aria-label={`Play pronunciation ${py}`}
                      style={{
                        color: i === 0 ? "var(--vermilion)" : "var(--ink-secondary)",
                        fontWeight: i === 0 ? 700 : 500,
                      }}
                    >
                      <Volume2 size={13} />
                      {py}
                    </button>
                  );
                })
              ) : (
                <span className="chip chip-stone">Bound Primitive</span>
              )}
            </div>
            {onClose && (
              <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close detail panel">
                <X size={16} />
              </button>
            )}
          </div>

          <div style={{ marginTop: 8, fontSize: 14, fontWeight: 550 }}>{node.definition}</div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 8 }}>
            {node.hskLevel !== null && (
              <span className="chip chip-slate">HSK {node.hskLevel === 7 ? "7–9" : node.hskLevel}</span>
            )}
            <span className="chip chip-stone">{node.strokes > 0 ? `${node.strokes} strokes` : "primitive"}</span>
            {status === "known" && <span className="chip chip-jade">Known</span>}
            {status === "learning" && <span className="chip chip-ochre">Learning</span>}
            {status === "ignored" && <span className="chip chip-stone">Ignored</span>}
            {mergedVariants.length > 0 && (
              <span className="chip chip-vermilion" title="Contracted shape variants merged into this concept node">
                Includes {mergedVariants.join(" ")}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Mastery & SRS Action Bar */}
      <div className="detail-section" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          <button
            type="button"
            className={`btn btn-sm ${status === "known" ? "btn-jade" : ""}`}
            disabled={busyAction}
            onClick={() => void handleSetStatus(status === "known" ? "unseen" : "known")}
          >
            <Check size={14} /> {status === "known" ? "Known" : "Mark Known"}
          </button>

          <button
            type="button"
            className={`btn btn-sm ${isEnrolled ? "" : "btn-primary"}`}
            disabled={busyAction}
            onClick={() => void handleEnrollToggle()}
          >
            {isEnrolled ? (
              <>
                <Trash2 size={13} /> Remove SRS
              </>
            ) : (
              <>
                <Plus size={14} /> Add to SRS
              </>
            )}
          </button>

          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={busyAction}
            onClick={() => void handleSetStatus(status === "ignored" ? "unseen" : "ignored")}
            title="Exclude from study queue without counting as known"
          >
            <EyeOff size={13} /> {status === "ignored" ? "Un-ignore" : "Ignore"}
          </button>
        </div>

        {actionError && (
          <div className="alert-error" role="alert">
            {actionError}
          </div>
        )}
      </div>

      {/* Graph & Frequency Metrics */}
      {score && (
        <div className="detail-section">
          <h3 className="section-heading">DAG Score &amp; Corpus Ranks</h3>
          <div className="metric-strip">
            <div className="metric-cell">
              <div className="metric-label">Algo Rank</div>
              <div className="metric-value mono">
                #{score.rank}
                {rankDelta !== null && rankDelta !== 0 && (
                  <span
                    style={{
                      marginLeft: 5,
                      fontSize: 11.5,
                      color: rankDelta > 0 ? "var(--jade)" : "var(--vermilion)",
                    }}
                  >
                    {rankDelta > 0 ? `+${rankDelta}↑` : `${rankDelta}↓`}
                  </span>
                )}
              </div>
            </div>
            <div className="metric-cell">
              <div className="metric-label">Score (0–100)</div>
              <div className="metric-value mono">{score.normalizedScore.toFixed(1)}</div>
            </div>
            <div className="metric-cell">
              <div className="metric-label">Unlocks / Reach</div>
              <div className="metric-value mono">{Math.max(0, score.ancestorCount - 1)} chars</div>
            </div>
            <div className="metric-cell">
              <div className="metric-label">SUBTLEX Spoken</div>
              <div className="metric-value mono">
                {node.freq.subtlexRank ? `#${node.freq.subtlexRank}` : "—"}
              </div>
            </div>
            <div className="metric-cell">
              <div className="metric-label">Jun Da Written</div>
              <div className="metric-value mono">
                {node.freq.jundaRank ? `#${node.freq.jundaRank}` : "—"}
              </div>
            </div>
            <div className="metric-cell">
              <div className="metric-label">Family Coverage</div>
              <div className="metric-value mono">{(score.coverageShare * 100).toFixed(2)}%</div>
            </div>
          </div>
        </div>
      )}

      {/* Stroke Order Animation */}
      <div className="detail-section">
        <h3 className="section-heading">Stroke Order</h3>
        <StrokeViewer character={node.id} strokeFile={node.strokeFile} size={108} />
      </div>

      {/* Components & Etymology */}
      <div className="detail-section">
        <h3 className="section-heading">
          Building Blocks ({directComponents.length})
          {node.decomposition ? (
            <span className="mono" style={{ marginLeft: 8, fontWeight: 400 }}>
              {node.decomposition}
            </span>
          ) : null}
        </h3>
        {directComponents.length > 0 ? (
          <div className="part-pills">
            {directComponents.map(({ node: part, role, multiplicity }) => (
              <button
                key={part.id}
                type="button"
                className="part-pill"
                onClick={() => onSelectNode(part.id)}
              >
                <span className="hanzi" style={{ fontSize: 18 }}>
                  {part.id}
                </span>
                {multiplicity > 1 && (
                  <span className="mono" style={{ fontSize: 11, color: "var(--vermilion)", fontWeight: 700 }}>
                    ×{multiplicity}
                  </span>
                )}
                <span
                  style={{
                    color: "var(--ink-secondary)",
                    maxWidth: 110,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {part.definition}
                </span>
                {role !== "structural" && (
                  <span className={`chip ${role === "phonetic" ? "chip-ochre" : "chip-slate"}`}>
                    {role === "phonetic" ? "sound" : "meaning"}
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 12.5, color: "var(--ink-muted)" }}>
            Atomic source node in the DAG (no smaller sub-components).
          </div>
        )}

        {node.etymology && (
          <div
            style={{
              marginTop: 10,
              padding: "8px 10px",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg-paper)",
              fontSize: 12.5,
              color: "var(--ink-secondary)",
            }}
          >
            <strong style={{ textTransform: "capitalize", color: "var(--ink)" }}>
              {node.etymology.type}
            </strong>
            {node.etymology.hint ? `: ${node.etymology.hint}` : ""}
          </div>
        )}
      </div>

      {/* Compounds Using This Character */}
      {directCompounds.length > 0 && (
        <div className="detail-section">
          <h3 className="section-heading">
            Top Compounds Using {node.id} ({projected?.outgoing[resolvedIdx!]?.length ?? 0} direct)
          </h3>
          <div className="part-pills">
            {directCompounds.map(({ node: cmpd, role }) => (
              <button
                key={cmpd.id}
                type="button"
                className="part-pill"
                onClick={() => onSelectNode(cmpd.id)}
                title={`${cmpd.id} (${cmpd.pinyin[0] ?? ""}) — ${cmpd.definition}`}
              >
                <span className="hanzi" style={{ fontSize: 18 }}>
                  {cmpd.id}
                </span>
                {cmpd.pinyin[0] && (
                  <span style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>{cmpd.pinyin[0]}</span>
                )}
                {role === "phonetic" && <span className="chip chip-ochre">sound</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Example Words */}
      {nodeExamples.length > 0 && (
        <div className="detail-section">
          <h3 className="section-heading">Everyday Words (SUBTLEX-CH Ranked)</h3>
          <div className="example-list">
            {nodeExamples.map((ex) => (
              <div key={ex.word} className="example-row">
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <span className="hanzi" style={{ fontSize: 18 }}>
                      {ex.word}
                    </span>
                    <span style={{ fontSize: 12, color: "var(--vermilion)", fontWeight: 550 }}>
                      {ex.pinyin}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--ink-secondary)", marginTop: 2 }}>
                    {ex.gloss}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  onClick={() => speakWord(ex.word)}
                  title={`Speak ${ex.word}`}
                  aria-label={`Speak ${ex.word}`}
                >
                  <Volume2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Personal Mnemonic Notes */}
      <div className="detail-section">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <h3 className="section-heading" style={{ margin: 0 }}>
            Personal Mnemonic Note
          </h3>
          {savedNotice && <span style={{ fontSize: 11.5, color: "var(--jade)", fontWeight: 600 }}>Saved</span>}
        </div>
        <textarea
          className="textarea"
          value={notesDraft}
          onChange={(e) => setNotesDraft(e.target.value)}
          placeholder={`Write a memory story for ${node.id}...`}
          maxLength={4000}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 7 }}>
          <button
            type="button"
            className="btn btn-sm"
            disabled={savingNotes || notesDraft === persistedNotes}
            onClick={() => void handleSaveNotes()}
          >
            {savingNotes ? "Saving..." : "Save Note"}
          </button>
        </div>
      </div>
    </aside>
  );
}
