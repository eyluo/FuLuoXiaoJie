import { Check, Eye } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { DueCardPayload } from "../../api/client.js";
import { DrillRevealDetails } from "./DrillRevealDetails.js";

interface ComponentDrillProps {
  payload: DueCardPayload;
  revealed: boolean;
  onReveal: () => void;
  onPlaySyllable: (audioFile: string | null | undefined, fallbackText?: string) => void;
  onSpeakWord: (word: string) => void;
  onInspectNode: (id: string) => void;
}

export function ComponentDrill({
  payload,
  revealed,
  onReveal,
  onPlaySyllable,
  onSpeakWord,
  onInspectNode,
}: ComponentDrillProps) {
  const { node, components, componentChoices } = payload;
  const [picked, setPicked] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setPicked(new Set());
  }, [payload.card.id]);

  const trueSet = useMemo(() => new Set(components.map((c) => c.id)), [components]);

  const togglePick = (id: string) => {
    if (revealed) return;
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCheck = () => {
    if (revealed) return;
    onReveal();
    if (node.audio) onPlaySyllable(node.audio, node.id);
  };

  const hasComponents = components.length > 0;

  const summary = useMemo(() => {
    if (!revealed || trueSet.size === 0) return null;
    let hits = 0;
    let wrongPicks = 0;
    for (const id of picked) {
      if (trueSet.has(id)) hits++;
      else wrongPicks++;
    }
    const missed = trueSet.size - hits;
    const perfect = hits === trueSet.size && wrongPicks === 0;
    return { hits, wrongPicks, missed, perfect };
  }, [revealed, picked, trueSet]);

  return (
    <div>
      <div className="drill-mode-kicker">
        <span className="chip chip-slate">Component Breakdown</span>
        <span className="chip chip-stone">
          {hasComponents
            ? `Select ${components.length} building block${components.length === 1 ? "" : "s"}`
            : "Atomic character"}
        </span>
      </div>

      <div className="review-hanzi" aria-label={`Compound character ${node.id}`}>
        {node.id}
      </div>

      {hasComponents && (
        <div style={{ fontSize: 13, color: "var(--ink-secondary)", marginBottom: 4 }}>
          Which direct components combine to form <strong className="hanzi">{node.id}</strong>?
        </div>
      )}

      {hasComponents && componentChoices.length > 0 ? (
        <div className="choice-grid" role="group" aria-label="Component choices">
          {componentChoices.map((choice) => {
            const isPicked = picked.has(choice.id);
            const isTrue = trueSet.has(choice.id);

            let tileClass = "choice-tile";
            let badge: string | null = null;
            if (!revealed) {
              if (isPicked) tileClass += " selected";
            } else if (isTrue && isPicked) {
              tileClass += " correct";
              badge = "Correct";
            } else if (isTrue && !isPicked) {
              tileClass += " missed";
              badge = "Missed";
            } else if (!isTrue && isPicked) {
              tileClass += " wrong";
              badge = "Extra";
            }

            return (
              <button
                key={choice.id}
                type="button"
                className={tileClass}
                aria-pressed={isPicked}
                disabled={revealed}
                onClick={() => togglePick(choice.id)}
              >
                <span className="hanzi" style={{ fontSize: 30 }}>
                  {choice.id}
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
                  {choice.definition}
                </span>
                {badge && (
                  <span
                    className={`chip ${
                      badge === "Correct"
                        ? "chip-jade"
                        : badge === "Missed"
                          ? "chip-ochre"
                          : "chip-vermilion"
                    }`}
                  >
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: "var(--ink-muted)", margin: "14px 0" }}>
          Atomic character — reveal to review its meaning and readings.
        </div>
      )}

      {!revealed && (
        <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 8 }}>
          <button type="button" className="btn btn-primary" onClick={handleCheck}>
            {picked.size > 0 ? (
              <>
                <Check size={14} /> Check Selection ({picked.size}/{components.length})
              </>
            ) : (
              <>
                <Eye size={14} /> Show Answer (Space)
              </>
            )}
          </button>
        </div>
      )}

      {revealed && summary && (
        <div style={{ margin: "10px auto 12px", maxWidth: 440 }}>
          {summary.perfect ? (
            <div className="alert-success">
              Perfect breakdown! Matched all {trueSet.size} direct component{trueSet.size === 1 ? "" : "s"}.
            </div>
          ) : (
            <div className="alert-error">
              Matched {summary.hits}/{trueSet.size}
              {summary.wrongPicks > 0 ? ` · ${summary.wrongPicks} incorrect` : ""}
              {summary.missed > 0 ? ` · ${summary.missed} missed` : ""}
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
