import { diagramViewports } from "./diagramViewport";
import { Component, MarkdownRenderer, type App } from "obsidian";
import { normalizeMermaidMarkdown } from "./mermaid";

/** A render owns its embeds. Replaced or late renders never modify the current body. */
export function chatMarkdown(app: App, host: HTMLElement, sourcePath: string, owner: Component, onError: (error: unknown) => void = () => {}) {
  let current: Component | null = null;
  let version = 0;
  const clear = () => {
    version++;
    if (current) { current.unload(); owner.removeChild(current); current = null; }
  };
  const setMarkdown = (markdown: string) => {
    clear(); host.empty();
    const epoch = version;
    const holder = new Component(); current = holder; owner.addChild(holder);
    const stage = host.createDiv({ cls: "comsift-markdown-body markdown-rendered" });
    void MarkdownRenderer.render(app, normalizeMermaidMarkdown(markdown), stage, sourcePath, holder).then(() => {
      if (version !== epoch) { holder.unload(); stage.remove(); }
      else if (host.closest(".comsift-review-ai-summary, .comsift-summary-tab")) diagramViewports(stage, holder);
    }).catch(error => {
      if (version !== epoch) { holder.unload(); stage.remove(); return; }
      stage.setText(markdown); onError(error);
    });
  };
  return { setMarkdown, setText: setMarkdown, clear, dispose: clear };
}
