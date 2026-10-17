import type { CanvasData } from "./canvasModel";

/** Stable comparison ignores object key order, preserving array order and all custom fields. */
export function canvasFingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canvasFingerprint).join(",")}]`;
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .filter(([, entry]) => entry !== undefined).map(([key, entry]) => `${JSON.stringify(key)}:${canvasFingerprint(entry)}`).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}

export function assertCanvasSnapshot(current: CanvasData, expected: CanvasData): void {
  if (canvasFingerprint(current) !== canvasFingerprint(expected)) throw new Error("Canvas changed since this preview. Generate a fresh proposal to avoid overwriting your edits.");
}

export function changedCanvasIds(before: CanvasData, after: CanvasData): Set<string> {
  const next = new Map([...after.nodes, ...after.edges].map(item => [item.id, canvasFingerprint(item)]));
  return new Set([...before.nodes, ...before.edges].filter(item => next.get(item.id) !== canvasFingerprint(item)).map(item => item.id));
}
