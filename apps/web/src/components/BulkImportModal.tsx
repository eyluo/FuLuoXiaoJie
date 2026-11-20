import { resolveNodeIndex } from "@fuluoxiaojie/graph-engine";
import { Check, FileUp, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { NodeStatus } from "../api/client.js";
import { useAppState } from "../hooks/useAppState.js";
import { parseImportedCharacters } from "../utils/pinyinMatch.js";
import { getEffectiveStatus } from "../utils/projectionHelpers.js";

type ImportTab = "hsk" | "top-n" | "text" | "list";

interface BulkImportModalProps {
  onClose: () => void;
}

const HSK_BANDS = [
  { level: 1, label: "HSK 1" },
  { level: 2, label: "HSK 1–2" },
  { level: 3, label: "HSK 1–3" },
  { level: 4, label: "HSK 1–4" },
  { level: 5, label: "HSK 1–5" },
  { level: 6, label: "HSK 1–6" },
  { level: 7, label: "HSK 1–9" },
];

const TOP_N_PRESETS = [100, 300, 500, 1000, 1500, 2500];
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

export function BulkImportModal({ onClose }: BulkImportModalProps) {
  const { projected, progress, bulkImportProgress } = useAppState();
  const [tab, setTab] = useState<ImportTab>("hsk");
  const [hskMaxLevel, setHskMaxLevel] = useState(2);
  const [topNCorpus, setTopNCorpus] = useState<"subtlex" | "junda">("subtlex");
  const [topNInput, setTopNInput] = useState("300");
  const [pastedText, setPastedText] = useState("");
  const [listText, setListText] = useState("");
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [targetStatus, setTargetStatus] = useState<NodeStatus>("known");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultMsg, setResultMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const parsedTopN = Number.parseInt(topNInput, 10);
  const topNCount = Number.isFinite(parsedTopN) && parsedTopN > 0 ? Math.min(4000, parsedTopN) : 0;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Restrict non-list tabs to server-accepted statuses ("known" | "learning")
  useEffect(() => {
    if (tab !== "list" && targetStatus !== "known" && targetStatus !== "learning") {
      setTargetStatus("known");
    }
  }, [tab, targetStatus]);

  const preview = useMemo(() => {
    if (!projected) return { matchedIds: [] as string[], newlyChanged: 0 };
    const matched = new Set<string>();

    if (tab === "hsk") {
      for (const n of projected.nodes) {
        if (n.hskLevel !== null && n.hskLevel <= hskMaxLevel) {
          matched.add(n.id);
        }
      }
    } else if (tab === "top-n") {
      if (topNCount > 0) {
        for (const n of projected.nodes) {
          if (n.isPrimitive) continue;
          const r = topNCorpus === "subtlex" ? n.freq.subtlexRank : n.freq.jundaRank;
          if (r !== null && r <= topNCount) matched.add(n.id);
        }
      }
    } else if (tab === "text") {
      for (const ch of pastedText) {
        const idx = resolveNodeIndex(projected, ch);
        if (idx !== undefined) matched.add(projected.nodes[idx]!.id);
      }
    } else {
      const chars = parseImportedCharacters(listText);
      for (const ch of chars) {
        const idx = resolveNodeIndex(projected, ch);
        if (idx !== undefined) matched.add(projected.nodes[idx]!.id);
      }
    }

    const matchedIds = Array.from(matched).slice(0, 5000);
    let newlyChanged = 0;
    for (const id of matchedIds) {
      if (getEffectiveStatus(projected, id, progress) !== targetStatus) {
        newlyChanged++;
      }
    }
    return { matchedIds, newlyChanged };
  }, [projected, progress, tab, hskMaxLevel, topNCorpus, topNCount, pastedText, listText, targetStatus]);

  const handleFileChange = async (file: File | null) => {
    setError(null);
    setResultMsg(null);
    try {
      if (!file) return;
      if (file.size > MAX_UPLOAD_BYTES) {
        setError("Uploaded file exceeds the 2 MB limit.");
        return;
      }
      const text = await file.text();
      setListText(text);
      setUploadedFileName(file.name);
    } catch {
      setError("Could not read the selected file.");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleImport = async () => {
    if (preview.matchedIds.length === 0) return;
    setSubmitting(true);
    setError(null);
    setResultMsg(null);

    try {
      let res: { importedCount: number; status: NodeStatus };
      if (tab === "hsk") {
        res = await bulkImportProgress({
          mode: "hsk",
          maxLevel: hskMaxLevel,
          status: targetStatus === "learning" ? "learning" : "known",
        });
      } else if (tab === "top-n") {
        const count = Math.max(1, Math.min(4000, Math.floor(topNCount)));
        res = await bulkImportProgress({
          mode: "top-n",
          corpus: topNCorpus,
          count,
          status: targetStatus === "learning" ? "learning" : "known",
        });
      } else if (tab === "text") {
        res = await bulkImportProgress({
          mode: "text",
          text: pastedText.slice(0, 500_000),
          status: targetStatus === "learning" ? "learning" : "known",
        });
      } else {
        res = await bulkImportProgress({
          mode: "list",
          nodeIds: preview.matchedIds,
          status: targetStatus,
        });
      }
      setResultMsg(`Updated ${res.importedCount.toLocaleString()} characters as "${res.status}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bulk import failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-import-title"
      onClick={onClose}
    >
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="panel-header">
          <div>
            <h2 id="bulk-import-title" className="panel-title">
              Bulk Progress Import
            </h2>
            <div style={{ fontSize: 12, color: "var(--ink-muted)", marginTop: 2 }}>
              Seed your DAG with characters you already know to jump-start your personalized queue.
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            aria-label="Close bulk import dialog"
          >
            <X size={16} />
          </button>
        </div>

        <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Mode Tabs */}
          <div className="segmented" role="tablist" aria-label="Import source">
            {(
              [
                ["hsk", "HSK 3.0"],
                ["top-n", "Top-N Freq"],
                ["text", "Paste Text"],
                ["list", "CSV / File"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? "active" : ""}
                onClick={() => {
                  setTab(id);
                  setError(null);
                  setResultMsg(null);
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Tab Content */}
          {tab === "hsk" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="field-label" style={{ marginBottom: 0 }}>
                Mark all characters up through HSK 3.0 band:
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {HSK_BANDS.map((band) => (
                  <button
                    key={band.level}
                    type="button"
                    className={`btn btn-sm ${hskMaxLevel === band.level ? "btn-primary" : ""}`}
                    onClick={() => setHskMaxLevel(band.level)}
                  >
                    {band.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {tab === "top-n" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
                <span className="field-label" style={{ marginBottom: 0 }}>
                  Frequency Corpus
                </span>
                <div className="segmented">
                  <button
                    type="button"
                    className={topNCorpus === "subtlex" ? "active" : ""}
                    onClick={() => setTopNCorpus("subtlex")}
                  >
                    SUBTLEX-CH Spoken
                  </button>
                  <button
                    type="button"
                    className={topNCorpus === "junda" ? "active" : ""}
                    onClick={() => setTopNCorpus("junda")}
                  >
                    Jun Da Written
                  </button>
                </div>
              </div>

              <div>
                <label className="field-label" htmlFor="top-n-count">
                  Top N Most Frequent Characters (1–4000)
                </label>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    id="top-n-count"
                    type="number"
                    className="input mono"
                    min={1}
                    max={4000}
                    value={topNInput}
                    onChange={(e) => setTopNInput(e.target.value)}
                    style={{ width: 120 }}
                  />
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {TOP_N_PRESETS.map((n) => (
                      <button
                        key={n}
                        type="button"
                        className={`btn btn-sm ${topNCount === n ? "btn-primary" : ""}`}
                        onClick={() => setTopNInput(String(n))}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {tab === "text" && (
            <div>
              <label className="field-label" htmlFor="bulk-paste-text">
                Paste any Chinese article, vocabulary list, or Anki notes
              </label>
              <textarea
                id="bulk-paste-text"
                className="textarea"
                rows={5}
                maxLength={500_000}
                value={pastedText}
                onChange={(e) => {
                  setPastedText(e.target.value);
                  setResultMsg(null);
                }}
                placeholder="例如：今天天气很晴朗，我想请朋友一起喝茶..."
              />
            </div>
          )}

          {tab === "list" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.tsv,.txt,text/plain,text/csv"
                  style={{ display: "none" }}
                  onChange={(e) => void handleFileChange(e.target.files?.[0] ?? null)}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <FileUp size={14} /> Choose CSV / TXT File
                </button>
                {uploadedFileName && (
                  <span className="chip chip-slate">{uploadedFileName}</span>
                )}
              </div>
              <div>
                <label className="field-label" htmlFor="bulk-list-text">
                  Or paste a character / CSV list directly
                </label>
                <textarea
                  id="bulk-list-text"
                  className="textarea"
                  rows={4}
                  value={listText}
                  onChange={(e) => {
                    setListText(e.target.value);
                    setResultMsg(null);
                  }}
                  placeholder="青, 请, 晴, 情, 清, 精..."
                />
              </div>
            </div>
          )}

          {/* Target Status Selector */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <span className="field-label" style={{ marginBottom: 0 }}>
              Mark matched characters as
            </span>
            <div className="segmented">
              <button
                type="button"
                className={targetStatus === "known" ? "active" : ""}
                onClick={() => setTargetStatus("known")}
              >
                Known
              </button>
              <button
                type="button"
                className={targetStatus === "learning" ? "active" : ""}
                onClick={() => setTargetStatus("learning")}
              >
                Learning
              </button>
              {tab === "list" && (
                <>
                  <button
                    type="button"
                    className={targetStatus === "ignored" ? "active" : ""}
                    onClick={() => setTargetStatus("ignored")}
                  >
                    Ignored
                  </button>
                  <button
                    type="button"
                    className={targetStatus === "unseen" ? "active" : ""}
                    onClick={() => setTargetStatus("unseen")}
                  >
                    Unseen
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Live Match Preview Strip */}
          <div
            style={{
              padding: "10px 12px",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg-paper)",
              border: "1px solid var(--border)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
              fontSize: 12.5,
            }}
          >
            <div>
              Matched <strong className="mono">{preview.matchedIds.length.toLocaleString()}</strong>{" "}
              DAG nodes
            </div>
            <div style={{ color: "var(--ink-secondary)" }}>
              <strong className="mono">{preview.newlyChanged.toLocaleString()}</strong> will change status
            </div>
          </div>

          {error && (
            <div className="alert-error" role="alert">
              {error}
            </div>
          )}

          {resultMsg && (
            <div className="alert-success" role="status">
              <Check size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} />
              {resultMsg}
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={submitting || preview.matchedIds.length === 0}
              onClick={() => void handleImport()}
            >
              <Upload size={14} />
              {submitting
                ? "Importing..."
                : `Apply to ${preview.matchedIds.length.toLocaleString()} Characters`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
