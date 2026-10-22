import { TAbstractFile, TFile } from "obsidian";
import ComsiftPlugin from "../main";
import type { Investigation } from "./investigation";
import { hasManagedLinks, managedLinks, type LinkMap } from "./graphLogic";
import { canvasFiles, canvasLinks, parseCanvas } from "./canvasModel";
import { ownership, type OwnerNote, type OwnerPerson, type Ownership } from "./fileOwners";
import { markLinkTarget } from "./personMarks";

/** Frontmatter written on connection profile notes (profileIdentity.ts). */
export const PROFILE_PROPERTIES = ["comsift_profile_data", "comsift_records", "comsift_record", "comsift_accounts", "comsift_account"];
/** Generated link lists: provenance (`comsift_sources`) and managed links are not evidence of a connection. */
const GENERATED_KEY = /^(?:comsift_sources|comsift_links|tags|aliases)(?:\.|$)/;
/** graphSources key of the owner links (owner → exported file, row profile → owner). */
export const OWNER_SOURCE = "owners";
const OWNER_MIGRATION = "1";

const asList = (value: unknown): string[] => (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === "string" && !!item.trim());

/**
 * Vault snapshot for owner detection and connection scores: profiles, the people's notes and every other
 * Markdown/CSV file, with the links the user (or a Canvas arrow) made — never generated link lists.
 */
export function ownerSnapshot(plugin: ComsiftPlugin): { notes: OwnerNote[]; people: OwnerPerson[] } {
  const { vault, metadataCache } = plugin.app;
  const items = Object.values(plugin.state.investigations);
  const people = items.map(item => ({ folder: item.folderPath, primary: plugin.investigations.mdPath(item) }));
  const primaries = new Map(items.map(item => [plugin.investigations.mdPath(item), item]));
  const canvasArrows = new Map<string, string[]>();
  for (const [key, source] of Object.entries(plugin.state.graphSources)) {
    if (!key.startsWith("canvas:") && !key.startsWith("confirmed:")) continue;
    for (const [from, targets] of Object.entries(source)) canvasArrows.set(from, [...(canvasArrows.get(from) ?? []), ...targets]);
  }
  const notes: OwnerNote[] = [];
  for (const file of vault.getFiles()) {
    if (file.extension === "csv") { notes.push({ path: file.path, kind: "file", accounts: [], sources: [], links: [] }); continue; }
    if (file.extension !== "md") continue;
    const cache = metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter;
    const resolve = (link: string) => metadataCache.getFirstLinkpathDest(link.split("#")[0].split("|")[0], file.path)?.path ?? null;
    const links = new Set<string>();
    for (const ref of [...(cache?.links ?? []), ...(cache?.embeds ?? [])]) { const dest = resolve(ref.link); if (dest) links.add(dest); }
    const sources = new Set<string>();
    for (const ref of cache?.frontmatterLinks ?? []) {
      const dest = resolve(ref.link);
      if (!dest) continue;
      if (/^comsift_sources(?:\.|$)/.test(ref.key)) sources.add(dest);
      else if (!GENERATED_KEY.test(ref.key)) links.add(dest);
    }
    for (const target of canvasArrows.get(file.path) ?? []) links.add(target);
    links.delete(file.path);
    const primary = primaries.get(file.path);
    const profile = !!frontmatter && PROFILE_PROPERTIES.some(key => frontmatter[key] !== undefined && frontmatter[key] !== null);
    const accounts = asList(frontmatter?.comsift_accounts).concat(asList(frontmatter?.comsift_account)).map(value => value.trim().toLowerCase());
    if (primary) accounts.push(...asList(frontmatter?.aliases).map(alias => `*|${alias.trim().toLowerCase()}`));
    const ownerLink = asList(frontmatter?.comsift_owner).map(value => markLinkTarget(value) ?? value.trim())[0];
    notes.push({ path: file.path, kind: primary ? "primary" : profile ? "profile" : "file", accounts: [...new Set(accounts)],
      sources: [...sources], links: [...links], owner: ownerLink ? resolve(ownerLink) : null });
  }
  return { notes, people };
}

export class GraphService {
  private timers = new Map<string, number>();
  private lastOwners: Ownership | null = null;
  private running = false;
  private queue: Promise<void> = Promise.resolve();
  constructor(private plugin: ComsiftPlugin) {}

  start() {
    this.plugin.registerEvent(this.plugin.app.vault.on("modify", file => {
      if (file instanceof TFile && file.extension === "canvas") this.schedule(file.path);
    }));
    // A sheet renamed/overridden (`comsift_owner`) or a note linked to an owned file changes who owns what.
    this.plugin.registerEvent(this.plugin.app.metadataCache.on("changed", file => {
      const frontmatter = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
      if (/\.sheet\.md$/i.test(file.path) || frontmatter?.comsift_owner !== undefined || this.lastOwners?.owners.has(file.path)) this.scheduleAll();
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
        const mapped = move(source);
        rewritten[newKey][mapped] = [...new Set([...(rewritten[newKey][mapped] ?? []), ...targets.map(move)])];
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
    if (sourcePath === targetPath) delete this.plugin.state.graphSources[`confirmed:${id}`];
    else this.plugin.state.graphSources[`confirmed:${id}`] = { [sourcePath]: [targetPath] };
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

  /** Owner links (see fileOwners.ts) and the files/rows the person's note should no longer link to. */
  ownership(): Ownership {
    const { notes, people } = ownerSnapshot(this.plugin);
    return ownership(notes, people);
  }

  private async refreshManagedLinks() {
    const owned = this.ownership();
    this.lastOwners = owned;
    this.plugin.state.graphSources[OWNER_SOURCE] = owned.links;
    const links: LinkMap = {};
    for (const [key, source] of Object.entries(this.plugin.state.graphSources)) {
      for (const [from, targets] of Object.entries(source)) {
        // The person's note links to its folder, except files and rows that belong to an owner profile.
        (links[from] ??= []).push(...(key.startsWith("investigation:") ? targets.filter(target => !owned.detached.has(target)) : targets));
      }
    }
    if (this.plugin.state.graphOwnerMigration !== OWNER_MIGRATION) {
      await this.backupBeforeOwnerLinks(links);
      this.plugin.state.graphOwnerMigration = OWNER_MIGRATION;
    }
    const paths = new Set([...Object.keys(links), ...this.plugin.state.graphManagedFiles]);
    const managed: string[] = [];
    for (const path of paths) {
      const file = this.plugin.app.vault.getFileByPath(path);
      if (!file || file.extension !== "md") continue;
      const targets = (links[file.path] ?? [])
        .filter(path => path !== file.path && this.plugin.app.vault.getFileByPath(path) !== null)
        .map(path => path.endsWith(".md") ? path.slice(0, -3) : path);
      const prior = await this.plugin.app.vault.cachedRead(file);
      if (!targets.length && !hasManagedLinks(prior)) continue;
      const next = managedLinks(prior, targets);
      if (next !== prior) await this.plugin.app.vault.process(file, current => managedLinks(current, targets));
      if (targets.length) managed.push(file.path);
    }
    this.plugin.state.graphManagedFiles = managed;
  }

  /** First run with owner links: back up every note whose managed links change (profile-backups folder). */
  private async backupBeforeOwnerLinks(links: LinkMap) {
    const { vault } = this.plugin.app;
    const paths = new Set([...Object.keys(links), ...this.plugin.state.graphManagedFiles]);
    const changed: Array<{ path: string; content: string }> = [];
    for (const path of paths) {
      const file = vault.getFileByPath(path);
      if (!file || file.extension !== "md") continue;
      const prior = await vault.cachedRead(file);
      const targets = (links[path] ?? []).filter(target => target !== path && vault.getFileByPath(target) !== null)
        .map(target => target.endsWith(".md") ? target.slice(0, -3) : target);
      if (!targets.length && !hasManagedLinks(prior)) continue;
      if (managedLinks(prior, targets) !== prior) changed.push({ path, content: prior });
    }
    if (!changed.length) return;
    const folder = `${vault.configDir}/plugins/${this.plugin.manifest.id}/profile-backups/${Date.now()}-owner-links`;
    for (const part of folder.split("/").map((_, index, all) => all.slice(0, index + 1).join("/"))) {
      if (!(await vault.adapter.exists(part))) await vault.adapter.mkdir(part);
    }
    await vault.adapter.write(`${folder}/notes.json`, JSON.stringify(changed));
  }
}
