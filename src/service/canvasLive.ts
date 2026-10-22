import type { CanvasData } from "./canvasModel";

/**
 * Canvas importData merges by default. Its second argument replaces missing objects.
 * Flush pending user edits before adding one immediate native undo entry for this edit.
 * Verified against the installed Canvas implementation (importData/requestSave/pushHistory).
 */
export function replaceLiveCanvas(canvas: M.Canvas, data: CanvasData): void {
  const immediateHistory = typeof canvas.pushHistory === "function" && !!canvas.requestPushHistory;
  if (immediateHistory) canvas.requestPushHistory!.run();
  canvas.importData(data, true);
  if (immediateHistory) {
    canvas.pushHistory!(canvas.getData());
    canvas.requestSave?.(false);
  } else {
    // Older Canvas implementations still record changes through their regular save path.
    canvas.requestSave?.();
  }
}
