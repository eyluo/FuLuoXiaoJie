import type { ProjectedGraph, ScoreResult } from "@fuluoxiaojie/graph-engine";
import { useEffect, useMemo, useRef, useState } from "react";
import { logRankFraction } from "../utils/projectionHelpers.js";

interface RankScatterPlotProps {
  projected: ProjectedGraph;
  scoreResult: ScoreResult;
  onSelectNode: (id: string) => void;
}

interface PlotPoint {
  id: string;
  rawRank: number;
  algoRank: number;
  rankDelta: number;
  x: number;
  y: number;
  pinyin: string;
  definition: string;
}

const PAD = { left: 52, right: 16, top: 14, bottom: 36 };
const BASE_TICKS = [1, 10, 100, 1000];

function buildAxisTicks(maxRank: number): number[] {
  const ticks = BASE_TICKS.filter((t) => t <= maxRank);
  const topThousand = Math.floor(maxRank / 1000) * 1000;
  if (topThousand >= 2000 && !ticks.includes(topThousand)) {
    ticks.push(topThousand);
  }
  return ticks;
}

export function RankScatterPlot({ projected, scoreResult, onSelectNode }: RankScatterPlotProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 520, height: 280 });
  const [hovered, setHovered] = useState<{ pt: PlotPoint; mx: number; my: number } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 40) {
        setSize({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { points, maxRank, topRisers, topDroppers } = useMemo(() => {
    const plotW = Math.max(40, size.width - PAD.left - PAD.right);
    const plotH = Math.max(40, size.height - PAD.top - PAD.bottom);

    let maxRaw = 10;
    let maxAlgo = 10;
    for (const ns of scoreResult.nodes) {
      if (ns.rawRank !== null) {
        if (ns.rawRank > maxRaw) maxRaw = ns.rawRank;
        if (ns.rank > maxAlgo) maxAlgo = ns.rank;
      }
    }
    // Single shared domain for X, Y, ticks, and the y = x no-shift reference diagonal
    const sharedMax = Math.max(maxRaw, maxAlgo, 10);

    const pts: PlotPoint[] = [];
    for (const ns of scoreResult.nodes) {
      if (ns.rawRank === null || ns.rankDelta === null) continue;
      const gNode = projected.nodes[ns.index]!;
      const x = PAD.left + logRankFraction(ns.rawRank, sharedMax) * plotW;
      const y = PAD.top + logRankFraction(ns.rank, sharedMax) * plotH;
      pts.push({
        id: ns.id,
        rawRank: ns.rawRank,
        algoRank: ns.rank,
        rankDelta: ns.rankDelta,
        x,
        y,
        pinyin: gNode.pinyin[0] ?? "",
        definition: gNode.definition,
      });
    }

    const risers = pts
      .filter((p) => p.rankDelta > 0)
      .sort((a, b) => b.rankDelta - a.rankDelta)
      .slice(0, 8);
    const droppers = pts
      .filter((p) => p.rankDelta < 0)
      .sort((a, b) => a.rankDelta - b.rankDelta)
      .slice(0, 6);

    return { points: pts, maxRank: sharedMax, topRisers: risers, topDroppers: droppers };
  }, [projected, scoreResult, size]);

  // Clear stale hovered point whenever plotted points change
  useEffect(() => {
    setHovered(null);
  }, [points]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.width * dpr;
    canvas.height = size.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const plotW = Math.max(40, size.width - PAD.left - PAD.right);
    const plotH = Math.max(40, size.height - PAD.top - PAD.bottom);

    ctx.clearRect(0, 0, size.width, size.height);
    ctx.fillStyle = "#faf7f0";
    ctx.fillRect(PAD.left, PAD.top, plotW, plotH);

    // Exact y = x diagonal (points with rawRank === algoRank sit strictly on this line)
    ctx.strokeStyle = "#cfc4b0";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(PAD.left, PAD.top);
    ctx.lineTo(PAD.left + plotW, PAD.top + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = "#dfd7c7";
    ctx.strokeRect(PAD.left, PAD.top, plotW, plotH);

    // Dynamic ticks aligned strictly to shared log domain with pixel-collision guards
    ctx.fillStyle = "#787b82";
    ctx.font = "11px JetBrains Mono, monospace";
    const ticks = buildAxisTicks(maxRank);
    let lastDrawnX = -Infinity;
    let lastDrawnY = -Infinity;
    for (const tk of ticks) {
      const frac = logRankFraction(tk, maxRank);
      const tx = PAD.left + frac * plotW;
      const ty = PAD.top + frac * plotH;
      const label = String(tk);
      const xPos = Math.min(PAD.left + plotW - 26, Math.max(PAD.left - 4, tx - label.length * 3));
      if (xPos - lastDrawnX >= 34) {
        ctx.textAlign = "left";
        ctx.fillText(label, xPos, PAD.top + plotH + 14);
        lastDrawnX = xPos;
      }
      if (ty - lastDrawnY >= 16) {
        ctx.textAlign = "right";
        ctx.fillText(label, PAD.left - 6, ty + 4);
        lastDrawnY = ty;
      }
      ctx.textAlign = "left";
    }

    // X-axis label
    ctx.fillStyle = "#545861";
    ctx.font = "11px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Raw Frequency Rank (log, #1 left)", PAD.left + plotW / 2, size.height - 4);

    // Y-axis label
    ctx.save();
    ctx.translate(12, PAD.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("Algo Rank (#1 top)", 0, 0);
    ctx.restore();
    ctx.textAlign = "left";

    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      if (p.rankDelta > 150) {
        ctx.fillStyle = "rgba(31, 116, 94, 0.72)";
      } else if (p.rankDelta < -150) {
        ctx.fillStyle = "rgba(185, 58, 43, 0.55)";
      } else {
        ctx.fillStyle = "rgba(92, 96, 106, 0.32)";
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.abs(p.rankDelta) > 400 ? 2.6 : 1.9, 0, Math.PI * 2);
      ctx.fill();
    }

    if (hovered) {
      ctx.strokeStyle = "#1a1c20";
      ctx.fillStyle = "#b93a2b";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(hovered.pt.x, hovered.pt.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }, [points, maxRank, size, hovered]);

  const findNearest = (mx: number, my: number): PlotPoint | null => {
    let best: PlotPoint | null = null;
    let bestDistSq = 14 * 14;
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      const dx = p.x - mx;
      const dy = p.y - my;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDistSq) {
        bestDistSq = d2;
        best = p;
      }
    }
    return best;
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <h2 className="panel-title">Raw Frequency vs. Propagated Priority Rank</h2>
          <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>
            Above diagonal (jade) = promoted building blocks · Click any point to inspect
          </div>
        </div>
      </div>
      <div className="panel-body">
        <div className="chart-canvas-wrap" ref={wrapRef}>
          <canvas
            ref={canvasRef}
            style={{ width: "100%", height: "100%", cursor: hovered ? "pointer" : "crosshair" }}
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const mx = e.clientX - rect.left;
              const my = e.clientY - rect.top;
              const pt = findNearest(mx, my);
              setHovered(pt ? { pt, mx, my } : null);
            }}
            onMouseLeave={() => setHovered(null)}
            onClick={() => {
              if (hovered) onSelectNode(hovered.pt.id);
            }}
          />
          {hovered && (
            <div
              className="chart-tooltip"
              style={{
                left: Math.max(8, Math.min(Math.max(8, size.width - 196), hovered.mx + 12)),
                top: Math.max(8, hovered.my - 48),
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <span className="hanzi" style={{ fontSize: 18 }}>
                  {hovered.pt.id}
                </span>
                <span>{hovered.pt.pinyin}</span>
                <span className="mono" style={{ color: hovered.pt.rankDelta >= 0 ? "#6de2c3" : "#f79c8f" }}>
                  {hovered.pt.rankDelta >= 0 ? `+${hovered.pt.rankDelta}↑` : `${hovered.pt.rankDelta}↓`}
                </span>
              </div>
              <div className="mono" style={{ fontSize: 11, opacity: 0.85 }}>
                Raw #{hovered.pt.rawRank} → Algo #{hovered.pt.algoRank}
              </div>
              <div style={{ fontSize: 11, opacity: 0.8, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}>
                {hovered.pt.definition}
              </div>
            </div>
          )}
        </div>

        {topRisers.length > 0 && (
          <div className="movers-strip">
            <span style={{ fontSize: 11.5, fontWeight: 650, color: "var(--jade)", alignSelf: "center" }}>
              Biggest Risers:
            </span>
            {topRisers.map((p) => (
              <button key={p.id} type="button" className="mover-btn" onClick={() => onSelectNode(p.id)}>
                <span className="hanzi" style={{ fontSize: 15 }}>
                  {p.id}
                </span>
                <span className="mono" style={{ fontSize: 11, color: "var(--jade)" }}>
                  +{p.rankDelta}
                </span>
              </button>
            ))}
          </div>
        )}

        {topDroppers.length > 0 && (
          <div className="movers-strip" style={{ borderTop: topRisers.length ? "none" : undefined, paddingTop: topRisers.length ? 4 : 8 }}>
            <span style={{ fontSize: 11.5, fontWeight: 650, color: "var(--vermilion)", alignSelf: "center" }}>
              Holistic Leaves:
            </span>
            {topDroppers.map((p) => (
              <button key={p.id} type="button" className="mover-btn" onClick={() => onSelectNode(p.id)}>
                <span className="hanzi" style={{ fontSize: 15 }}>
                  {p.id}
                </span>
                <span className="mono" style={{ fontSize: 11, color: "var(--vermilion)" }}>
                  {p.rankDelta}
                </span>
              </button>
            ))}
          </div>
        )}

        {topRisers.length === 0 && topDroppers.length === 0 && (
          <div className="movers-strip" style={{ fontSize: 12, color: "var(--ink-muted)" }}>
            Zero rank shifts (scores match the raw frequency baseline).
          </div>
        )}
      </div>
    </div>
  );
}
