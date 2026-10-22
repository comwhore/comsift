import type { CanvasDirection } from "../module";

interface Rect { x: number; y: number; width: number; height: number }
interface GeometryData { nodes: Array<Rect & { id: string }>; edges: Array<{ fromNode: string; toNode: string; fromSide?: string; toSide?: string }> }
const SIDES: CanvasDirection[] = ["right", "bottom", "left", "top"];
export function opposite(direction: CanvasDirection): CanvasDirection {
  return { top: "bottom", bottom: "top", left: "right", right: "left" }[direction] as CanvasDirection;
}
/** Choose the outward faces intersected by the line joining rectangle centres. */
export function connectionSides(from: Rect, to: Rect): { fromSide: CanvasDirection; toSide: CanvasDirection } {
  const dx = to.x + to.width / 2 - from.x - from.width / 2;
  const dy = to.y + to.height / 2 - from.y - from.height / 2;
  const face = (rect: Rect, x: number, y: number): CanvasDirection => Math.abs(x) / Math.max(1, rect.width) >= Math.abs(y) / Math.max(1, rect.height)
    ? x >= 0 ? "right" : "left" : y >= 0 ? "bottom" : "top";
  return { fromSide: face(from, dx, dy), toSide: face(to, -dx, -dy) };
}
export function resolveOutputDirection(data: GeometryData, nodeId: string, setting: CanvasDirection | "auto"): CanvasDirection {
  if (setting !== "auto") return setting;
  const node = data.nodes.find(entry => entry.id === nodeId);
  if (!node) return "right";
  const counts = new Map<CanvasDirection, number>(SIDES.map(side => [side, 0]));
  const incoming: CanvasDirection[] = [];
  for (const edge of data.edges) {
    if (edge.fromNode !== nodeId && edge.toNode !== nodeId) continue;
    const isTarget = edge.toNode === nodeId;
    const ends = edge as typeof edge & { fromEnd?: string; toEnd?: string };
    const isIncoming = isTarget ? ends.toEnd !== "none" : ends.fromEnd === "arrow";
    const other = data.nodes.find(entry => entry.id === (isTarget ? edge.fromNode : edge.toNode));
    const raw = isTarget ? edge.toSide : edge.fromSide;
    const side = SIDES.includes(raw as CanvasDirection) ? raw as CanvasDirection : other ? connectionSides(node, other).fromSide : undefined;
    if (!side) continue;
    counts.set(side, (counts.get(side) ?? 0) + 1);
    if (isIncoming) incoming.push(side);
  }
  const preferred = [...new Set([...incoming.map(opposite), ...SIDES])];
  return preferred.reduce((best, side) => (counts.get(side) ?? 0) < (counts.get(best) ?? 0) ? side : best, preferred[0]);
}
/** Results form a row above/below the source and a column beside it. */
export function resultGroupLayout(source: Rect, count: number, child: Pick<Rect, "width" | "height">, direction: CanvasDirection, gap: number, occupied: Rect[] = [], spacing = 20): Array<{ x: number; y: number }> {
  const row = direction === "top" || direction === "bottom";
  const size = { width: row ? count * child.width + Math.max(0, count - 1) * spacing : child.width,
    height: row ? child.height : count * child.height + Math.max(0, count - 1) * spacing };
  const origin = placeGroup(source, size, direction, gap, occupied);
  return Array.from({ length: count }, (_, index) => ({ x: origin.x + (row ? index * (child.width + spacing) : 0), y: origin.y + (row ? 0 : index * (child.height + spacing)) }));
}
export function placeGroup(source: Rect, size: Pick<Rect, "width" | "height">, direction: CanvasDirection, gap: number, occupied: Rect[] = []): { x: number; y: number } {
  const base = {
    top: { x: source.x + (source.width - size.width) / 2, y: source.y - gap - size.height },
    bottom: { x: source.x + (source.width - size.width) / 2, y: source.y + source.height + gap },
    left: { x: source.x - gap - size.width, y: source.y + (source.height - size.height) / 2 },
    right: { x: source.x + source.width + gap, y: source.y + (source.height - size.height) / 2 },
  }[direction];
  const candidate = { ...base };
  const vertical = direction === "top" || direction === "bottom";
  for (let attempt = 0; attempt <= occupied.length; attempt++) {
    const hit = occupied.find(rect => candidate.x < rect.x + rect.width + 24 && candidate.x + size.width + 24 > rect.x && candidate.y < rect.y + rect.height + 24 && candidate.y + size.height + 24 > rect.y);
    if (!hit) break;
    if (vertical) candidate.x = hit.x + hit.width + 24;
    else candidate.y = hit.y + hit.height + 24;
  }
  return candidate;
}
