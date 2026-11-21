import { Eye, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DueCardPayload } from "../../api/client.js";
import { DrillRevealDetails } from "./DrillRevealDetails.js";

interface ListeningDrillProps {
  payload: DueCardPayload;
  revealed: boolean;
  onReveal: () => void;
  onPlaySyllable: (audioFile: string | null | undefined, fallbackText?: string) => void;
  onSpeakWord: (word: string, audioFile?: string | null) => void;
  onInspectNode: (id: string) => void;
}

export function ListeningDrill({
  payload,
  revealed,
  onReveal,
  onPlaySyllable,
  onSpeakWord,
  onInspectNode,
}: ListeningDrillProps) {
  const { node, listeningContext, listeningChoices } = payload;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selfRecallMode, setSelfRecallMode] = useState(false);

  const onPlayRef = useRef(onPlaySyllable);
  onPlayRef.current = onPlaySyllable;

  // Reset choice state and attempt gentle auto-play when switching cards
  useEffect(() => {
    setSelectedId(null);
    if (node.audio) {
      onPlayRef.current(node.audio, node.id);
    }
  }, [payload.card.id, node.audio, node.id]);

  const handleChoose = (choiceId: string) => {
    if (revealed) return;
    setSelectedId(choiceId);
    onReveal();
  };

  const isCorrect = selectedId !== null && selectedId === node.id;

  return (
    <div>
      <div className="drill-mode-kicker">
        <span className="chip chip-jade">Listening &amp; Tone Drill</span>
        {node.hskLevel !== null && (
          <span className="chip chip-slate">HSK {node.hskLevel === 7 ? "7–9" : node.hskLevel}</span>
        )}
      </div>

      {/* Audio Replay Hero Button */}
      <div style={{ margin: "16px 0 12px", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
        <button
          type="button"
          className="listening-play-btn"
          onClick={() => onPlaySyllable(node.audio, node.id)}
          aria-label="Play Mandarin syllable audio"
        >
          <Volume2 size={28} />
        </button>
        <div style={{ fontSize: 12.5, color: "var(--ink-muted)" }}>
          Click speaker or press <kbd className="kbd">R</kbd> to replay offline audio
        </div>
      </div>

      {/* Homophone Disambiguation Context */}
      {listeningContext && (
        <div className="listening-context-box">
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ink-muted)" }}>
            Context Clue
          </div>
          <div className="hanzi" style={{ fontSize: 28, marginTop: 4 }}>
            {revealed ? listeningContext.word : listeningContext.maskedWord}
          </div>
          <div style={{ fontSize: 13, color: "var(--ink-secondary)", marginTop: 3 }}>
            {revealed && (
              <span style={{ color: "var(--vermilion)", fontWeight: 600, marginRight: 8 }}>
                {listeningContext.pinyin}
              </span>
            )}
            {revealed ? listeningContext.gloss : listeningContext.gloss.split(node.id).join("＿")}
          </div>
          {revealed && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ marginTop: 6 }}
              onClick={() => onSpeakWord(listeningContext.word, listeningContext.audio)}
            >
              <Volume2 size={13} /> Speak word
            </button>
          )}
        </div>
      )}

      {/* Mode Switch (4-Choice vs Self-Recall) */}
      {!revealed && listeningChoices.length > 0 && (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 10 }}>
          <div className="segmented">
            <button
              type="button"
              className={!selfRecallMode ? "active" : ""}
              onClick={() => setSelfRecallMode(false)}
            >
              4-Choice Quiz
            </button>
            <button
              type="button"
              className={selfRecallMode ? "active" : ""}
              onClick={() => setSelfRecallMode(true)}
            >
              Self-Recall
            </button>
          </div>
        </div>
      )}

      {/* 4-Choice Tiles */}
      {!selfRecallMode && listeningChoices.length > 0 && (
        <div className="choice-grid" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))", maxWidth: 460, margin: "14px auto" }}>
          {listeningChoices.map((ch) => {
            const isTarget = ch.id === node.id;
            const isPicked = selectedId === ch.id;
            let cls = "choice-tile";
            if (revealed) {
              if (isTarget) cls += " correct";
              else if (isPicked && !isTarget) cls += " wrong";
            }

            return (
              <button
                key={ch.id}
                type="button"
                className={cls}
                disabled={revealed}
                onClick={() => handleChoose(ch.id)}
              >
                <span className="hanzi" style={{ fontSize: 34 }}>
                  {ch.id}
                </span>
                {revealed ? (
                  <>
                    <span style={{ fontSize: 12.5, fontWeight: 650, color: "var(--vermilion)" }}>
                      {ch.pinyin[0] ?? ""}
                    </span>
                    <span
                      style={{
                        fontSize: 11.5,
                        color: "var(--ink-secondary)",
                        maxWidth: "100%",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {ch.definition}
                    </span>
                  </>
                ) : (
                  <span style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>Select match</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {!revealed && (selfRecallMode || listeningChoices.length === 0) && (
        <div style={{ marginTop: 14 }}>
          <button type="button" className="btn btn-primary" onClick={onReveal}>
            <Eye size={14} /> Show Answer (Space)
          </button>
        </div>
      )}

      {revealed && selectedId !== null && (
        <div style={{ margin: "6px auto 12px", maxWidth: 420 }}>
          {isCorrect ? (
            <div className="alert-success">
              Correct! <span className="hanzi" style={{ fontSize: 18 }}>{node.id}</span> ({node.pinyin[0]})
            </div>
          ) : (
            <div className="alert-error">
              Not quite — you chose <span className="hanzi">{selectedId}</span>; the audio was{" "}
              <strong className="hanzi" style={{ fontSize: 18 }}>{node.id}</strong> ({node.pinyin[0]})
            </div>
          )}
        </div>
      )}

      {revealed && (
        <div>
          {(selfRecallMode || listeningChoices.length === 0) && (
            <div className="review-hanzi" style={{ fontSize: 64 }}>
              {node.id}
            </div>
          )}
          <DrillRevealDetails
            payload={payload}
            onPlaySyllable={onPlaySyllable}
            onSpeakWord={onSpeakWord}
            onInspectNode={onInspectNode}
          />
        </div>
      )}
    </div>
  );
}
