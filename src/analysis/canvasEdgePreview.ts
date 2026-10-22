import type { App } from "obsidian";
import type { CanvasData, CanvasEdge, CanvasNode } from "../service/canvasModel";
import { connectionSides } from "../service/placement";

type Point = { x: number; y: number };
const vectors: Record<string, Point> = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } };
const box = (node: CanvasNode) => ({ minX: node.x, minY: node.y, maxX: node.x + node.width, maxY: node.y + node.height });
const port = (node: CanvasNode, side: string): Point => ({ x: node.x + (side === "left" ? 0 : side === "right" ? node.width : node.width / 2), y: node.y + (side === "top" ? 0 : side === "bottom" ? node.height : node.height / 2) });

/** Runs Advanced Canvas routing on detached data only: no native board edits or history entries. */
export function canvasEdgeGeometry(app: App, data: CanvasData, edge: CanvasEdge) {
  const from = data.nodes.find(node => node.id === edge.fromNode), to = data.nodes.find(node => node.id === edge.toNode);
  if (!from || !to) return null;
  const automatic = connectionSides(from, to);
  const fromSide = edge.fromSide && vectors[edge.fromSide] ? edge.fromSide : automatic.fromSide;
  const toSide = edge.toSide && vectors[edge.toSide] ? edge.toSide : automatic.toSide;
  const a = port(from, fromSide), b = port(to, toSide);
  const av = vectors[fromSide], bv = vectors[toSide];
  const distance = Math.max(40, Math.hypot(a.x - b.x, a.y - b.y) / 2);
  const c = { x: a.x + av.x * distance, y: a.y + av.y * distance }, d = { x: b.x + bv.x * distance, y: b.y + bv.y * distance };
  let path = `M ${a.x} ${a.y} C ${c.x} ${c.y} ${d.x} ${d.y} ${b.x} ${b.y}`;
  let center = { x: (a.x + 3 * c.x + 3 * d.x + b.x) / 8, y: (a.y + 3 * c.y + 3 * d.y + b.y) / 8 };
  const styles = edge.styleAttributes && typeof edge.styleAttributes === "object" ? edge.styleAttributes as Record<string, unknown> : {};
  const method = styles.pathfindingMethod;
  if (method === "direct") path = `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  if (method === "square" || method === "a-star") path = `M ${a.x} ${a.y} L ${(a.x + b.x) / 2} ${a.y} L ${(a.x + b.x) / 2} ${b.y} L ${b.x} ${b.y}`;
  if (method && method !== "bezier") {
    const internal = app as unknown as { plugins?: { getPlugin?: (id: string) => unknown } };
    const plugin = internal.plugins?.getPlugin?.("advanced-canvas") as { canvasExtensions?: unknown[] } | undefined;
    const extension = plugin?.canvasExtensions?.find(value => !!value && typeof value === "object" && "onEdgeChanged" in value && "getArrowPolygonPoints" in value) as { onEdgeChanged?: (canvas: unknown, edge: unknown) => void } | undefined;
    if (typeof extension?.onEdgeChanged === "function") {
      const nodeFacade = (node: CanvasNode) => ({ getBBox: () => box(node), getData: () => node });
      const detached: { center?: Point; [key: string]: unknown } = {
        getData: () => edge, updatePath: () => {}, bezier: { from: a, to: b },
        from: { node: nodeFacade(from), side: fromSide, end: edge.fromEnd ?? "none" },
        to: { node: nodeFacade(to), side: toSide, end: edge.toEnd ?? "arrow" },
        path: { interaction: { setAttr: () => {} }, display: { setAttr: (key: string, value: string) => { if (key === "d") path = value; } } },
      };
      const canvas = { isDragging: false, dirty: new Set([detached]), selection: new Set(), nodes: new Map(data.nodes.map(node => [node.id, nodeFacade(node)])) };
      try { extension.onEdgeChanged(canvas, detached); if (detached.center) center = detached.center; }
      catch { /* Version compatibility: retain the port-aware fallback. */ }
    }
  }
  return { path, center, a, b, fromAngle: method === "direct" ? Math.atan2(a.y - b.y, a.x - b.x) : Math.atan2(-av.y, -av.x), toAngle: method === "direct" ? Math.atan2(b.y - a.y, b.x - a.x) : Math.atan2(-bv.y, -bv.x) };
}

export function canvasColor(color?: string): string {
  return color && /^[1-6]$/.test(color) ? `rgb(var(--canvas-color-${color}))` : color && /^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(color) ? color : "var(--text-muted)";
}
