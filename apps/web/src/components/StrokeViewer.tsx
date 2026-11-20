import HanziWriter from "hanzi-writer";
import { Play, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";

interface StrokeViewerProps {
  character: string;
  strokeFile: string | null;
  size?: number;
}

/**
 * Offline Hanzi Writer stroke animation component loading SVG stroke medians
 * strictly from our self-hosted /api/data/strokes/:file endpoint (zero CDN calls).
 */
export function StrokeViewer({ character, strokeFile, size = 112 }: StrokeViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const writerRef = useRef<HanziWriter | null>(null);
  const [status, setStatus] = useState<"idle" | "ready" | "error">("idle");
  const [showOutline, setShowOutline] = useState(true);

  useEffect(() => {
    const el = containerRef.current;
    // Reset guide toggle state to match fresh HanziWriter creation
    setShowOutline(true);
    if (!el || !strokeFile) {
      setStatus("idle");
      return;
    }

    let cancelled = false;
    el.innerHTML = "";
    writerRef.current = null;
    setStatus("idle");

    let createdWriter: HanziWriter | null = null;
    try {
      createdWriter = HanziWriter.create(el, character, {
        width: size,
        height: size,
        padding: 8,
        showOutline: true,
        showCharacter: true,
        strokeColor: "#1a1c20",
        outlineColor: "#d8cfc0",
        drawingColor: "#b93a2b",
        strokeAnimationSpeed: 1.35,
        delayBetweenStrokes: 160,
        charDataLoader: (_char, onComplete, onError) => {
          api
            .getStrokeData(strokeFile)
            .then((data) => {
              if (!cancelled) {
                onComplete(data);
                setStatus("ready");
              }
            })
            .catch((err) => {
              if (!cancelled) {
                setStatus("error");
                onError?.(err);
              }
            });
        },
      });
      writerRef.current = createdWriter;
    } catch {
      setStatus("error");
    }

    return () => {
      cancelled = true;
      if (createdWriter) {
        try {
          createdWriter.pauseAnimation();
          createdWriter.cancelQuiz();
        } catch {
          // Ignore teardown errors on partially loaded writer
        }
      }
      writerRef.current = null;
      if (el) el.innerHTML = "";
    };
  }, [character, strokeFile, size]);

  if (!strokeFile) {
    return (
      <div className="stroke-box">
        <div className="stroke-stage">
          <span className="hanzi" style={{ fontSize: 52, color: "var(--ink-secondary)" }}>
            {character}
          </span>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--ink-muted)" }}>
          Bound primitive glyph — stroke-order animation is not available for this component.
        </div>
      </div>
    );
  }

  return (
    <div className="stroke-box">
      <div
        className="stroke-stage"
        ref={containerRef}
        style={{ width: size + 4, height: size + 4 }}
        aria-label={`Stroke order diagram for ${character}`}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 7, flex: 1 }}>
        <div style={{ fontSize: 12.5, color: "var(--ink-secondary)" }}>
          {status === "error"
            ? "Could not load offline stroke data."
            : "Self-hosted stroke order animation (Make Me a Hanzi)."}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          <button
            type="button"
            className="btn btn-sm"
            disabled={status !== "ready"}
            onClick={() => {
              void writerRef.current?.animateCharacter().catch(() => {});
            }}
          >
            <Play size={13} /> Animate
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={status !== "ready"}
            onClick={() => {
              const next = !showOutline;
              setShowOutline(next);
              if (next) void writerRef.current?.showOutline().catch(() => {});
              else void writerRef.current?.hideOutline().catch(() => {});
            }}
          >
            <RotateCcw size={13} /> {showOutline ? "Hide Guide" : "Show Guide"}
          </button>
        </div>
      </div>
    </div>
  );
}
