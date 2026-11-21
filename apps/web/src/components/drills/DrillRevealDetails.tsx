import { ExternalLink, Volume2 } from "lucide-react";
import type { DueCardPayload } from "../../api/client.js";

interface DrillRevealDetailsProps {
  payload: DueCardPayload;
  onPlaySyllable: (audioFile: string | null | undefined, fallbackText?: string) => void;
  onSpeakWord: (word: string, audioFile?: string | null) => void;
  onInspectNode?: (id: string) => void;
  hidePrimaryHeader?: boolean;
}

/**
 * Shared revealed-answer breakdown shown underneath every FSRS drill once flipped/completed:
 * readings with offline MP3 playback, English gloss, DAG components, etymology, examples, and notes.
 */
export function DrillRevealDetails({
  payload,
  onPlaySyllable,
  onSpeakWord,
  onInspectNode,
  hidePrimaryHeader = false,
}: DrillRevealDetailsProps) {
  const { node, components, examples, notes } = payload;

  return (
    <div className="drill-reveal">
      {!hidePrimaryHeader && (
        <div className="drill-reveal-head">
          <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 6 }}>
            {node.pinyin.length > 0 ? (
              node.pinyin.map((py, i) => {
                const syl = node.syllables[i];
                return (
                  <button
                    key={`${py}-${i}`}
                    type="button"
                    className="btn btn-sm"
                    onClick={() => onPlaySyllable(syl ? `${syl}.mp3` : node.audio, node.id)}
                    style={{
                      color: i === 0 ? "var(--vermilion)" : "var(--ink-secondary)",
                      fontWeight: i === 0 ? 700 : 500,
                    }}
                  >
                    <Volume2 size={13} /> {py}
                  </button>
                );
              })
            ) : (
              <span className="chip chip-stone">Bound Primitive</span>
            )}
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, marginTop: 8 }}>{node.definition}</div>
        </div>
      )}

      {/* Building Blocks */}
      {components.length > 0 && (
        <div className="drill-reveal-block">
          <div className="section-heading">
            Building Blocks
            {node.decomposition ? (
              <span className="mono" style={{ marginLeft: 8, fontWeight: 400 }}>
                {node.decomposition}
              </span>
            ) : null}
          </div>
          <div className="part-pills" style={{ justifyContent: "flex-start" }}>
            {components.map((comp) => (
              <span key={comp.id} className="part-pill" style={{ cursor: "default" }}>
                <span className="hanzi" style={{ fontSize: 18 }}>
                  {comp.id}
                </span>
                {comp.multiplicity > 1 && (
                  <span className="mono" style={{ fontSize: 11, color: "var(--vermilion)", fontWeight: 700 }}>
                    ×{comp.multiplicity}
                  </span>
                )}
                <span style={{ color: "var(--ink-secondary)", fontSize: 12 }}>{comp.definition}</span>
                {comp.role !== "structural" && (
                  <span className={`chip ${comp.role === "phonetic" ? "chip-ochre" : "chip-slate"}`}>
                    {comp.role === "phonetic" ? "sound" : "meaning"}
                  </span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Etymology Hint */}
      {node.etymology && (
        <div className="drill-reveal-block">
          <div className="section-heading">Etymology</div>
          <div style={{ fontSize: 13, color: "var(--ink-secondary)", textAlign: "left" }}>
            <strong style={{ textTransform: "capitalize", color: "var(--ink)" }}>
              {node.etymology.type}
            </strong>
            {node.etymology.hint ? `: ${node.etymology.hint}` : ""}
          </div>
        </div>
      )}

      {/* Example Words */}
      {examples.length > 0 && (
        <div className="drill-reveal-block">
          <div className="section-heading">Everyday Words</div>
          <div className="example-list">
            {examples.slice(0, 3).map((ex) => (
              <div key={ex.word} className="example-row" style={{ textAlign: "left" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <span className="hanzi" style={{ fontSize: 17 }}>
                      {ex.word}
                    </span>
                    <span style={{ fontSize: 12, color: "var(--vermilion)", fontWeight: 550 }}>
                      {ex.pinyin}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--ink-secondary)" }}>{ex.gloss}</div>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  onClick={() => onSpeakWord(ex.word, ex.audio)}
                  aria-label={`Speak ${ex.word}`}
                >
                  <Volume2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Personal Note */}
      {notes.trim().length > 0 && (
        <div className="drill-reveal-block">
          <div className="section-heading">Your Mnemonic Note</div>
          <div style={{ fontSize: 13, color: "var(--ink)", textAlign: "left", whiteSpace: "pre-wrap" }}>
            {notes}
          </div>
        </div>
      )}

      {onInspectNode && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => onInspectNode(node.id)}
          >
            <ExternalLink size={13} /> Open {node.id} in DAG Explorer
          </button>
        </div>
      )}
    </div>
  );
}
