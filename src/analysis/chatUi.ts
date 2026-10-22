import { htmlToMarkdown, setIcon } from "obsidian";

/** Compact accessible controls shared by both chat surfaces. */
export function chatIconButton(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
  const button = parent.createEl("button", { cls: "comsift-chat-icon clickable-icon", attr: { "aria-label": label, title: label, type: "button" } });
  setIcon(button, icon);
  return button;
}

/** Collapsed block with the error, HTTP status, request summary and response body. */
export function errorDetails(parent: HTMLElement, error: unknown, fullDetails = false): HTMLElement | null {
  const info = error as { message?: string; status?: number; request?: string; body?: string };
  if (fullDetails || (!info?.status && !info?.request && (!info?.body || info.body.trim() === info.message?.trim()))) return null;
  const details = parent.createEl("details", { cls: "comsift-error-details" });
  details.createEl("summary", { text: "Error details" });
  const lines = [`Error: ${info?.message ?? String(error)}`, info?.status !== undefined ? `HTTP status: ${info.status}` : "", info?.request ? `\nRequest:\n${info.request}` : "", info?.body ? `\nResponse:\n${info.body}` : ""];
  details.createEl("pre", { text: lines.filter(Boolean).join("\n") });
  return details;
}

const promptEditors = new WeakMap<object, () => void>();
/** Edit the rendered body itself: no replacement control can change its text geometry. */
export function inlinePromptEditor(host: HTMLElement, read: () => string, restore: () => void, submit: (text: string) => boolean, beforeOpen: () => void = () => {}, scope: object = host) {
  let editor: HTMLElement | null = null;
  let actions: HTMLElement | null = null;
  let dirty = false;
  let originalWidth = "";
  const onInput = () => { dirty = true; };
  const onKey = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); close(); }
  };
  const dispose = () => {
    if (editor) {
      editor.removeAttribute("contenteditable"); editor.removeAttribute("role"); editor.removeAttribute("aria-label"); editor.removeAttribute("aria-multiline");
      editor.removeClass("comsift-inline-prompt");
      editor.removeEventListener("input", onInput); editor.removeEventListener("keydown", onKey);
    }
    actions?.remove(); actions = null; editor = null;
    host.style.width = originalWidth;
    if (promptEditors.get(scope) === close) promptEditors.delete(scope);
  };
  const close = () => { if (!editor) return; dispose(); restore(); };
  const open = () => {
    if (editor) { editor.focus(); return; }
    promptEditors.get(scope)?.();
    originalWidth = host.style.width;
    const width = host.getBoundingClientRect().width;
    beforeOpen();
    if (width > 0) host.style.width = `${width}px`;
    editor = host.querySelector<HTMLElement>(".comsift-markdown-body") ?? host;
    editor.addClass("comsift-inline-prompt");
    editor.setAttribute("contenteditable", "plaintext-only"); editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-label", "Edit prompt"); editor.setAttribute("aria-multiline", "true");
    dirty = false;
    editor.addEventListener("input", onInput); editor.addEventListener("keydown", onKey);
    actions = host.createDiv({ cls: "comsift-inline-prompt-actions" });
    actions.createEl("button", { text: "Send", cls: "mod-cta" }).onclick = () => {
      if (!editor) return;
      // Preserve original Markdown byte-for-byte when the user only enters and sends the editor.
      const text = (dirty ? htmlToMarkdown(editor) : read()).trim();
      if (text && submit(text)) close();
    };
    actions.createEl("button", { text: "Cancel" }).onclick = close;
    promptEditors.set(scope, close);
    editor.focus();
  };
  return Object.assign(open, { dispose });
}

/** Apply the latest value at most once per interval, so streaming text cannot flood the DOM. */
export function throttleText(apply: (value: string) => void, ms = 150): (value: string) => void {
  let latest = "";
  let timer: number | null = null;
  return value => {
    latest = value;
    if (timer === null) timer = window.setTimeout(() => { timer = null; apply(latest); }, ms);
  };
}

export interface TraceCall { output: (text: string) => void; thinking: (text: string) => void }
export interface TraceSink { call: (label: string, request: unknown) => TraceCall }

/** Collapsed "Details" block listing every model request with its tools, streamed output and thinking. */
export function traceDetails(parent: HTMLElement): TraceSink {
  const details = parent.createEl("details", { cls: "comsift-trace" });
  details.createEl("summary", { text: "Details" });
  return {
    call: (label, request) => {
      const block = details.createEl("details", { cls: "comsift-trace-call" });
      block.createEl("summary", { text: label });
      block.createEl("strong", { text: "Request" });
      block.createEl("pre", { text: JSON.stringify(request, null, 2) });
      const thinking = block.createEl("details");
      thinking.hidden = true;
      thinking.createEl("summary", { text: "Thinking" });
      const thoughtText = thinking.createEl("pre");
      block.createEl("strong", { text: "Output" });
      const output = block.createEl("pre");
      const showOutput = throttleText(value => { output.setText(value); });
      const showThought = throttleText(value => { thinking.hidden = !value; thoughtText.setText(value); });
      return { output: showOutput, thinking: showThought };
    },
  };
}

/** Previous/next arrows with an "n/total" label for cycling through regenerated answers. */
export function variantBar(actions: HTMLElement, onSelect: (index: number) => void) {
  const wrap = actions.createSpan({ cls: "comsift-variants" });
  wrap.hidden = true;
  const prev = chatIconButton(wrap, "chevron-left", "Previous answer");
  const label = wrap.createSpan({ cls: "comsift-variants-label" });
  const next = chatIconButton(wrap, "chevron-right", "Next answer");
  let count = 0, active = 0;
  const paint = () => { wrap.hidden = count < 2; label.setText(`${active + 1}/${count}`); prev.disabled = active === 0; next.disabled = active >= count - 1; };
  prev.onclick = () => { if (active > 0) { active--; paint(); onSelect(active); } };
  next.onclick = () => { if (active < count - 1) { active++; paint(); onSelect(active); } };
  return { set: (total: number, index: number) => { count = total; active = index; paint(); } };
}
