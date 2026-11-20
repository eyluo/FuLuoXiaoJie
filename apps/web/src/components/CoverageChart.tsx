import {
  computeCoverageCurves,
  type ProjectedGraph,
  type SandboxConfig,
} from "@fuluoxiaojie/graph-engine";
import { useDeferredValue, useMemo, useState } from "react";
import { computeHoverBands } from "../utils/projectionHelpers.js";

interface CoverageChartProps {
  projected: ProjectedGraph;
  config: SandboxConfig;
}

const CHECKPOINTS = [0, 25, 50, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 2500, 3000];

export function CoverageChart({ projected, config }: CoverageChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [showSupported, setShowSupported] = useState(true);

  // Extract only the config fields that actually affect coverage curves (ignores onlyRemainingMass & plannerStrategy)
  const curveSignature = `${config.mergeVariants}|${config.frequencyPreset}|${config.blendSubtlexWeight}|${config.weightTransform}|${config.logScale}|${config.powerGamma}|${config.rankOffset}|${config.algorithm}|${config.damping}|${config.useMultiplicity}|${config.roleWeights.semantic}|${config.roleWeights.phonetic}|${config.roleWeights.structural}|${config.holisticBypassTopN}|${config.greedyClusterExponent}`;
  const deferredSig = useDeferredValue(curveSignature);
  const isStale = deferredSig !== curveSignature;

  // Keep a deferred snapshot of config matching deferredSig so rapid slider drags never block UI frames
  const deferredConfig = useDeferredValue(config);

  const data = useMemo(
    () => computeCoverageCurves(projected, deferredConfig, CHECKPOINTS),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projected, deferredSig]
  );

  const w = 520;
  const h = 250;
  const pad = { left: 42, right: 16, top: 14, bottom: 30 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;
  const maxX = CHECKPOINTS[CHECKPOINTS.length - 1]!;

  const xPos = (n: number) => pad.left + (n / maxX) * plotW;
  const yPos = (pct: number) => pad.top + plotH - (Math.min(100, Math.max(0, pct)) / 100) * plotH;

  const hoverBands = useMemo(() => {
    const xs = data.map((d) => xPos(d.learnedCount));
    return computeHoverBands(xs, pad.left, pad.left + plotW);
  }, [data, plotW]);

  const toPath = (getter: (d: (typeof data)[number]) => number) =>
    data
      .map((d, i) => `${i === 0 ? "M" : "L"}${xPos(d.learnedCount).toFixed(1)},${yPos(getter(d)).toFixed(1)}`)
      .join(" ");

  const activePoint =
    hoverIdx !== null ? data[hoverIdx] : data.find((d) => d.learnedCount === 500) ?? data[data.length - 1];

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            Cumulative Mandarin Text Coverage
            {isStale && (
              <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 500, color: "var(--ink-muted)" }}>
                updating...
              </span>
            )}
          </h2>
          <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>
            Total corpus % unlocked vs. component-supported coverage after N nodes
          </div>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setShowSupported((v) => !v)}
        >
          {showSupported ? "Hide Supported Curves" : "Show Supported Curves"}
        </button>
      </div>

      <div className="panel-body">
        <div style={{ position: "relative", width: "100%", opacity: isStale ? 0.65 : 1, transition: "opacity 120ms ease" }}>
          <svg
            viewBox={`0 0 ${w} ${h}`}
            style={{ width: "100%", height: "auto", display: "block" }}
            role="img"
            aria-label="Cumulative text coverage curves"
            onMouseLeave={() => setHoverIdx(null)}
          >
            <rect x={pad.left} y={pad.top} width={plotW} height={plotH} fill="#faf7f0" stroke="#dfd7c7" />

            {[0, 25, 50, 75, 100].map((pct) => {
              const y = yPos(pct);
              return (
                <g key={pct}>
                  <line x1={pad.left} y1={y} x2={pad.left + plotW} y2={y} stroke="#ebe4d6" />
                  <text x={pad.left - 6} y={y + 4} textAnchor="end" fontSize="10" fill="#787b82" fontFamily="JetBrains Mono, monospace">
                    {pct}%
                  </text>
                </g>
              );
            })}

            {[0, 500, 1000, 1500, 2000, 2500, 3000].map((cp) => {
              const x = xPos(cp);
              return (
                <g key={cp}>
                  <line x1={x} y1={pad.top} x2={x} y2={pad.top + plotH} stroke="#f0eadc" />
                  <text x={x} y={pad.top + plotH + 15} textAnchor="middle" fontSize="10" fill="#787b82" fontFamily="JetBrains Mono, monospace">
                    {cp}
                  </text>
                </g>
              );
            })}

            <path d={toPath((d) => d.rawFreqCoveragePct)} fill="none" stroke="#8a867e" strokeWidth="1.8" strokeDasharray="4 3" />
            <path d={toPath((d) => d.activeAlgoCoveragePct)} fill="none" stroke="#b93a2b" strokeWidth="2.3" />
            <path d={toPath((d) => d.greedyUnlockCoveragePct)} fill="none" stroke="#1f745e" strokeWidth="2.3" />

            {showSupported && (
              <>
                <path d={toPath((d) => d.activeSupportedCoveragePct)} fill="none" stroke="#35598a" strokeWidth="1.8" />
                <path d={toPath((d) => d.rawSupportedCoveragePct)} fill="none" stroke="#b2781c" strokeWidth="1.6" strokeDasharray="2 3" />
              </>
            )}

            {/* Non-overlapping midpoint/Voronoi hover bands covering every checkpoint cleanly */}
            {data.map((d, i) => {
              const cx = xPos(d.learnedCount);
              const band = hoverBands[i]!;
              return (
                <g key={d.learnedCount}>
                  {hoverIdx === i && (
                    <line x1={cx} y1={pad.top} x2={cx} y2={pad.top + plotH} stroke="#1a1c20" strokeOpacity="0.28" />
                  )}
                  <circle
                    cx={cx}
                    cy={yPos(d.activeAlgoCoveragePct)}
                    r={hoverIdx === i ? 4.5 : 2.5}
                    fill="#b93a2b"
                  />
                  <rect
                    x={band.x}
                    y={pad.top}
                    width={band.width}
                    height={plotH}
                    fill="transparent"
                    style={{ cursor: "pointer" }}
                    onMouseEnter={() => setHoverIdx(i)}
                  />
                </g>
              );
            })}
          </svg>
        </div>

        {activePoint && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "8px 14px",
              marginTop: 10,
              paddingTop: 10,
              borderTop: "1px solid var(--border)",
              fontSize: 12,
            }}
          >
            <span className="mono" style={{ fontWeight: 700 }}>
              At {activePoint.learnedCount} nodes:
            </span>
            <span style={{ color: "var(--vermilion)", fontWeight: 600 }}>
              ● Active DAG: <span className="mono">{activePoint.activeAlgoCoveragePct}%</span>
            </span>
            <span style={{ color: "var(--jade)", fontWeight: 600 }}>
              ● Greedy Unlock: <span className="mono">{activePoint.greedyUnlockCoveragePct}%</span>
            </span>
            <span style={{ color: "var(--stone)", fontWeight: 600 }}>
              ┄ Raw Freq: <span className="mono">{activePoint.rawFreqCoveragePct}%</span>
            </span>
            {showSupported && (
              <>
                <span style={{ color: "var(--slate)", fontWeight: 600 }}>
                  ● DAG Supported: <span className="mono">{activePoint.activeSupportedCoveragePct}%</span>
                </span>
                <span style={{ color: "var(--ochre)", fontWeight: 600 }}>
                  ┄ Raw Supported: <span className="mono">{activePoint.rawSupportedCoveragePct}%</span>
                </span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
