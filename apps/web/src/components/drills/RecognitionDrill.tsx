import { Check, Eye } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DueCardPayload } from "../../api/client.js";
import { matchPinyinAnswer, type PinyinMatchResult } from "../../utils/pinyinMatch.js";
import { DrillRevealDetails } from "./DrillRevealDetails.js";

interface RecognitionDrillProps {
  payload: DueCardPayload;
  enableTyping: boolean;
  revealed: boolean;
  onReveal: () => void;
  onPlaySyllable: (audioFile: string | null | undefined, fallbackText?: string) => void;
  onSpeakWord: (word: string) => void;
  onInspectNode: (id: string) => void;
}

export function RecognitionDrill({
  payload,
  enableTyping,
  revealed,
  onReveal,
  onPlaySyllable,
  onSpeakWord,
  onInspectNode,
}: RecognitionDrillProps) {
  const { node } = payload;
  const [typedPinyin, setTypedPinyin] = useState("");
  const [matchResult, setMatchResult] = useState<PinyinMatchResult | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setTypedPinyin("");
    setMatchResult(null);
    if (enableTyping && !revealed && node.pinyin.length > 0) {
      inputRef.current?.focus();
    }
  }, [payload.card.id, enableTyping, node.pinyin.length]);

  const handleCheckPinyin = (e: React.FormEvent) => {
    e.preventDefault();
    if (revealed) return;
    if (typedPinyin.trim().length > 0) {
      const res = matchPinyinAnswer(typedPinyin, node.pinyin, node.syllables);
      setMatchResult(res);
    }
    onReveal();
    if (node.audio) onPlaySyllable(node.audio, node.id);
  };

  const handleManualReveal = () => {
    if (revealed) return;
    onReveal();
    if (node.audio) onPlaySyllable(node.audio, node.id);
  };

  return (
    <div>
      <div className="drill-mode-kicker">
        <span className="chip chip-vermilion">Recognition Recall</span>
        {node.hskLevel !== null && (
          <span className="chip chip-slate">HSK {node.hskLevel === 7 ? "7–9" : node.hskLevel}</span>
        )}
        {node.strokes > 0 && <span className="chip chip-stone">{node.strokes} strokes</span>}
      </div>

      <div className="review-hanzi" aria-label={`Character ${node.id}`}>
        {node.id}
      </div>

      {!revealed && (
        <div style={{ maxWidth: 380, margin: "12px auto 0" }}>
          {enableTyping && node.pinyin.length > 0 ? (
            <form onSubmit={handleCheckPinyin} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <input
                ref={inputRef}
                type="text"
                className="input"
                value={typedPinyin}
                onChange={(e) => setTypedPinyin(e.target.value)}
                placeholder="Type pinyin (e.g. qing3 or qǐng) & press Enter..."
                aria-label="Type pinyin pronunciation"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                style={{ textAlign: "center", fontSize: 15 }}
              />
              <div style={{ display: "flex", justifyContent: "center", gap: 8 }}>
                <button type="submit" className="btn btn-primary">
                  <Check size={14} /> {typedPinyin.trim() ? "Check & Reveal" : "Reveal Answer (Enter)"}
                </button>
              </div>
            </form>
          ) : (
            <button type="button" className="btn btn-primary" onClick={handleManualReveal}>
              <Eye size={14} /> Show Answer (Space)
            </button>
          )}
        </div>
      )}

      {revealed && matchResult && matchResult.status !== "empty" && (
        <div style={{ margin: "6px auto 12px", maxWidth: 420 }}>
          {matchResult.status === "exact" && (
            <div className="alert-success">
              Exact pinyin match: <strong>{matchResult.matchedReading}</strong>
            </div>
          )}
          {matchResult.status === "tone-close" && (
            <div className="chip chip-ochre" style={{ padding: "6px 12px", fontSize: 12.5 }}>
              Right syllable — watch the tone! Expected <strong>{matchResult.matchedReading}</strong> (you typed{" "}
              <span className="mono">{typedPinyin.trim()}</span>)
            </div>
          )}
          {matchResult.status === "wrong" && (
            <div className="alert-error">
              You typed <span className="mono">{typedPinyin.trim()}</span> — expected{" "}
              <strong>{node.pinyin.join(" / ")}</strong>
            </div>
          )}
        </div>
      )}

      {revealed && (
        <DrillRevealDetails
          payload={payload}
          onPlaySyllable={onPlaySyllable}
          onSpeakWord={onSpeakWord}
          onInspectNode={onInspectNode}
        />
      )}
    </div>
  );
}
