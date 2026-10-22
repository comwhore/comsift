// Read-only cell embeds: `![[Example.sheet#A1]]`, `![[Example.sheet#A1:B2]]`, `![[Example.sheet#Sheet1!A1:B2]]`.
// The bundled spreadsheet finds the embed element (reading view, Live Preview, Canvas) and asks
// `element()` first; anything that is not a cell reference keeps the spreadsheet's own embed.
import { Keymap, TFile, type App, type PaneType, type Plugin, type View } from "obsidian";
import { cellBlocks, cellTarget, formatCellRef, parseCellRef, parseCsv, pickSheet, splitEmbedLink, type CellRef, type CellTarget } from "./cellRefs";
import { parseSheetMd, isSheetPath, type SheetTable } from "./sheets";
import type { SheetRange } from "./sheetRanges";

const letter = (index: number): string => { let value = index + 1, out = ""; while (value > 0) { value--; out = String.fromCharCode(65 + value % 26) + out; value = Math.floor(value / 26); } return out; };

export function tablesFromText(path: string, text: string): SheetTable[] {
  if (isSheetPath(path)) return parseSheetMd(text);
  if (path.toLowerCase().endsWith(".csv")) return [{ name: "Sheet1", rows: parseCsv(text) }];
  return [];
}

interface LiveEmbed { el: HTMLElement; render: () => Promise<void> }

/** The bundled spreadsheet view (excel-modded `ExcelView`) once it has loaded a file. */
type SheetView = View & { file?: TFile | null; comsiftSelect?: (target: CellTarget) => void };

const wait = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));

export class CellEmbeds {
  private live = new Map<string, Set<LiveEmbed>>();
  private app: App;

  constructor(plugin: Plugin) {
    this.app = plugin.app;
    plugin.registerEvent(this.app.vault.on("modify", file => this.refresh(file.path)));
    plugin.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      const entries = this.live.get(oldPath);
      if (entries) { this.live.delete(oldPath); this.live.set(file.path, entries); }
    }));
    plugin.register(() => this.live.clear());
  }

  /** Embed element for `link` (`X.sheet#A1:B2`), or null when the subpath is not a cell reference. */
  element(file: TFile, link: string): HTMLElement | null {
    const ref = parseCellRef(splitEmbedLink(link.replace("{html}", "")).subpath);
    if (!ref) return null;
    const el = createDiv({ cls: "comsift-cells" });
    this.mount(el, file, ref);
    return el;
  }

  /** Render `ref` of `file` into `el` and keep it current while `el` stays in the document. */
  mount(el: HTMLElement, file: TFile, ref: CellRef, title?: string): void {
    const entry: LiveEmbed = { el, render: async () => {
      const current = this.app.vault.getFileByPath(file.path) ?? file;
      let tables: SheetTable[] = [];
      try { tables = tablesFromText(current.path, await this.app.vault.cachedRead(current)); } catch { tables = []; }
      this.draw(el, current, ref, tables, title);
    } };
    void entry.render();
    for (const [path, entries] of this.live) {
      for (const item of entries) if (!item.el.isConnected && item.el !== el) entries.delete(item);
      if (!entries.size) this.live.delete(path);
    }
    const set = this.live.get(file.path) ?? new Set<LiveEmbed>();
    set.add(entry);
    this.live.set(file.path, set);
  }

  /**
   * Open `file` in the spreadsheet view with `target` selected. `pane` follows normal links (Ctrl/Cmd-click
   * → new tab). The view loads asynchronously, so this waits (up to ~4 s) for it to show the file.
   */
  async open(file: TFile, target: CellTarget | null, pane: PaneType | boolean = false): Promise<void> {
    const leaf = this.app.workspace.getLeaf(pane);
    const subpath = target ? `#${formatCellRef({ sheet: target.sheet, ranges: [{ sri: target.sri, sci: target.sci, eri: target.eri, eci: target.eci }] })}` : "";
    await leaf.openFile(file, { active: true, eState: subpath ? { subpath } : undefined });
    if (!target) return;
    for (let i = 0; i < 80; i++) {
      const view = leaf.view as SheetView;
      if (typeof view.comsiftSelect === "function" && view.file?.path === file.path) { view.comsiftSelect(target); return; }
      await wait(50);
    }
  }

  private refresh(path: string) {
    const entries = this.live.get(path);
    if (!entries) return;
    for (const entry of [...entries]) {
      if (entry.el.isConnected) void entry.render();
      else entries.delete(entry);
    }
    if (!entries.size) this.live.delete(path);
  }

  private draw(el: HTMLElement, file: TFile, ref: CellRef, tables: SheetTable[], title?: string) {
    el.empty();
    const table = pickSheet(tables, ref.sheet);
    const open = (event: MouseEvent, block?: number, pane: PaneType | boolean = Keymap.isModEvent(event)) => { void this.open(file, cellTarget({ ...ref, sheet: table?.name ?? ref.sheet }, block), pane); };
    const head = el.createDiv({ cls: "comsift-cells-head" });
    const name = file.basename.replace(/\.sheet$/i, "");
    const link = head.createEl("a", { cls: "comsift-cells-link", text: title ?? `${name} › ${formatCellRef({ ...ref, sheet: table?.name ?? ref.sheet })}`, attr: { href: "#", "aria-label": `Open ${file.path}` } });
    link.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); open(event); });
    link.addEventListener("auxclick", event => { if (event.button !== 1) return; event.preventDefault(); event.stopPropagation(); open(event, undefined, "tab"); });
    if (!table) { el.createDiv({ cls: "comsift-cells-missing", text: ref.sheet ? `Sheet "${ref.sheet}" was not found.` : "This file has no sheets." }); return; }
    const grid = el.createEl("table", { cls: "comsift-cells-table" });
    const columns = (range: SheetRange) => Array.from({ length: range.eci - range.sci + 1 }, (_, i) => range.sci + i);
    const blocks = cellBlocks(table, ref.ranges);
    const sameColumns = blocks.every(block => block.range.sci === blocks[0].range.sci && block.range.eci === blocks[0].range.eci);
    let previous: SheetRange | null = null;
    blocks.forEach((block, blockIndex) => {
      if (!previous || !sameColumns) {
        const header = grid.createEl("tr", { cls: "comsift-cells-letters" });
        header.createEl("th");
        for (const column of columns(block.range)) header.createEl("th", { text: letter(column) });
      } else if (block.range.sri > previous.eri + 1) {
        const gap = grid.createEl("tr", { cls: "comsift-cells-gap" });
        gap.createEl("th", { text: "⋮" });
        gap.createEl("td", { attr: { colspan: String(block.range.eci - block.range.sci + 1) } });
      }
      block.rows.forEach((cells, index) => {
        const tr = grid.createEl("tr", { attr: { "data-block": String(blockIndex) } });
        tr.createEl("th", { text: String(block.range.sri + index + 1) });
        for (const cell of cells) tr.createEl("td", { text: cell });
      });
      previous = block.range;
    });
    // The second press of a double-click must not move the editor cursor into the embed source (Live Preview).
    grid.addEventListener("mousedown", event => { if (event.detail > 1) { event.preventDefault(); event.stopPropagation(); } });
    // Double-click opens the sheet at the embedded cells (the part that was double-clicked).
    grid.addEventListener("dblclick", event => {
      event.preventDefault(); event.stopPropagation();
      const row = event.target instanceof Element ? event.target.closest("tr[data-block]") : null;
      open(event, row ? Number(row.getAttribute("data-block")) : undefined);
    });
  }
}
