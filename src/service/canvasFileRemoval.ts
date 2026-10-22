import { Notice, type Menu } from "obsidian";
import type ComsiftPlugin from "../main";

export const protectedCanvasNode = (id: string) => id === "comsift-main" || id === "whereami-main";

export function matchesCanvasShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">, shortcut: string): boolean {
  const parts = shortcut.trim().toLowerCase().split("+").map(part => part.trim());
  const key = parts.pop();
  if (!key) return false;
  const mod = parts.includes("mod");
  return event.key.toLowerCase() === (key === "del" ? "delete" : key)
    && (mod ? event.ctrlKey || event.metaKey : event.ctrlKey === parts.includes("ctrl") && event.metaKey === parts.includes("meta"))
    && event.altKey === parts.includes("alt") && event.shiftKey === parts.includes("shift");
}

/** Trash files first; if trash fails, retain their nodes so the operation can be retried. */
export async function removeCanvasFiles(plugin: ComsiftPlugin, canvas: M.Canvas, ids: string[]): Promise<void> {
  const selected = new Set(ids.filter(id => !protectedCanvasNode(id)));
  const data = canvas.getData();
  const paths = [...new Set(data.nodes.filter(node => selected.has(node.id) && node.type === "file").map(node => node.file).filter((path): path is string => !!path))];
  for (const path of paths) {
    const file = plugin.app.vault.getFileByPath(path);
    if (file) await plugin.app.fileManager.trashFile(file);
  }
  const current = canvas.getData();
  const next = { ...current, nodes: current.nodes.filter(node => !selected.has(node.id)), edges: current.edges.filter(edge => !selected.has(edge.fromNode) && !selected.has(edge.toNode)) };
  canvas.importData(next, true);
  canvas.requestSave?.(true);
  canvas.deselectAll?.();
}

export function addRemoveCanvasFileItem(plugin: ComsiftPlugin, menu: Menu, canvas: M.Canvas, nodeId: string) {
  const node = canvas.getData().nodes.find(node => node.id === nodeId);
  if (!node?.file || protectedCanvasNode(nodeId)) return;
  const internal = menu as unknown as { items?: Array<{ title?: string; titleEl?: HTMLElement; dom?: HTMLElement }> };
  menu.addItem(item => item.setTitle("Remove file").setIcon("file-minus").onClick(() => {
    void removeCanvasFiles(plugin, canvas, [nodeId]).catch(error => new Notice(`Could not remove file: ${error instanceof Error ? error.message : String(error)}`));
  }));
  // Obsidian exposes no public insertion API; preserve all native items and move ours after Remove.
  if (internal.items) {
    const added = internal.items.pop();
    const index = internal.items.findIndex(item => {
      const title = item.title ?? item.titleEl?.textContent ?? item.dom?.querySelector(".menu-item-title")?.textContent ?? "";
      return /^(?:remove|delete)(?: node| item| from canvas)?$/i.test(title.trim());
    });
    if (added) {
      const previous = internal.items[index];
      internal.items.splice(index < 0 ? internal.items.length : index + 1, 0, added);
      if (previous?.dom && added.dom) previous.dom.after(added.dom);
    }
  }
}
