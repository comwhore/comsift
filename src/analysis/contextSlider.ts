export const CONTEXT_STEP = 1024;
export const CONTEXT_MIN = 1024;
export const CONTEXT_MAX = 102400;

export function clampContext(value: number): number {
  if (!Number.isFinite(value)) return CONTEXT_MIN;
  return Math.round(Math.min(CONTEXT_MAX, Math.max(CONTEXT_MIN, value)));
}

/** Snap to the 1024 grid unless the user is holding Shift for fine control. */
export function snapContext(value: number, smooth: boolean): number {
  const clamped = clampContext(value);
  return smooth ? clamped : clampContext(Math.round(clamped / CONTEXT_STEP) * CONTEXT_STEP);
}

/**
 * Range + editable number for the model context window. Steps by 1024; holding
 * Shift while dragging (or using arrow keys) moves smoothly one token at a time.
 */
export function contextSlider(parent: HTMLElement, initial: number, onChange: (value: number) => void,
  onCleanup: (cleanup: () => void) => void): HTMLElement {
  const wrap = parent.createDiv({ cls: "comsift-context-slider", attr: { title: "Context tokens. Hold Shift for fine steps; type an exact value in the box." } });
  wrap.createSpan({ cls: "comsift-context-label", text: "Context" });
  const range = wrap.createEl("input", { type: "range", attr: {
    min: String(CONTEXT_MIN), max: String(CONTEXT_MAX), step: String(CONTEXT_STEP), "aria-label": "Context tokens",
  } });
  const number = wrap.createEl("input", { type: "number", cls: "comsift-context-number", attr: {
    min: String(CONTEXT_MIN), max: String(CONTEXT_MAX), step: "1", "aria-label": "Context tokens value",
  } });
  let current = clampContext(initial);
  range.value = String(current);
  number.value = String(current);

  const setSmooth = (smooth: boolean) => { range.step = smooth ? "1" : String(CONTEXT_STEP); };
  const shift = (event: KeyboardEvent | PointerEvent) => setSmooth(event.shiftKey);
  const win = parent.win ?? window;
  const release = (event: KeyboardEvent) => { if (event.key === "Shift") setSmooth(false); };
  const press = (event: KeyboardEvent) => { if (event.key === "Shift") setSmooth(true); };
  win.addEventListener("keydown", press);
  win.addEventListener("keyup", release);
  range.addEventListener("pointerdown", shift);
  range.addEventListener("keydown", shift);
  onCleanup(() => {
    win.removeEventListener("keydown", press);
    win.removeEventListener("keyup", release);
  });

  const commit = (value: number) => {
    if (value === current) return;
    current = value;
    onChange(value);
  };
  range.addEventListener("input", () => {
    const value = snapContext(Number(range.value), range.step === "1");
    number.value = String(value);
    commit(value);
  });
  number.addEventListener("change", () => {
    const value = clampContext(Number(number.value));
    number.value = String(value);
    range.value = String(value);
    commit(value);
  });
  return wrap;
}
