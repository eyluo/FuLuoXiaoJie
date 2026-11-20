import {
  extractSubgraph,
  type ProjectedGraph,
  type ScoreResult,
} from "@fuluoxiaojie/graph-engine";
import cytoscape, { type Core } from "cytoscape";
import dagre from "cytoscape-dagre";
import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import type { ProgressEntry } from "../api/client.js";
import { buildSatisfiedIdSet, getEffectiveStatus } from "../utils/projectionHelpers.js";

cytoscape.use(dagre);

interface DagCanvasProps {
  projected: ProjectedGraph;
  scoreResult: ScoreResult;
  progress: Record<string, ProgressEntry>;
  focusId: string;
  upstreamDepth: number;
  downstreamDepth: number;
  maxNodes: number;
  onSelectNode: (id: string) => void;
}

function getNodeVisualState(
  id: string,
  projected: ProjectedGraph,
  progress: Record<string, ProgressEntry>,
  satisfiedSet: Set<string>
): "known" | "learning" | "ignored" | "unlocked" | "locked" {
  const status = getEffectiveStatus(projected, id, progress);
  if (status === "known") return "known";
  if (status === "learning") return "learning";
  if (status === "ignored") return "ignored";

  const idx = projected.idToIndex.get(id);
  if (idx === undefined) return "locked";
  const inc = projected.incoming[idx]!;
  if (inc.length === 0) return "unlocked";
  const allSatisfied = inc.every((e) => satisfiedSet.has(projected.nodes[e.sourceIdx]!.id));
  return allSatisfied ? "unlocked" : "locked";
}

export function DagCanvas({
  projected,
  scoreResult,
  progress,
  focusId,
  upstreamDepth,
  downstreamDepth,
  maxNodes,
  onSelectNode,
}: DagCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const onSelectRef = useRef(onSelectNode);
  onSelectRef.current = onSelectNode;

  const rankMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const ns of scoreResult.nodes) m.set(ns.id, ns.rank);
    return m;
  }, [scoreResult]);

  const subgraph = useMemo(
    () => extractSubgraph(projected, focusId, upstreamDepth, downstreamDepth, maxNodes, rankMap),
    [projected, focusId, upstreamDepth, downstreamDepth, maxNodes, rankMap]
  );

  // Compute projection-aware satisfied set & node visual states separately so editing notes never resets Cytoscape pan/zoom
  const visualStateById = useMemo(() => {
    const satisfiedSet = buildSatisfiedIdSet(projected, progress);
    const map = new Map<string, string>();
    for (const { id } of subgraph.nodes) {
      map.set(id, getNodeVisualState(id, projected, progress, satisfiedSet));
    }
    return map;
  }, [projected, progress, subgraph.nodes]);

  // Build / re-layout Cytoscape only when subgraph topology or sizes change
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const elements = [
      ...subgraph.nodes.map(({ id, node, distance }) => {
        const ns = scoreResult.byId.get(id);
        const norm = ns?.normalizedScore ?? 0;
        const size = Math.round(38 + Math.sqrt(Math.max(0, norm)) * 2.4);
        return {
          data: {
            id,
            label: id,
            sublabel: node.pinyin[0] ?? (node.isPrimitive ? "prim" : ""),
            visualState: visualStateById.get(id) ?? "locked",
            isFocus: distance === 0 ? "yes" : "no",
            isPrimitive: node.isPrimitive ? "yes" : "no",
            size: distance === 0 ? Math.max(size + 8, 54) : size,
          },
        };
      }),
      ...subgraph.edges.map((e) => ({
        data: {
          id: `${e.source}->${e.target}`,
          source: e.source,
          target: e.target,
          role: e.role,
          multLabel: e.multiplicity > 1 ? `×${e.multiplicity}` : "",
        },
      })),
    ];

    if (cyRef.current) {
      cyRef.current.destroy();
      cyRef.current = null;
    }

    const cy = cytoscape({
      container,
      elements,
      minZoom: 0.35,
      maxZoom: 2.5,
      wheelSensitivity: 0.25,
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            "text-valign": "center",
            "text-halign": "center",
            "font-family": '"Noto Serif SC", "Songti SC", "PingFang SC", serif',
            "font-size": 21,
            width: "data(size)",
            height: "data(size)",
            "background-color": "#fffdf8",
            "border-width": 2,
            "border-color": "#b7ae9e",
            color: "#1a1c20",
            "transition-property": "border-color, background-color, border-width",
            "transition-duration": 120,
          },
        },
        {
          selector: 'node[isPrimitive = "yes"]',
          style: {
            shape: "round-rectangle",
            "background-color": "#f4efe4",
          },
        },
        {
          selector: 'node[visualState = "known"]',
          style: {
            "background-color": "#e5f3ee",
            "border-color": "#1f745e",
            color: "#114d3d",
          },
        },
        {
          selector: 'node[visualState = "learning"]',
          style: {
            "background-color": "#fbf1de",
            "border-color": "#b2781c",
            color: "#7a510c",
          },
        },
        {
          selector: 'node[visualState = "unlocked"]',
          style: {
            "background-color": "#eaf0f8",
            "border-color": "#35598a",
            color: "#223c61",
          },
        },
        {
          selector: 'node[visualState = "ignored"]',
          style: {
            "background-color": "#ebe8e2",
            "border-color": "#b8b3aa",
            color: "#8a867e",
            opacity: 0.6,
          },
        },
        {
          selector: 'node[isFocus = "yes"]',
          style: {
            "border-width": 3.5,
            "border-color": "#b93a2b",
            "font-size": 27,
            "font-weight": 600,
          },
        },
        {
          selector: "edge",
          style: {
            width: 1.6,
            "curve-style": "bezier",
            "target-arrow-shape": "triangle",
            "arrow-scale": 0.85,
            "line-color": "#b4ab9b",
            "target-arrow-color": "#b4ab9b",
            label: "data(multLabel)",
            "font-size": 11,
            "font-family": "JetBrains Mono, monospace",
            color: "#b93a2b",
            "text-background-color": "#f6f3eb",
            "text-background-opacity": 0.9,
            "text-background-padding": "2px",
          },
        },
        {
          selector: 'edge[role = "semantic"]',
          style: {
            "line-color": "#35598a",
            "target-arrow-color": "#35598a",
            width: 2,
          },
        },
        {
          selector: 'edge[role = "phonetic"]',
          style: {
            "line-color": "#b2781c",
            "target-arrow-color": "#b2781c",
            "line-style": "dashed",
            width: 2,
          },
        },
        {
          selector: 'edge[role = "structural"]',
          style: {
            "line-style": "dotted",
            "line-color": "#9b9385",
            "target-arrow-color": "#9b9385",
          },
        },
      ],
      layout: {
        name: "dagre",
        rankDir: "TB",
        nodeSep: 34,
        rankSep: 58,
        padding: 28,
      } as cytoscape.LayoutOptions,
    });

    cy.on("tap", "node", (evt) => {
      const tappedId = evt.target.id();
      if (tappedId) onSelectRef.current(tappedId);
    });

    cyRef.current = cy;

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [subgraph, scoreResult]);

  // Update node visual states in-place without destroying Cytoscape or resetting zoom/pan
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.nodes().forEach((ele) => {
        const nextState = visualStateById.get(ele.id());
        if (nextState && ele.data("visualState") !== nextState) {
          ele.data("visualState", nextState);
        }
      });
    });
  }, [visualStateById]);

  return (
    <div className="dag-stage">
      <div className="dag-canvas-el" ref={containerRef} />

      <div className="dag-floating-controls">
        <button
          type="button"
          className="btn btn-sm btn-icon"
          title="Zoom in"
          aria-label="Zoom in"
          onClick={() => {
            const cy = cyRef.current;
            if (cy) cy.zoom({ level: cy.zoom() * 1.22, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
          }}
        >
          <ZoomIn size={15} />
        </button>
        <button
          type="button"
          className="btn btn-sm btn-icon"
          title="Zoom out"
          aria-label="Zoom out"
          onClick={() => {
            const cy = cyRef.current;
            if (cy) cy.zoom({ level: cy.zoom() * 0.82, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
          }}
        >
          <ZoomOut size={15} />
        </button>
        <button
          type="button"
          className="btn btn-sm btn-icon"
          title="Fit graph"
          aria-label="Fit graph to view"
          onClick={() => cyRef.current?.fit(undefined, 28)}
        >
          <Maximize2 size={15} />
        </button>
      </div>

      <div className="dag-legend">
        <span>
          <span className="legend-dot" style={{ background: "#1f745e" }} />
          Known
        </span>
        <span>
          <span className="legend-dot" style={{ background: "#b2781c" }} />
          Learning
        </span>
        <span>
          <span className="legend-dot" style={{ background: "#35598a" }} />
          Unlocked
        </span>
        <span>
          <span className="legend-dot" style={{ background: "#b7ae9e" }} />
          Locked
        </span>
        <span style={{ color: "#35598a" }}>
          <span className="legend-line" />
          Semantic
        </span>
        <span style={{ color: "#b2781c" }}>
          <span className="legend-line" style={{ borderTopStyle: "dashed" }} />
          Phonetic
        </span>
        <span style={{ color: "#8a867e" }}>
          <span className="legend-line" style={{ borderTopStyle: "dotted" }} />
          Structural
        </span>
        {subgraph.truncated && (
          <span className="mono" style={{ color: "var(--vermilion)", fontWeight: 600 }}>
            Showing top {subgraph.nodes.length} neighbors
          </span>
        )}
      </div>
    </div>
  );
}
