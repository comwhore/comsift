import { TAbstractFile, TFile } from "obsidian";
import ComsiftPlugin from "../main";
import type { Investigation } from "./investigation";
import { hasManagedLinks, managedLinks, type LinkMap } from "./graphLogic";
import { canvasFiles, canvasLinks, parseCanvas } from "./canvasModel";

export class GraphService {
  private timers = new Map<string, number>();
  private running = false;
  private queue: Promise<void> = Promise.resolve();
  constructor(private plugin: ComsiftPlugin) {}

  start() {
    this.plugin.registerEvent(this.plugin.app.vault.on("modify", file => {
      if (file instanceof TFile && file.extension === "canvas") this.schedule(file.path);
    }));
    this.plugin.registerEvent(this.plugin.app.vault.on("create", file => {
      if (file instanceof TFile && (file.extension === "md" || file.extension === "canvas")) this.scheduleAll();
    }));
    this.plugin.registerEvent(this.plugin.app.vault.on("delete", file => {
      if (file instanceof TFile && (file.extension === "md" || file.extension === "canvas")) this.scheduleAll();
    }));
    this.plugin.registerEvent(this.plugin.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
      this.remapPaths(oldPath, file.path);
      this.scheduleAll();
    }));
    this.plugin.app.workspace.onLayoutReady(() => this.scheduleAll());
  }

  private schedule(path: string) {
    const prior = this.timers.get(path);
    if (prior) window.clearTimeout(prior);
    this.timers.set(path, window.setTimeout(() => {
      this.timers.delete(path);
      this.enqueue(() => this.syncCanvas(path));
    }, this.plugin.setting.graphDebounceMs));
  }

  private scheduleAll() {
    const key = "*";
    const prior = this.timers.get(key);
    if (prior) window.clearTimeout(prior);
    this.timers.set(key, window.setTimeout(() => {
      this.timers.delete(key);
      this.enqueue(() => this.syncAll());
    }, this.plugin.setting.graphDebounceMs));
  }

  private enqueue(work: () => Promise<void>) {
    this.queue = this.queue.then(work).catch(error => console.error("[comsift] graph sync", error));
  }

  /** Point every stored relationship at `newPath` instead of `oldPath`. */
  remap(oldPath: string, newPath: string) { this.remapPaths(oldPath, newPath); }

  private remapPaths(oldPath: string, newPath: string) {
    const move = (path: string) => path === oldPath ? newPath
      : path.startsWith(oldPath + "/") ? newPath + path.slice(oldPath.length) : path;
    const rewritten: typeof this.plugin.state.graphSources = {};
    for (const [key, sources] of Object.entries(this.plugin.state.graphSources)) {
      const newKey = key.startsWith("canvas:") ? `canvas:${move(key.slice(7))}` : key;
      rewritten[newKey] = {};
      for (const [source, targets] of Object.entries(sources)) {
        rewritten[newKey][move(source)] = targets.map(move);
      }
    }
    this.plugin.state.graphSources = rewritten;
    this.plugin.state.graphManagedFiles = this.plugin.state.graphManagedFiles.map(move);
  }

  async syncAll() {
    if (this.running) { this.scheduleAll(); return; }
    this.running = true;
    try {
      const canvases = this.plugin.app.vault.getFiles().filter(file =>
        file.extension === "canvas" && this.plugin.investigations.forCanvasPath(file.path));
      const valid = new Set(canvases.map(file => `canvas:${file.path}`));
      for (const key of Object.keys(this.plugin.state.graphSources)) {
        if (key.startsWith("canvas:") && !valid.has(key)) delete this.plugin.state.graphSources[key];
      }
      for (const file of canvases) {
        this.plugin.state.graphSources[`canvas:${file.path}`] = await this.canvasRelationships(file);
      }
      await this.refreshAllInvestigationLinks();
      await this.refreshManagedLinks();
      await this.plugin.saveState();
    } finally { this.running = false; }
  }

  async syncCanvas(path: string) {
    const file = this.plugin.investigations.forCanvasPath(path)
      ? this.plugin.app.vault.getFileByPath(path) : null;
    this.plugin.state.graphSources[`canvas:${path}`] = file ? await this.canvasRelationships(file) : {};
    await this.refreshAllInvestigationLinks();
    await this.refreshManagedLinks();
    await this.plugin.saveState();
  }

  async addConfirmedLink(sourcePath: string, targetPath: string, id: string) {
    if (!this.plugin.app.vault.getFileByPath(sourcePath) || !this.plugin.app.vault.getFileByPath(targetPath)) throw new Error("Both notes must exist.");
    this.plugin.state.graphSources[`confirmed:${id}`] = { [sourcePath]: [targetPath] };
    await this.refreshManagedLinks();
    await this.plugin.saveState();
  }

  async removeConfirmedLink(id: string) {
    delete this.plugin.state.graphSources[`confirmed:${id}`];
    await this.refreshManagedLinks();
    await this.plugin.saveState();
  }

  /** Links between files on a Canvas, following arrows through text nodes; the main node is the person's note. */
  private async canvasRelationships(file: TFile): Promise<LinkMap> {
    const item = this.plugin.investigations.forCanvasPath(file.path);
    const primary = item ? this.plugin.investigations.mdPath(item) : null;
    const name = item?.folderPath.split("/").at(-1);
    const result: LinkMap = {};
    for (const link of canvasLinks(parseCanvas(await this.plugin.app.vault.cachedRead(file)), primary, name)) {
      const from = this.plugin.app.vault.getFileByPath(link.from);
      if (from?.extension !== "md" || !this.plugin.app.vault.getFileByPath(link.to)) continue;
      (result[link.from] ??= []).push(link.to);
    }
    return result;
  }

  async syncAllNow() {
    this.enqueue(() => this.syncAll());
    await this.queue;
    this.plugin.graphColors?.schedule(200);
  }

  /** Files the person's note links to: everything in the folder, plus (merged mode) everything on the Canvas. */
  private async investigationChildren(item: Investigation): Promise<string[]> {
    const primary = this.plugin.investigations.mdPath(item);
    const canvasPath = this.plugin.investigations.canvasPath(item);
    const children = this.plugin.app.vault.getFiles()
      .filter(file => file.path.startsWith(item.folderPath + "/") && file.path !== primary &&
        (file.extension === "md" || file.path === canvasPath))
      .map(file => file.path);
    if (this.plugin.setting.graphMergeCanvas) {
      const canvas = this.plugin.app.vault.getFileByPath(canvasPath);
      if (canvas) children.push(...canvasFiles(parseCanvas(await this.plugin.app.vault.cachedRead(canvas))).filter(path => path !== primary));
    }
    return [...new Set(children)];
  }

  async refreshInvestigation(item: Investigation) {
    const primary = this.plugin.investigations.mdPath(item);
    this.plugin.state.graphSources[`investigation:${item.id}`] = { [primary]: await this.investigationChildren(item) };
    await this.refreshManagedLinks();
    await this.plugin.saveState();
  }

  private async refreshAllInvestigationLinks() {
    for (const item of Object.values(this.plugin.state.investigations)) {
      const primary = this.plugin.investigations.mdPath(item);
      this.plugin.state.graphSources[`investigation:${item.id}`] = { [primary]: await this.investigationChildren(item) };
    }
  }

  private async refreshManagedLinks() {
    const links: LinkMap = {};
    for (const source of Object.values(this.plugin.state.graphSources)) {
      for (const [from, targets] of Object.entries(source)) {
        (links[from] ??= []).push(...targets);
      }
    }
    const paths = new Set([...Object.keys(links), ...this.plugin.state.graphManagedFiles]);
    const managed: string[] = [];
    for (const path of paths) {
      const file = this.plugin.app.vault.getFileByPath(path);
      if (!file || file.extension !== "md") continue;
      const targets = (links[file.path] ?? [])
        .filter(path => this.plugin.app.vault.getFileByPath(path) !== null)
        .map(path => path.endsWith(".md") ? path.slice(0, -3) : path);
      const prior = await this.plugin.app.vault.cachedRead(file);
      if (!targets.length && !hasManagedLinks(prior)) continue;
      const next = managedLinks(prior, targets);
      if (next !== prior) await this.plugin.app.vault.process(file, current => managedLinks(current, targets));
      if (targets.length) managed.push(file.path);
    }
    this.plugin.state.graphManagedFiles = managed;
  }
}
