import { Menu, Notice, TFile } from "obsidian";
import type ComsiftPlugin from "../main";
import { openCanvasAssistant } from "../analysis/canvasAssistant";
import { replaceLiveCanvas } from "./canvasLive";
import type { Investigation } from "./investigation";
import { arrowType, containsNode, fitGroup, flattenToolGroups, parseCanvas, persistArrowTypes, withArrowType, type ArrowType, type CanvasData, type CanvasEdge, type CanvasNode } from "./canvasModel";

import { missingCanvasDependencies, offerCanvasEmbed } from "./canvasEmbed";
import { uuid } from "../tool";
import type { CanvasEmbedSpec } from "./canvasEmbedModel";

const TYPE_LABELS: Record<ArrowType, string> = { normal: "Normal arrow", same: "Same person", related: "Related", uncertain: "Uncertain" };

/** Canvas helpers shared by arrow types, the analysis view and AI edits. */
export class CanvasService {
  constructor(private plugin: ComsiftPlugin) {}

  start() {
    const workspace = this.plugin.app.workspace as unknown as {
      on(name: "canvas:edge-menu", callback: (menu: Menu, edge: M.Edge) => void): import("obsidian").EventRef;
      on(name: "canvas:selection-menu", callback: (menu: Menu, canvas: M.Canvas) => void): import("obsidian").EventRef;
    };
    this.plugin.registerEvent(workspace.on("canvas:edge-menu", (menu, edge) => {
      this.addTypeItems(menu, () => this.edgesFor(edge));
      const canvas = (edge.canvas as M.Canvas | undefined) ?? this.plugin.canvas;
      if (canvas) this.addEmbedItem(menu, canvas, edge.id);
    }));
    this.plugin.registerEvent(workspace.on("canvas:selection-menu", (menu, canvas) => {
      this.addAssistantItem(menu, canvas);
      if (this.canAddToGroup(canvas)) menu.addItem(item => item.setTitle("Add nodes to group").setIcon("group").onClick(() => this.addSelectionToGroup(canvas)));
      this.addEmbedItem(menu, canvas);
      if (this.selectedEdges(canvas).length) this.addTypeItems(menu, () => this.selectedEdges(canvas));
    }));
    for (const type of ["normal", "same", "related", "uncertain"] as const) {
      this.plugin.addCommand({
        id: `arrow-type-${type}`,
        name: `Set selected arrows to: ${TYPE_LABELS[type].toLowerCase()}`,
        checkCallback: checking => {
          const canvas = this.plugin.canvas;
          const edges = canvas ? this.selectedEdges(canvas) : [];
          if (!edges.length) return false;
          if (!checking) this.setTypes(edges, type);
          return true;
        },
      });
    }
    this.plugin.app.workspace.onLayoutReady(() => {
      void this.flattenAll().catch(error => console.error("[comsift] canvas cleanup failed", error));
    });
  }

  personFor(canvasPath: string | undefined): { name: string; item: Investigation | null } {
    const item = canvasPath ? this.plugin.investigations.forPath(canvasPath) : null;
    return { item, name: item?.folderPath.split("/").at(-1) ?? "same person" };
  }

  colorsFor(item: Investigation | null): { same: string; related: string; uncertain: string } {
    return {
      same: item ? this.plugin.graphColors.colorOf(item) : "1",
      related: this.plugin.setting.relatedArrowColor,
      uncertain: this.plugin.setting.uncertainArrowColor,
    };
  }

  /** The live Canvas view showing `path`, if open. */
  liveCanvas(path: string): M.Canvas | null {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType("canvas")) {
      const view = leaf.view as unknown as { file?: TFile; canvas?: M.Canvas };
      if (view.file?.path === path && view.canvas) return view.canvas;
    }
    return null;
  }

  async read(path: string): Promise<CanvasData> {
    const live = this.liveCanvas(path);
    if (live) return live.getData() as unknown as CanvasData;
    const file = this.plugin.app.vault.getFileByPath(path);
    if (!file) throw new Error(`Canvas not found: ${path}`);
    return parseCanvas(await this.plugin.app.vault.read(file));
  }

  /** Change a Canvas through the open view when there is one (so it is not overwritten), else on disk. */
  async mutate(path: string, change: (data: CanvasData) => CanvasData): Promise<void> {
    const live = this.liveCanvas(path);
    if (live) {
      replaceLiveCanvas(live, change(live.getData() as unknown as CanvasData));
      return;
    }
    const file = this.plugin.app.vault.getFileByPath(path);
    if (!file) throw new Error(`Canvas not found: ${path}`);
    await this.plugin.app.vault.process(file, text => JSON.stringify(change(parseCanvas(text)), null, "\t"));
  }

  private canvasPath(canvas: M.Canvas): string | undefined {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType("canvas")) {
      const view = leaf.view as unknown as { file?: TFile; canvas?: M.Canvas };
      if (view.canvas === canvas) return view.file?.path;
    }
    return this.plugin.getActiveCanvasFile()?.path;
  }

  /** Capture node IDs before opening a sidebar can change the active leaf/selection. */
  addAssistantItem(menu: Menu, canvas: M.Canvas, clickedId?: string) {
    const path = this.canvasPath(canvas);
    if (!path) return;
    const data = canvas.getData();
    const nodes = new Set(data.nodes.map(node => node.id));
    let ids = [...canvas.selection].map(node => node.id).filter(id => nodes.has(id));
    if (clickedId && nodes.has(clickedId) && !ids.includes(clickedId)) ids = [clickedId];
    if (!ids.length) return;
    const selectedIds = [...ids];
    menu.addItem(item => item.setTitle(`Chat about selected node${ids.length === 1 ? "" : "s"}`)
      .setIcon("messages-square").setSection("comsift").onClick(() => {
        void openCanvasAssistant(this.plugin, path, canvas, { selectedIds, onlySelected: true });
      }));
  }

  private embedSpec(canvas: M.Canvas, clickedId?: string): CanvasEmbedSpec | null {
    const path = this.canvasPath(canvas);
    if (!path) return null;
    const data = canvas.getData();
    const selected = new Set([...canvas.selection].map(item => item.id));
    if (clickedId && !selected.has(clickedId)) { selected.clear(); selected.add(clickedId); }
    const nodes = data.nodes.filter(node => selected.has(node.id)).map(node => node.id);
    const edges = data.edges.filter(edge => selected.has(edge.id)).map(edge => edge.id);
    if (!nodes.length && !edges.length) return null;
    // A node-only selection includes its internal connections. Explicit arrow selections stay exact.
    return { path, nodes, ...(edges.length ? { edges } : {}) };
  }

  addEmbedItem(menu: Menu, canvas: M.Canvas, clickedId?: string) {
    const spec = this.embedSpec(canvas, clickedId);
    if (!spec) return;
    menu.addItem(item => item.setTitle("Embed selection in note").setIcon("file-input").setSection("comsift")
      .onClick(() => this.embedSelection(canvas, clickedId)));
  }

  embedSelection(canvas: M.Canvas, clickedId?: string) {
    const missing = missingCanvasDependencies(this.plugin);
    if (missing.length) { new Notice(`Enable required plugins: ${missing.join(", ")}.`); return; }
    const spec = this.embedSpec(canvas, clickedId);
    if (!spec) return;
    if (spec.nodes.length === 1 && !spec.edges?.length) { offerCanvasEmbed(this.plugin, spec); return; }
    // BEC embeds one card/group, not arbitrary arrow IDs. A native group preserves the live region.
    const data = canvas.getData() as unknown as CanvasData;
    const ids = new Set(spec.nodes);
    for (const edge of data.edges) if (spec.edges?.includes(edge.id)) { ids.add(edge.fromNode); ids.add(edge.toNode); }
    const members = data.nodes.filter(node => ids.has(node.id));
    if (!members.length) return;
    const group: CanvasNode = { id: uuid(), type: "group", label: "Embedded selection", x: 0, y: 0, width: 100, height: 100 };
    fitGroup(group, members);
    replaceLiveCanvas(canvas, { ...data, nodes: [group, ...data.nodes] });
    offerCanvasEmbed(this.plugin, { path: spec.path, nodes: [group.id] });
  }

  canAddToGroup(canvas: M.Canvas): boolean {
    const ids = new Set([...canvas.selection].map(item => item.id));
    const selected = canvas.getData().nodes.filter(node => ids.has(node.id));
    return selected.filter(node => node.type === "group").length === 1 && selected.some(node => node.type !== "group");
  }

  addSelectionToGroup(canvas: M.Canvas) {
    if (!this.canAddToGroup(canvas)) return;
    const data = canvas.getData() as unknown as CanvasData;
    const ids = new Set([...canvas.selection].map(item => item.id));
    const group = data.nodes.find(node => ids.has(node.id) && node.type === "group")!;
    const members = data.nodes.filter(node => node.id !== group.id && (ids.has(node.id) || containsNode(group, node)));
    const updated = { ...group }; fitGroup(updated, members);
    replaceLiveCanvas(canvas, { ...data, nodes: data.nodes.map(node => node.id === group.id ? updated : node) });
  }

  private selectedEdges(canvas: M.Canvas): Array<{ canvas: M.Canvas; id: string }> {
    const out: Array<{ canvas: M.Canvas; id: string }> = [];
    for (const item of canvas.selection as Set<unknown>) {
      const edge = item as Partial<M.Edge>;
      if (edge && edge.from && edge.to && typeof edge.id === "string") out.push({ canvas, id: edge.id });
    }
    return out;
  }

  /** The clicked arrow, plus every other selected arrow so multi-selections change together. */
  private edgesFor(edge: M.Edge): Array<{ canvas: M.Canvas; id: string }> {
    const canvas = (edge.canvas as M.Canvas | undefined) ?? this.plugin.canvas;
    if (!canvas) return [];
    const selected = this.selectedEdges(canvas);
    return selected.some(entry => entry.id === edge.id) ? selected : [{ canvas, id: edge.id }];
  }

  private addTypeItems(menu: Menu, targets: () => Array<{ canvas: M.Canvas; id: string }>) {
    const list = targets();
    if (!list.length) return;
    const path = this.canvasPath(list[0].canvas);
    const { name } = this.personFor(path);
    const data = list[0].canvas.getData() as unknown as CanvasData;
    const current = new Set(list.map(entry => {
      const edge = data.edges.find(candidate => candidate.id === entry.id);
      return edge ? arrowType(edge, name) : "normal";
    }));
    const suffix = list.length > 1 ? ` (${list.length} arrows)` : "";
    for (const type of ["normal", "same", "related", "uncertain"] as const) {
      const title = type === "same" ? `Arrow: ${name}${suffix}` : `Arrow: ${TYPE_LABELS[type].toLowerCase()}${suffix}`;
      menu.addItem(item => item.setTitle(title).setIcon(type === "normal" ? "arrow-right" : type === "same" ? "user-check" : type === "related" ? "users" : "help-circle")
        .setChecked(current.size === 1 && current.has(type)).setSection("comsift").onClick(() => this.setTypes(list, type)));
    }
  }

  setTypes(targets: Array<{ canvas: M.Canvas; id: string }>, type: ArrowType) {
    const canvas = targets[0]?.canvas;
    if (!canvas) return;
    const path = this.canvasPath(canvas);
    const { name, item } = this.personFor(path);
    const ids = new Set(targets.map(target => target.id));
    const data = canvas.getData() as unknown as CanvasData;
    replaceLiveCanvas(canvas, { ...data, edges: data.edges.map(edge => ids.has(edge.id) ? withArrowType(edge, type, name, this.colorsFor(item)) : edge) });
    this.plugin.graphColors?.schedule(800);
  }

  /** Typed edge for a newly created child node. */
  typedEdge(edge: CanvasEdge, type: ArrowType, canvasPath: string | undefined): CanvasEdge {
    if (type === "normal") return edge;
    const { name, item } = this.personFor(canvasPath);
    return withArrowType(edge, type, name, this.colorsFor(item));
  }

  /** Remove legacy "Sherlock"/"Maigret" group nodes from every person's Canvas. */
  async flattenAll() {
    let total = 0;
    for (const item of Object.values(this.plugin.state.investigations)) {
      const path = this.plugin.investigations.canvasPath(item);
      if (!this.plugin.app.vault.getFileByPath(path)) continue;
      const before = await this.read(path);
      const { removed } = flattenToolGroups(before);
      const name = item.folderPath.split("/").at(-1) ?? "same person";
      const legacyTypes = before.edges.some(edge => edge.comsift_type === undefined && arrowType(edge, name) !== "normal");
      if (!removed.length && !legacyTypes) continue;
      await this.mutate(path, data => persistArrowTypes(flattenToolGroups(data).data, name));
      for (const bucket of [this.plugin.state.sherlockChildren, this.plugin.state.maigretChildren]) {
        for (const [source, entry] of Object.entries(bucket[path] ?? {})) {
          if (removed.includes(entry.rootId)) entry.rootId = source;
        }
      }
      total += removed.length;
    }
    if (total) {
      await this.plugin.saveState();
    }
  }
}
