// One-time removal of the retired "graph canvases" feature (generated Comsift/Graphs/*.canvas boards).
import { TFile, TFolder, normalizePath } from "obsidian";
import type ComsiftPlugin from "../main";

const LEGACY_SETTINGS = ["graphCanvasEnabled", "graphCanvasFolder", "graphCanvasDepth", "graphCanvasPeople"] as const;
const LEGACY_FOLDERS = ["Comsift/Graphs", "Comsift/Graph"];

/** A board Comsift generated: valid Canvas JSON whose non-group nodes all carry generated `cg-` IDs. */
export function isGeneratedGraphCanvas(text: string): boolean {
  try {
    const data = JSON.parse(text) as { nodes?: unknown };
    if (!Array.isArray(data?.nodes)) return false;
    return (data.nodes as Array<{ id?: unknown; type?: unknown }>).every(node =>
      node?.type === "group" || (typeof node?.id === "string" && node.id.startsWith("cg-")));
  } catch { return false; }
}

/**
 * Trash the boards listed in the old `graphCanvasFiles` registry (only those that still exist and still
 * look generated), drop the registry and the old settings, and remove the graph folder when it is empty.
 */
export async function cleanupGraphCanvases(plugin: ComsiftPlugin): Promise<void> {
  const state = plugin.state as unknown as Record<string, unknown>;
  const settings = plugin.setting as unknown as Record<string, unknown>;
  const registry = state.graphCanvasFiles as Record<string, unknown> | undefined;
  const hasSettings = LEGACY_SETTINGS.some(key => key in settings);
  if (registry === undefined && !hasSettings) return;
  const { vault, fileManager } = plugin.app;
  const folders = new Set(LEGACY_FOLDERS);
  if (typeof settings.graphCanvasFolder === "string" && settings.graphCanvasFolder.trim()) {
    folders.add(normalizePath(settings.graphCanvasFolder.trim().replace(/^\/+|\/+$/g, "")));
  }
  for (const path of Object.keys(registry && typeof registry === "object" ? registry : {})) {
    const file = vault.getFileByPath(path);
    if (!(file instanceof TFile) || file.extension !== "canvas") continue;
    folders.add(path.split("/").slice(0, -1).join("/"));
    try {
      if (isGeneratedGraphCanvas(await vault.cachedRead(file))) await fileManager.trashFile(file);
    } catch (error) { console.error("[comsift] could not remove an old graph canvas", path, error); }
  }
  for (const folder of folders) {
    const entry = folder ? vault.getAbstractFileByPath(folder) : null;
    if (entry instanceof TFolder && !entry.children.length) {
      try { await fileManager.trashFile(entry); } catch { /* left in place */ }
    }
  }
  delete state.graphCanvasFiles;
  if (hasSettings) {
    for (const key of LEGACY_SETTINGS) delete settings[key];
    await plugin.saveSettings();
  } else await plugin.saveState();
}
