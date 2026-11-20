import { resolveNodeIndex } from "@fuluoxiaojie/graph-engine";
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DagCanvas } from "../components/DagCanvas.js";
import { NodeDetailPanel } from "../components/NodeDetailDrawer.js";
import { useAppState } from "../hooks/useAppState.js";

const SHOWCASE_CHARS = ["青", "品", "森", "湖", "明", "的", "水", "好"];

function stripToneDigits(s: string): string {
  return s.replace(/[1-5]/g, "");
}

export function ExplorerPage() {
  const {
    projected,
    scoreResult,
    progress,
    sandboxConfig,
    setSandboxConfig,
    selectedNodeId,
    setSelectedNodeId,
  } = useAppState();

  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [upstreamDepth, setUpstreamDepth] = useState(3);
  const [downstreamDepth, setDownstreamDepth] = useState(1);
  const [maxNodes, setMaxNodes] = useState(55);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    };
  }, []);

  const focusId = useMemo(() => {
    if (!projected) return "青";
    if (selectedNodeId) {
      const idx = resolveNodeIndex(projected, selectedNodeId);
      if (idx !== undefined) return projected.nodes[idx]!.id;
    }
    return "青";
  }, [projected, selectedNodeId]);

  const searchResults = useMemo(() => {
    if (!projected || !scoreResult) return [];
    const q = query.trim().toLowerCase();
    if (!q) return [];

    const directIdx = resolveNodeIndex(projected, query.trim());
    const matches: Array<{ id: string; rank: number; priority: number }> = [];
    const seen = new Set<string>();

    if (directIdx !== undefined) {
      const id = projected.nodes[directIdx]!.id;
      matches.push({ id, rank: scoreResult.byId.get(id)?.rank ?? 99999, priority: 0 });
      seen.add(id);
    }

    for (const node of projected.nodes) {
      if (seen.has(node.id)) continue;
      const rank = scoreResult.byId.get(node.id)?.rank ?? 99999;

      const exactSyl = node.syllables.some((s) => s === q || stripToneDigits(s) === q);
      if (exactSyl || node.pinyin.some((p) => p.toLowerCase() === q)) {
        matches.push({ id: node.id, rank, priority: 1 });
        seen.add(node.id);
        continue;
      }
      const prefixSyl = node.syllables.some((s) => s.startsWith(q));
      if (prefixSyl) {
        matches.push({ id: node.id, rank, priority: 2 });
        seen.add(node.id);
        continue;
      }
      if (node.definition.toLowerCase().includes(q)) {
        matches.push({ id: node.id, rank, priority: 3 });
        seen.add(node.id);
      }
    }

    matches.sort((a, b) => a.priority - b.priority || a.rank - b.rank);
    return matches.slice(0, 20).map((m) => projected.nodes[projected.idToIndex.get(m.id)!]!);
  }, [projected, scoreResult, query]);

  if (!projected || !scoreResult) {
    return <div className="panel panel-body">Loading Simplified Mandarin DAG...</div>;
  }

  return (
    <section aria-label="DAG Explorer">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em" }}>
            Character Composition DAG Explorer
          </h1>
          <div style={{ fontSize: 13, color: "var(--ink-secondary)" }}>
            Explore prerequisites above and unlocked compounds below. Click any node to re-center.
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>Jump to:</span>
          {SHOWCASE_CHARS.map((ch) => (
            <button
              key={ch}
              type="button"
              className={`btn btn-sm ${focusId === ch ? "btn-primary" : ""}`}
              onClick={() => setSelectedNodeId(ch)}
            >
              <span className="hanzi" style={{ fontSize: 15 }}>
                {ch}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="explorer-layout">
        <div className="panel">
          <div className="explorer-toolbar">
            <div className="search-box">
              <div className="search-input-wrap">
                <Search size={15} className="search-icon" />
                <input
                  id="explorer-search-input"
                  className="input"
                  type="search"
                  role="combobox"
                  aria-expanded={searchOpen && searchResults.length > 0}
                  aria-controls="explorer-search-listbox"
                  aria-label="Search Mandarin character, pinyin, or meaning"
                  value={query}
                  placeholder="Search character, pinyin (qing3 / qing), or meaning..."
                  onFocus={() => {
                    if (blurTimerRef.current) {
                      clearTimeout(blurTimerRef.current);
                      blurTimerRef.current = null;
                    }
                    setSearchOpen(true);
                  }}
                  onBlur={() => {
                    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
                    blurTimerRef.current = setTimeout(() => setSearchOpen(false), 180);
                  }}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setSearchOpen(true);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setSearchOpen(false);
                    } else if (e.key === "Enter" && searchResults[0]) {
                      setSelectedNodeId(searchResults[0].id);
                      setSearchOpen(false);
                    }
                  }}
                />
              </div>

              {searchOpen && searchResults.length > 0 && (
                <div id="explorer-search-listbox" className="search-dropdown" role="listbox">
                  {searchResults.map((node) => {
                    const sc = scoreResult.byId.get(node.id);
                    return (
                      <button
                        key={node.id}
                        type="button"
                        role="option"
                        aria-selected={focusId === node.id}
                        className="search-item"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setSelectedNodeId(node.id);
                          setQuery("");
                          setSearchOpen(false);
                        }}
                      >
                        <span className="search-item-glyph">{node.id}</span>
                        <span className="search-item-main">
                          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                            <strong style={{ color: "var(--vermilion)", fontSize: 13 }}>
                              {node.pinyin[0] ?? (node.isPrimitive ? "primitive" : "")}
                            </strong>
                            {sc && (
                              <span className="mono" style={{ fontSize: 11, color: "var(--ink-muted)" }}>
                                #{sc.rank}
                              </span>
                            )}
                            {node.hskLevel && (
                              <span className="chip chip-slate">
                                HSK {node.hskLevel === 7 ? "7–9" : node.hskLevel}
                              </span>
                            )}
                          </div>
                          <div className="search-item-def">{node.definition}</div>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--ink-secondary)" }}>
              <span>Parts depth</span>
              <select
                className="select"
                style={{ width: 60, padding: "5px 6px" }}
                value={upstreamDepth}
                onChange={(e) => setUpstreamDepth(Number(e.target.value))}
              >
                {[1, 2, 3, 4, 5].map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--ink-secondary)" }}>
              <span>Compounds</span>
              <select
                className="select"
                style={{ width: 60, padding: "5px 6px" }}
                value={downstreamDepth}
                onChange={(e) => setDownstreamDepth(Number(e.target.value))}
              >
                {[0, 1, 2].map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--ink-secondary)" }}>
              <span>Cap</span>
              <select
                className="select"
                style={{ width: 66, padding: "5px 6px" }}
                value={maxNodes}
                onChange={(e) => setMaxNodes(Number(e.target.value))}
              >
                {[25, 40, 55, 80, 110].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>

            <label
              htmlFor="explorer-merge-variants-toggle"
              className="toggle-row"
              style={{ gap: 7, fontSize: 12.5, color: "var(--ink-secondary)" }}
            >
              <span>Merge 水/氵</span>
              <button
                id="explorer-merge-variants-toggle"
                type="button"
                role="switch"
                aria-checked={sandboxConfig.mergeVariants}
                aria-label="Merge radical variants such as 水 and 氵"
                className="switch"
                onClick={() =>
                  setSandboxConfig((prev) => ({ ...prev, mergeVariants: !prev.mergeVariants }))
                }
              />
            </label>
          </div>

          <DagCanvas
            projected={projected}
            scoreResult={scoreResult}
            progress={progress}
            focusId={focusId}
            upstreamDepth={upstreamDepth}
            downstreamDepth={downstreamDepth}
            maxNodes={maxNodes}
            onSelectNode={(id) => setSelectedNodeId(id)}
          />
        </div>

        <NodeDetailPanel nodeId={focusId} onSelectNode={(id) => setSelectedNodeId(id)} />
      </div>
    </section>
  );
}
