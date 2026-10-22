import { FuzzySuggestModal, Notice, TFile } from "obsidian";
import type ComsiftPlugin from "../main";
import { embedMarkdown, type CanvasEmbedSpec } from "./canvasEmbedModel";

export const CANVAS_DEPENDENCIES = ["better-embedded-canvas", "advanced-canvas"] as const;
/** Obsidian has no dependency installer API; check enabled plugins without patching them. */
export function missingCanvasDependencies(plugin: ComsiftPlugin): string[] {
  const app = plugin.app as unknown as { plugins?: { plugins?: Record<string, unknown> } };
  return CANVAS_DEPENDENCIES.filter(id => !app.plugins?.plugins?.[id]);
}
export function registerCanvasEmbeds(plugin: ComsiftPlugin) {
  plugin.app.workspace.onLayoutReady(() => {
    const missing = missingCanvasDependencies(plugin);
    if (missing.length) new Notice(`Install and enable ${missing.join(" and ")} in Community plugins.`, 15000);
  });
}
export function offerCanvasEmbed(plugin: ComsiftPlugin, spec: CanvasEmbedSpec) {
  const missing = missingCanvasDependencies(plugin);
  if (missing.length) { new Notice(`Enable required plugins: ${missing.join(", ")}.`); return; }
  class NotePicker extends FuzzySuggestModal<TFile> {
    getItems() { return plugin.app.vault.getMarkdownFiles(); }
    getItemText(file: TFile) { return file.path; }
    onChooseItem(file: TFile) {
      void plugin.app.vault.process(file, text => text + embedMarkdown(spec)).catch((error: unknown) => new Notice(error instanceof Error ? error.message : "Could not embed Canvas selection."));
    }
  }
  const picker = new NotePicker(plugin.app);
  picker.setPlaceholder("Choose a note for the Canvas embed"); picker.open();
}
