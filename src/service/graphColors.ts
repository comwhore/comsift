import { normalizePath, type TFile, type WorkspaceLeaf } from "obsidian";
import type ComsiftPlugin from "../main";
import type { Investigation } from "./investigation";
import { randomColor, rgbToInt, tagSlug } from "./colors";
import { CLEW_GROUP_PREFIX, clewGroups, computeColors, primaryWeights, linkColor, type ClewGroup, type ColorOptions, type ColorPerson, type NoteColor } from "./graphColoring";
import { canvasLinks, parseCanvas } from "./canvasModel";
import { markLinkTarget, readMarks, type SetMarkType } from "./personMarks";
import { connectionScores, ownership } from "./fileOwners";
import { ownerSnapshot, PROFILE_PROPERTIES } from "./graph";
import { reviewRelations } from "./reviewRelations";

interface GraphColorGroup { query: string; color: { a: number; rgb: number } }
interface GraphConfig { colorGroups?: GraphColorGroup[]; search?: string; [key: string]: unknown }

/** Graph View renderer internals (undocumented; every access is feature-checked). */
interface RendererNode { id?: string; weight?: number; x?: number; y?: number }
interface RendererLink { source?: RendererNode; target?: RendererNode; line?: { tint?: number }; px?: { tint?: number } }
interface GraphRenderer { nodes?: RendererNode[]; links?: RendererLink[]; renderCallback?: () => void; changed?: () => void; comsiftWrapped?: boolean; setPan?: (x: number, y: number) => void }
interface GraphViewInternals { renderer?: GraphRenderer; dataEngine?: { setOptions?: (options: unknown) => void } }

const GRAPH_VIEW_TYPES = ["graph", "localgraph"];
const CLEW_VIEW_TYPE = "clew-standalone-graph";

/** Clew plugin internals (optional plugin; every access is feature-checked). */
interface ClewPlugin { settings?: { nodeGroups?: unknown }; saveSettings?: () => Promise<void> }
interface ClewPane { applyFocus?: (file: TFile, hops: number, options: { highlightCenter: boolean; fitCamera: boolean }) => void; repaintNodeGroups?: () => void; refreshTheme?: () => void }

export class GraphColorService {
  private timer: number | null = null;
  private notes = new Map<string, NoteColor>();
  private tints = new Map<string, number>();
  /** Main note path → link count it stands for in Graph View. */
  private weights = new Map<string, number>();

  constructor(private plugin: ComsiftPlugin) {}

  start() {
    const { app } = this.plugin;
    this.plugin.registerEvent(app.metadataCache.on("resolved", () => this.schedule()));
    this.plugin.registerEvent(app.vault.on("rename", () => this.schedule()));
    this.plugin.registerEvent(app.vault.on("delete", () => this.schedule()));
    this.plugin.registerEvent(app.workspace.on("layout-change", () => this.hookGraphViews()));
    app.workspace.onLayoutReady(() => this.schedule(500));
  }

  colorOf(item: Investigation): string {
    return item.color && /^#[0-9a-f]{6}$/i.test(item.color) ? item.color : "#7f6df2";
  }

  /** Focus an existing Clew/core graph, or open a local graph centered on this note. */
  async focus(file: TFile): Promise<void> {
    const workspace = this.plugin.app.workspace;
    for (const leaf of workspace.getLeavesOfType(CLEW_VIEW_TYPE)) {
      const pane = (leaf.view as unknown as { pane?: ClewPane }).pane;
      if (!pane?.applyFocus) continue;
      try {
        pane.applyFocus(file, 1, { highlightCenter: true, fitCamera: true });
        await workspace.revealLeaf(leaf);
        return;
      } catch { /* Fall through if an optional plugin changed its API. */ }
    }
    for (const leaf of this.graphLeaves()) {
      const renderer = (leaf.view as unknown as GraphViewInternals).renderer;
      const node = renderer?.nodes?.find(node => node.id === file.path);
      if (!renderer?.setPan || typeof node?.x !== "number" || typeof node.y !== "number") continue;
      renderer.setPan(-node.x, -node.y);
      renderer.changed?.();
      await workspace.revealLeaf(leaf);
      return;
    }
    const leaf = workspace.getLeaf("tab");
    await leaf.setViewState({ type: "localgraph", state: { file: file.path }, active: true });
    await workspace.revealLeaf(leaf);
  }

  /** Graph View color computed for a note on the last apply. */
  noteColor(path: string): string | undefined { return this.notes.get(path)?.color; }

  tagOf(item: Investigation): string {
    const prefix = this.plugin.setting.graphTagPrefix.replace(/^#/, "").replace(/\/+$/, "").trim() || "comsift";
    return `${prefix}/${tagSlug(item.folderPath.split("/").at(-1) ?? item.folderPath)}`;
  }

  schedule(delay = 1500) {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.apply(false).catch(error => console.error("[comsift] graph colors failed", error));
    }, delay);
  }

  private options(): ColorOptions {
    const s = this.plugin.setting;
    return { depth: s.graphDepth, fade: s.graphFade, bridgeMode: s.graphBridgeMode,
      bridgeColor: s.graphBridgeColor, personaMix: Math.min(1, Math.max(0, s.graphPersonaMix)),
      importance: Number.isFinite(s.graphImportance) ? Math.max(0.1, s.graphImportance) : 1 };
  }

  /** Give every person a color once; returns true if state changed. */
  private ensureColors(): boolean {
    let changed = false;
    for (const item of Object.values(this.plugin.state.investigations)) {
      if (item.color && /^#[0-9a-f]{6}$/i.test(item.color)) continue;
      item.color = randomColor();
      changed = true;
    }
    return changed;
  }

  async apply(force: boolean) {
    if (this.ensureColors()) await this.plugin.saveState();
    const people = Object.values(this.plugin.state.investigations);
    // Person tags are applied on load, creation and migration even when coloring is off.
    await this.syncTags(people);
    if (!this.plugin.setting.graphColors) {
      await this.writeGroups([]);
      await this.writeClewGroups([]);
      this.notes.clear();
      this.tints.clear();
      return;
    }
    const { vault, metadataCache } = this.plugin.app;
    const paths = vault.getFiles().filter(file => file.extension === "md" || file.extension === "canvas").map(file => file.path);
    const edges: Array<[string, string]> = [];
    for (const [source, targets] of Object.entries(metadataCache.resolvedLinks)) {
      for (const target of Object.keys(targets)) edges.push([source, target]);
    }
    const colorPeople: ColorPerson[] = people.map(item => ({ id: item.id, folder: item.folderPath, color: this.colorOf(item), tag: this.tagOf(item),
      primary: this.plugin.investigations.mdPath(item), canvas: this.plugin.investigations.canvasPath(item) }));
    // Typed Canvas arrows: "same person" joins identities (computeColors follows them transitively from the
    // person's note); related and uncertain arrows are links, one step away.
    const samePersonEdges: Array<[string, string]> = [];
    const relatedEdges: Array<[string, string]> = [];
    for (const item of people) {
      const canvas = vault.getFileByPath(this.plugin.investigations.canvasPath(item));
      if (!canvas) continue;
      const primary = this.plugin.investigations.mdPath(item);
      const name = item.folderPath.split("/").at(-1);
      try {
        for (const link of canvasLinks(parseCanvas(await vault.cachedRead(canvas)), primary, name)) {
          if (link.type === "same") samePersonEdges.push([link.from, link.to]);
          else if (link.type === "related" || link.type === "uncertain") {
            edges.push([link.from, link.to]);
            if (link.type === "related") relatedEdges.push([link.from, link.to]);
          }
        }
      } catch { /* unreadable Canvas: plain links only */ }
    }
    // Marks in notes' frontmatter count like typed Canvas arrows.
    for (const mark of this.noteMarks()) {
      if (mark.type === "same") samePersonEdges.push([mark.note, mark.target]);
      else {
        edges.push([mark.note, mark.target]);
        if (mark.type === "related") relatedEdges.push([mark.note, mark.target]);
      }
    }
    for (const review of await reviewRelations(this.plugin)) {
      edges.push([review.source, review.target]);
      if (review.type === "same") samePersonEdges.push([review.source, review.target]);
      if (review.type === "related") relatedEdges.push([review.source, review.target]);
    }
    // Connection scores (fileOwners.ts) single out well-connected profiles among the lone friend-list rows.
    const snapshot = ownerSnapshot(this.plugin);
    const scores = new Map([...connectionScores(snapshot.notes, ownership(snapshot.notes, snapshot.people))].map(([path, score]) => [path, score.score]));
    const { notes, groups } = computeColors(colorPeople, paths, edges, this.options(), [], samePersonEdges, this.profilePaths(), scores, relatedEdges);
    this.weights.clear();
    if (this.plugin.setting.graphPrimarySize) {
      for (const [path, weight] of primaryWeights(colorPeople, notes, edges)) {
        this.weights.set(path, weight.links);
        const note = notes.get(path);
        if (note && weight.size > 1) note.size = weight.size;
      }
    }
    this.notes = notes;
    this.tints.clear();
    await this.writeGroups(groups.map(group => ({ query: group.query, color: { a: 1, rgb: rgbToInt(group.color) } })), force);
    await this.writeClewGroups(this.plugin.setting.graphClewColors
      ? clewGroups(colorPeople.map((person, index) => ({ ...person, name: people[index].folderPath.split("/").at(-1) ?? person.folder })), notes) : []);
    this.hookGraphViews();
  }

  /**
   * Relationship marks (`comsift_same` / `comsift_related` / `comsift_uncertain` links in a note's frontmatter,
   * see personMarks.ts), resolved to the marked target note: a person's primary note or any other note.
   */
  noteMarks(): Array<{ note: string; target: string; type: SetMarkType }> {
    const { vault, metadataCache } = this.plugin.app;
    const out: Array<{ note: string; target: string; type: SetMarkType }> = [];
    for (const file of vault.getMarkdownFiles()) {
      const frontmatter = metadataCache.getFileCache(file)?.frontmatter;
      if (!frontmatter) continue;
      for (const { type, value } of readMarks(frontmatter)) {
        const dest = metadataCache.getFirstLinkpathDest(markLinkTarget(value)!, file.path);
        if (dest && dest.path !== file.path) out.push({ note: file.path, target: dest.path, type });
      }
    }
    return out;
  }

  /** Real connection profile notes: identified by their stored profile properties, not by folder. */
  private profilePaths(): string[] {
    const { vault, metadataCache } = this.plugin.app;
    return vault.getMarkdownFiles().filter(file => {
      const frontmatter = metadataCache.getFileCache(file)?.frontmatter;
      return !!frontmatter && PROFILE_PROPERTIES.some(key => frontmatter[key] !== undefined && frontmatter[key] !== null);
    }).map(file => file.path);
  }

  /** Add the person tag to every Markdown note in their folder; drop stale tags with the same prefix. */
  private async syncTags(people: Investigation[]) {
    const { vault, metadataCache, fileManager } = this.plugin.app;
    const prefix = this.plugin.setting.graphTagPrefix.replace(/^#/, "").replace(/\/+$/, "").trim() || "comsift";
    for (const item of people) {
      const tag = this.tagOf(item);
      const files = vault.getMarkdownFiles().filter(file => file.path.startsWith(item.folderPath + "/") &&
        !file.path.startsWith(`${item.folderPath}/Chats/`) && !/\.sheet\.md$/i.test(file.path));
      for (const file of files) {
        const raw: unknown = metadataCache.getFileCache(file)?.frontmatter?.tags;
        const tags = (Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,\s]+/) : [])
          .filter((value): value is string => typeof value === "string").map(value => value.replace(/^#/, ""));
        const stale = tags.filter(value => value.startsWith(prefix + "/") && value !== tag);
        if (tags.includes(tag) && !stale.length) continue;
        await fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
          const current: unknown = frontmatter.tags;
          const list = (Array.isArray(current) ? current : typeof current === "string" ? current.split(/[,\s]+/) : [])
            .filter((value): value is string => typeof value === "string" && !!value)
            .map(value => value.replace(/^#/, ""))
            .filter(value => !value.startsWith(prefix + "/") || value === tag);
          if (!list.includes(tag)) list.push(tag);
          frontmatter.tags = list;
        });
      }
    }
  }

  private graphConfigPath(): string { return normalizePath(`${this.plugin.app.vault.configDir}/graph.json`); }

  /** Replace the color groups this plugin wrote earlier; groups the user made stay first and win. */
  private async writeGroups(groups: GraphColorGroup[], force = false) {
    const adapter = this.plugin.app.vault.adapter;
    const path = this.graphConfigPath();
    let config: GraphConfig = {};
    if (await adapter.exists(path)) {
      try { config = JSON.parse(await adapter.read(path)) as GraphConfig; } catch { config = {}; }
    }
    const managed = new Set(this.plugin.state.graphColorQueries ?? []);
    const own = (config.colorGroups ?? []).filter(group => !managed.has(group.query));
    const next = [...own, ...groups];
    const search = this.mergedSearch(typeof config.search === "string" ? config.search : "");
    const searchChanged = search !== (config.search ?? "");
    if (searchChanged) await this.plugin.saveState();
    config.search = search;
    const before = JSON.stringify(config.colorGroups ?? []);
    const after = JSON.stringify(next);
    const queries = groups.map(group => group.query);
    if (JSON.stringify(queries) !== JSON.stringify(this.plugin.state.graphColorQueries ?? [])) {
      this.plugin.state.graphColorQueries = queries;
      await this.plugin.saveState();
    }
    if (before === after && !searchChanged && !force) return;
    config.colorGroups = next;
    await adapter.write(path, JSON.stringify(config, null, 2));
    for (const leaf of this.graphLeaves()) {
      const view = leaf.view as unknown as GraphViewInternals;
      try { view.dataEngine?.setOptions?.({ colorGroups: next, search }); } catch { /* applies when the graph is reopened */ }
    }
  }

  /**
   * Graph search with this plugin's `-path:"…canvas"` filters replaced: in merged mode each person's
   * Canvas is hidden so the note stands for both. Filters typed by the user are kept as they are.
   */
  private mergedSearch(current: string): string {
    const managed = new Set(this.plugin.state.graphSearchTokens ?? []);
    const own = current.split(/\s+(?=-?path:)/).map(part => part.trim()).filter(part => part && !managed.has(part));
    const tokens = this.plugin.setting.graphMergeCanvas
      ? Object.values(this.plugin.state.investigations).map(item => `-path:"${this.plugin.investigations.canvasPath(item).replace(/"/g, '\\"')}"`)
      : [];
    this.plugin.state.graphSearchTokens = tokens;
    return [...own, ...tokens].join(" ");
  }

  /** Replace Comsift's groups in Clew's Color & size list; the user's own groups stay first so they win. */
  private async writeClewGroups(groups: ClewGroup[]) {
    const internal = this.plugin.app as unknown as { plugins?: { getPlugin?: (id: string) => unknown } };
    const clew = internal.plugins?.getPlugin?.("clew") as ClewPlugin | null | undefined;
    const settings = clew?.settings;
    if (!settings || !Array.isArray(settings.nodeGroups)) return;
    const current = settings.nodeGroups as Array<{ id?: unknown }>;
    const own = current.filter(group => !(typeof group?.id === "string" && group.id.startsWith(CLEW_GROUP_PREFIX)));
    const next = [...own, ...groups];
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    settings.nodeGroups = next;
    try { await clew?.saveSettings?.(); } catch (error) { console.error("[comsift] saving Clew groups failed", error); }
    for (const leaf of this.plugin.app.workspace.getLeavesOfType(CLEW_VIEW_TYPE)) {
      const pane = (leaf.view as unknown as { pane?: ClewPane }).pane;
      try { if (pane?.repaintNodeGroups) pane.repaintNodeGroups(); else pane?.refreshTheme?.(); } catch { /* applies when Clew is reopened */ }
    }
  }

  private graphLeaves(): WorkspaceLeaf[] {
    return GRAPH_VIEW_TYPES.flatMap(type => this.plugin.app.workspace.getLeavesOfType(type));
  }

  /** Wrap each open graph renderer's frame callback so link lines get person colors (best effort). */
  private hookGraphViews() {
    for (const leaf of this.graphLeaves()) {
      const renderer = (leaf.view as unknown as GraphViewInternals).renderer;
      if (!renderer || renderer.comsiftWrapped || typeof renderer.renderCallback !== "function") continue;
      const original = renderer.renderCallback.bind(renderer);
      renderer.comsiftWrapped = true;
      renderer.renderCallback = () => {
        original();
        try { this.tintLinks(renderer); this.weighNodes(renderer); } catch { /* renderer internals changed; leave defaults */ }
      };
      this.plugin.register(() => {
        renderer.renderCallback = original;
        renderer.comsiftWrapped = false;
      });
    }
  }

  /** Graph View sizes nodes by `weight` (link count); main notes get the links of everything that is theirs. */
  private weighNodes(renderer: GraphRenderer) {
    if (!this.plugin.setting.graphColors || !this.weights.size || !renderer.nodes) return;
    for (const node of renderer.nodes) {
      const weight = node.id ? this.weights.get(node.id) : undefined;
      if (weight !== undefined && typeof node.weight === "number" && node.weight < weight) node.weight = weight;
    }
  }

  private tintLinks(renderer: GraphRenderer) {
    if (!this.plugin.setting.graphColors || !this.plugin.setting.graphColorLinks || !renderer.links) return;
    const options = this.options();
    for (const link of renderer.links) {
      const from = link.source?.id;
      const to = link.target?.id;
      if (!from || !to) continue;
      const key = `${from}\n${to}`;
      let tint = this.tints.get(key);
      if (tint === undefined) {
        const color = linkColor(this.notes.get(from), this.notes.get(to), options);
        tint = color ? rgbToInt(color) : -1;
        this.tints.set(key, tint);
      }
      if (tint < 0) continue;
      const graphic = link.line ?? link.px;
      if (graphic && graphic.tint !== tint) graphic.tint = tint;
    }
  }
}
