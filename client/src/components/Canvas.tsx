import { useCallback, useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useReactFlow,
  useViewport,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useBoardStore } from "../store/boardStore.js";
import { AREA_COLORS } from "../types.js";
import { isValidAreaSize, normalizeRect } from "../lib/areas.js";
import { Button } from "./ui/Button.js";
import BoxNode from "./BoxNode.js";
import AreaNode from "./AreaNode.js";
import Cursors from "./Cursors.js";

const nodeTypes = {
  agent: BoxNode,
  idea: BoxNode,
  research: BoxNode,
  summarize: BoxNode,
  image: BoxNode,
  documents: BoxNode,
  cartoon: BoxNode,
  slides: BoxNode,
  code: BoxNode,
  prd: BoxNode,
  devplan: BoxNode,
  ui: BoxNode,
  stitch: BoxNode,
  swot: BoxNode,
  note: BoxNode,
  label: BoxNode,
  timer: BoxNode,
  area: AreaNode,
  custom: BoxNode,
};

export default function Canvas() {
  const nodes = useBoardStore((s) => s.nodes);
  const edges = useBoardStore((s) => s.edges);
  const onNodesChange = useBoardStore((s) => s.onNodesChange);
  const onEdgesChange = useBoardStore((s) => s.onEdgesChange);
  const onConnect = useBoardStore((s) => s.onConnect);
  const updateCursorPosition = useBoardStore((s) => s.updateCursorPosition);
  const cleanupPresence = useBoardStore((s) => s.cleanupPresence);

  const { screenToFlowPosition } = useReactFlow();

  // Track mouse movement and update presence
  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      if (pos) {
        updateCursorPosition(pos.x, pos.y);
      }
    },
    [screenToFlowPosition, updateCursorPosition]
  );

  // Cleanup presence on unmount
  useEffect(() => {
    return () => cleanupPresence();
  }, [cleanupPresence]);

  // === Area drawing tool ===
  const addArea = useBoardStore((s) => s.addArea);
  const [areaTool, setAreaTool] = useState(false);
  const [areaColorIdx, setAreaColorIdx] = useState(0);
  const [draft, setDraft] = useState<{ start: { x: number; y: number }; current: { x: number; y: number } } | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Begin a draft on pane mousedown while the tool is active; track the drag
  // with window listeners so the rectangle keeps following the cursor even
  // outside the pane.
  const onCanvasMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!areaTool) return;
      // Only start on empty canvas — not on an existing node/area.
      const target = e.target as HTMLElement;
      if (!target.classList.contains("react-flow__pane")) return;
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      setDraft({ start: p, current: p });
      e.preventDefault();
    },
    [areaTool, screenToFlowPosition]
  );

  useEffect(() => {
    if (!draft) return;
    const onMove = (e: MouseEvent) => {
      const d = draftRef.current;
      if (!d) return;
      setDraft({ ...d, current: screenToFlowPosition({ x: e.clientX, y: e.clientY }) });
    };
    const onUp = () => {
      const d = draftRef.current;
      setDraft(null);
      if (!d) return;
      const rect = normalizeRect(d.start, d.current);
      if (isValidAreaSize(rect)) {
        const c = AREA_COLORS[areaColorIdx] || AREA_COLORS[0];
        addArea(rect, c.fill, c.border);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [draft !== null, areaColorIdx, addArea, screenToFlowPosition]);

  // Escape cancels an in-progress draft and deactivates the tool.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setDraft(null);
      setAreaTool(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const draftRect = draft ? normalizeRect(draft.start, draft.current) : null;

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onMouseMove={onMouseMove}
      onMouseDown={onCanvasMouseDown}
      // While the area tool is active, dragging draws a rectangle instead of
      // panning the canvas or moving nodes.
      panOnDrag={!areaTool}
      nodesDraggable={!areaTool}
      className={areaTool ? "area-tool-active" : undefined}
      fitView
      fitViewOptions={{ padding: 0.3 }}
      defaultEdgeOptions={{
        animated: true,
        style: { stroke: "#cbd5e1", strokeWidth: 2 },
      }}
      proOptions={{ hideAttribution: true }}
      // Treat every node as a "no wheel" zone: when the cursor is over a box,
      // trackpad scroll / pinch must not zoom the canvas (it would fight the
      // box's own scrolling). Zooming still works over empty canvas space.
      noWheelClassName="react-flow__node"
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} />
      <Controls />
      <Cursors />
      {/* Area drawing tool */}
      <div className="absolute top-3 left-3 z-10 flex flex-col gap-1.5">
        <Button
          size="xs"
          variant={areaTool ? "primary" : "secondary"}
          onClick={() => { setAreaTool((t) => !t); setDraft(null); }}
          title="Draw a rectangular area under the boxes"
          className="shadow-md"
        >
          ▭ {areaTool ? "Drawing areas — Esc to stop" : "Area"}
        </Button>
        {areaTool && (
          <div className="flex items-center gap-1.5 rounded-lg bg-white/90 backdrop-blur px-2 py-1.5 shadow-md border border-slate-200">
            {AREA_COLORS.map((c, i) => (
              <button
                key={c.fill}
                onClick={() => setAreaColorIdx(i)}
                title={`Draw color — ${c.name}`}
                className={
                  "w-5 h-5 rounded-md border transition hover:scale-110 " +
                  (i === areaColorIdx ? "border-slate-600 scale-110" : "border-slate-300")
                }
                style={{ backgroundColor: c.fill, borderColor: i === areaColorIdx ? c.border : undefined }}
              />
            ))}
          </div>
        )}
      </div>
      {/* Draft rectangle preview (viewport-transformed like Cursors) */}
      {draftRect && <AreaDraft rect={draftRect} />}
      <MiniMap
        pannable
        zoomable
        nodeColor={(node: Node) => {
          const colors: Record<string, string> = {
            agent: "#4f46e5",
            idea: "#fbbf24",
            research: "#60a5fa",
            summarize: "#a78bfa",
            image: "#34d399",
            documents: "#64748b",
            cartoon: "#f472b6",
            slides: "#fb923c",
            code: "#22d3ee",
            prd: "#818cf8",
            devplan: "#14b8a6",
            ui: "#c026d3",
            stitch: "#0ea5e9",
            note: "#fbbf24",
            label: "#64748b",
            timer: "#06b6d4",
          };
          if (node.type === "area") {
            // Areas are near-white on the minimap — use their border shade.
            return (node.data as any)?.border || "#cbd5e1";
          }
          if (node.type === "custom") {
            return (node.data as any)?.customColor || "#6366f1";
          }
          return colors[node.type || ""] || "#94a3b8";
        }}
      />
    </ReactFlow>
  );
}

/** In-progress area rectangle, transformed with the viewport like Cursors. */
function AreaDraft({ rect }: { rect: { x: number; y: number; width: number; height: number } }) {
  const viewport = useViewport();
  return (
    <div
      className="absolute inset-0 pointer-events-none z-20"
      style={{
        transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
        transformOrigin: "0 0",
      }}
    >
      <div
        className="absolute rounded-xl"
        style={{
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
          backgroundColor: "rgba(6, 182, 212, 0.06)",
          border: "1.5px dashed #06b6d4",
        }}
      />
    </div>
  );
}
