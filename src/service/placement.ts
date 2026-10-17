import type { CanvasDirection } from "../module";

interface Rect { x: number; y: number; width: number; height: number }

export function opposite(direction: CanvasDirection): CanvasDirection {
  return { top: "bottom", bottom: "top", left: "right", right: "left" }[direction] as CanvasDirection;
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
  for (let attempt = 0; attempt < 40; attempt++) {
    const hit = occupied.find(rect => candidate.x < rect.x + rect.width + 24 &&
      candidate.x + size.width + 24 > rect.x && candidate.y < rect.y + rect.height + 24 &&
      candidate.y + size.height + 24 > rect.y);
    if (!hit) break;
    if (vertical) candidate.x = hit.x + hit.width + 24;
    else candidate.y = hit.y + hit.height + 24;
  }
  return candidate;
}
