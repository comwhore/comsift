import { TAbstractFile, TFile, normalizePath } from "obsidian";
import ComsiftPlugin from "../main";
import type { Investigation } from "../service/investigation";
import { isSheetPath, parseSheetMd, safeFileName, toCsv } from "./sheets";

export const HIDDEN_DIR = ".comsift/sheets";

export interface SheetDataset { name: string; csv: string }

/**
 * Keeps hidden CSV copies of every `.sheet.md` inside a user folder up to date.
 * Dot folders are not indexed by Obsidian, so everything goes through the vault adapter
 * (which also means writing them never triggers vault events).
 */
export class SheetSync {
  private timers = new Map<string, number>();
  constructor(private plugin: ComsiftPlugin) {}

  start() {
    const { vault } = this.plugin.app;
    const touched = (file: TAbstractFile) => { if (file instanceof TFile && isSheetPath(file.path)) this.schedule(file.path); };
    this.plugin.registerEvent(vault.on("modify", touched));
    this.plugin.registerEvent(vault.on("create", touched));
    this.plugin.registerEvent(vault.on("delete", touched));
    this.plugin.registerEvent(vault.on("rename", (file, oldPath) => {
      if (isSheetPath(oldPath)) this.schedule(oldPath);
      touched(file);
    }));
    this.plugin.app.workspace.onLayoutReady(() => void this.syncAll());
  }

  private schedule(path: string) {
    window.clearTimeout(this.timers.get(path));
    this.timers.set(path, window.setTimeout(() => {
      this.timers.delete(path);
      const item = this.plugin.investigations.forPath(path)
        ?? Object.values(this.plugin.state.investigations).find(candidate => this.dirOf(path).startsWith(candidate.folderPath));
      if (item) void this.sync(item).catch(error => console.error("[comsift] sheet sync failed", error));
    }, 800));
  }

  private dirOf(path: string) { return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""; }

  async syncAll() {
    for (const item of Object.values(this.plugin.state.investigations)) {
      try { await this.sync(item); } catch (error) { console.error("[comsift] sheet sync failed", error); }
    }
  }

  /** Regenerate hidden CSVs for one user folder; returns the datasets (display name → CSV). */
  async sync(item: Investigation): Promise<SheetDataset[]> {
    const { vault } = this.plugin.app;
    const adapter = vault.adapter;
    const dir = normalizePath(`${item.folderPath}/${HIDDEN_DIR}`);
    const sheets = vault.getFiles().filter(file => isSheetPath(file.path) && file.path.startsWith(item.folderPath + "/"));
    const wanted = new Map<string, string>();
    const datasets: SheetDataset[] = [];
    for (const file of sheets) {
      const tables = parseSheetMd(await vault.cachedRead(file));
      const stem = safeFileName(file.path.slice(item.folderPath.length + 1).replace(/\.sheet\.md$/i, "").replace(/\//g, " › "));
      for (const table of tables) {
        const single = tables.length === 1;
        const csv = toCsv(table.rows);
        wanted.set(`${stem}${single ? "" : ` - ${safeFileName(table.name)}`}.csv`, csv);
        datasets.push({ name: single ? file.path : `${file.path}#${table.name}`, csv });
      }
    }
    if (!wanted.size && !(await adapter.exists(dir))) return datasets;
    if (!(await adapter.exists(dir))) await this.mkdirs(dir);
    const existing = (await adapter.list(dir)).files.map(path => path.split("/").at(-1)!);
    for (const [name, csv] of wanted) {
      const path = `${dir}/${name}`;
      if (existing.includes(name) && await adapter.read(path) === csv) continue;
      await adapter.write(path, csv);
    }
    for (const name of existing) {
      if (name.endsWith(".csv") && !wanted.has(name)) await adapter.remove(`${dir}/${name}`);
    }
    return datasets;
  }

  private async mkdirs(path: string) {
    const adapter = this.plugin.app.vault.adapter;
    let current = "";
    for (const part of path.split("/")) {
      current = current ? `${current}/${part}` : part;
      if (!(await adapter.exists(current))) await adapter.mkdir(current);
    }
  }
}
