import HanziWriter from "hanzi-writer";
import { Eye, EyeOff, Play, RotateCcw, Volume2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type DueCardPayload } from "../../api/client.js";
import { DrillRevealDetails } from "./DrillRevealDetails.js";

interface StrokeDrillProps {
  payload: DueCardPayload;
  revealed: boolean;
  onReveal: () => void;
  onPlaySyllable: (audioFile: string | null | undefined, fallbackText?: string) => void;
  onSpeakWord: (word: string) => void;
  onInspectNode: (id: string) => void;
}

/**
 * Interactive offline Hanzi Writer stroke-drawing recall quiz.
 * Loads stroke medians exclusively from /api/data/strokes/:file with clean quiz teardown.
 */
export function StrokeDrill({
  payload,
  revealed,
  onReveal,
  onPlaySyllable,
  onSpeakWord,
  onInspectNode,
}: StrokeDrillProps) {
  const { node } = payload;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const writerRef = useRef<HanziWriter | null>(null);
  const onRevealRef = useRef(onReveal);
  onRevealRef.current = onReveal;
  const onPlayRef = useRef(onPlaySyllable);
  onPlayRef.current = onPlaySyllable;
  const revealedRef = useRef(revealed);
  revealedRef.current = revealed;

  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [showOutline, setShowOutline] = useState(false);
  const [mistakes, setMistakes] = useState(0);
  const [strokesDone, setStrokesDone] = useState(0);
  const [completed, setCompleted] = useState(false);
  const [quizRunKey, setQuizRunKey] = useState(0);
  // True ONLY when Redraw was explicitly clicked AFTER the card was already revealed
  const postRevealRedrawRef = useRef(false);

  useEffect(() => {
    postRevealRedrawRef.current = false;
  }, [payload.card.id]);

  const startQuizOnWriter = useCallback(
    (writer: HanziWriter) => {
      setMistakes(0);
      setStrokesDone(0);
      setCompleted(false);
      writer.quiz({
        showHintAfterMisses: 2,
        highlightOnComplete: true,
        leniency: 1.1,
        onMistake: (strokeData) => {
          setMistakes(strokeData.totalMistakes);
        },
        onCorrectStroke: (strokeData) => {
          setStrokesDone(strokeData.strokeNum + 1);
          setMistakes(strokeData.totalMistakes);
        },
        onComplete: (summary) => {
          setMistakes(summary.totalMistakes);
          setCompleted(true);
          onRevealRef.current();
          if (node.audio) onPlayRef.current(node.audio, node.id);
        },
      });
    },
    [node.audio, node.id]
  );

  useEffect(() => {
    const el = stageRef.current;
    setShowOutline(false);
    setMistakes(0);
    setStrokesDone(0);
    setCompleted(false);

    if (!el || !node.strokeFile) {
      setLoadState("error");
      return;
    }

    let cancelled = false;
    el.innerHTML = "";
    writerRef.current = null;
    setLoadState("loading");

    let createdWriter: HanziWriter | null = null;
    const strokeFile = node.strokeFile;

    try {
      createdWriter = HanziWriter.create(el, node.id, {
        width: 216,
        height: 216,
        padding: 12,
        showOutline: false,
        showCharacter: false,
        strokeColor: "#1a1c20",
        outlineColor: "#d8cfc0",
        drawingColor: "#b93a2b",
        highlightColor: "#b2781c",
        highlightCompleteColor: "#1f745e",
        drawingWidth: 18,
        strokeAnimationSpeed: 1.25,
        delayBetweenStrokes: 180,
        onLoadCharDataError: () => {
          // Handled via loadState="error"; prevents unhandled Promise rejection inside hanzi-writer
        },
        charDataLoader: (_char, onComplete, onError) => {
          api
            .getStrokeData(strokeFile)
            .then((data) => {
              if (cancelled) return;
              onComplete(data);
              setLoadState("ready");
              if (!createdWriter) return;
              // If learner revealed while strokes were still loading (and didn't request post-reveal redraw),
              // render the full answer cleanly instead of racing quiz() against cancelQuiz().
              if (revealedRef.current && !postRevealRedrawRef.current) {
                void createdWriter.showCharacter().catch(() => {});
                void createdWriter.showOutline().catch(() => {});
                setShowOutline(true);
              } else {
                startQuizOnWriter(createdWriter);
              }
            })
            .catch((err) => {
              if (!cancelled) {
                setLoadState("error");
                onError?.(err);
              }
            });
        },
      });
      writerRef.current = createdWriter;
    } catch {
      setLoadState("error");
    }

    return () => {
      cancelled = true;
      if (createdWriter) {
        try {
          createdWriter.pauseAnimation();
          createdWriter.cancelQuiz();
        } catch {
          // Ignore teardown errors if writer had not finished loading
        }
      }
      writerRef.current = null;
      if (el) el.innerHTML = "";
    };
  }, [payload.card.id, node.id, node.strokeFile, quizRunKey, startQuizOnWriter]);

  // If parent reveals the card via Spacebar or Show Answer before quiz completion, display the full character
  useEffect(() => {
    if (
      revealed &&
      !completed &&
      !postRevealRedrawRef.current &&
      writerRef.current &&
      loadState === "ready"
    ) {
      try {
        writerRef.current.cancelQuiz();
        void writerRef.current.showCharacter().catch(() => {});
        void writerRef.current.showOutline().catch(() => {});
        setShowOutline(true);
      } catch {
        // Ignore if writer already torn down
      }
    }
  }, [revealed, completed, loadState]);

  const handleRedraw = () => {
    // Only bypass reveal-cancellation when redrawing an ALREADY-revealed card
    postRevealRedrawRef.current = revealed;
    setQuizRunKey((k) => k + 1);
  };

  const suggestedRating =
    !completed
      ? null
      : mistakes === 0
        ? { label: "0 mistakes — suggested: Good or Easy", chip: "chip-jade" }
        : mistakes <= 2
          ? { label: `${mistakes} mistake${mistakes === 1 ? "" : "s"} — suggested: Hard or Good`, chip: "chip-ochre" }
          : { label: `${mistakes} mistakes — suggested: Again or Hard`, chip: "chip-vermilion" };

  return (
    <div>
      <div className="drill-mode-kicker">
        <span className="chip chip-ochre">Stroke-Order Recall</span>
        {node.strokes > 0 && <span className="chip chip-stone">{node.strokes} strokes</span>}
        {node.hskLevel !== null && (
          <span className="chip chip-slate">HSK {node.hskLevel === 7 ? "7–9" : node.hskLevel}</span>
        )}
      </div>

      {/* Prompt: Meaning + Pinyin + Audio */}
      <div style={{ margin: "10px 0 14px" }}>
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {node.pinyin[0] && (
            <button
              type="button"
              className="btn btn-sm"
              style={{ color: "var(--vermilion)", fontWeight: 700, fontSize: 15 }}
              onClick={() => onPlaySyllable(node.audio, node.id)}
            >
              <Volume2 size={14} /> {node.pinyin.join(" / ")}
            </button>
          )}
        </div>
        <div style={{ fontSize: 17, fontWeight: 600, marginTop: 8 }}>{node.definition}</div>
        <div style={{ fontSize: 12.5, color: "var(--ink-muted)", marginTop: 3 }}>
          Draw the character stroke-by-stroke inside the grid below.
        </div>
      </div>

      {/* Interactive Hanzi Writer Quiz Canvas */}
      <div className="stroke-quiz-wrap">
        <div
          ref={stageRef}
          className="stroke-quiz-stage"
          aria-label={`Interactive stroke drawing canvas for ${node.definition}`}
        />
        {loadState === "loading" && (
          <div style={{ fontSize: 12.5, color: "var(--ink-muted)", marginTop: 6 }}>
            Loading offline stroke vectors...
          </div>
        )}
        {loadState === "error" && (
          <div className="alert-error" role="alert" style={{ marginTop: 8, maxWidth: 360 }}>
            Stroke vector file unavailable for this character. Reveal answer to self-grade.
          </div>
        )}

        <div className="mono" style={{ fontSize: 12, color: "var(--ink-secondary)", marginTop: 8 }}>
          Strokes: <strong>{strokesDone}</strong> / {node.strokes || "?"} · Mistakes:{" "}
          <strong style={{ color: mistakes > 0 ? "var(--vermilion)" : "var(--jade)" }}>{mistakes}</strong>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 7, marginTop: 10 }}>
          {!revealed && loadState === "ready" && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                const next = !showOutline;
                setShowOutline(next);
                if (next) void writerRef.current?.showOutline().catch(() => {});
                else void writerRef.current?.hideOutline().catch(() => {});
              }}
            >
              {showOutline ? <EyeOff size={13} /> : <Eye size={13} />}
              {showOutline ? "Hide Outline" : "Hint Outline"}
            </button>
          )}

          {loadState === "ready" && (
            <button type="button" className="btn btn-sm" onClick={handleRedraw}>
              <RotateCcw size={13} /> Redraw
            </button>
          )}

          {revealed && loadState === "ready" && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                void writerRef.current?.animateCharacter().catch(() => {});
              }}
            >
              <Play size={13} /> Animate Order
            </button>
          )}

          {!revealed && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => {
                onReveal();
                if (node.audio) onPlaySyllable(node.audio, node.id);
              }}
            >
              <Eye size={13} /> Show Answer
            </button>
          )}
        </div>
      </div>

      {suggestedRating && (
        <div style={{ marginTop: 12 }}>
          <span className={`chip ${suggestedRating.chip}`} style={{ padding: "5px 12px", fontSize: 12.5 }}>
            {suggestedRating.label}
          </span>
        </div>
      )}

      {revealed && (
        <div style={{ marginTop: 12 }}>
          <div className="hanzi" style={{ fontSize: 44, marginBottom: 4 }}>
            {node.id}
          </div>
          <DrillRevealDetails
            payload={payload}
            onPlaySyllable={onPlaySyllable}
            onSpeakWord={onSpeakWord}
            onInspectNode={onInspectNode}
            hidePrimaryHeader
          />
        </div>
      )}
    </div>
  );
}
