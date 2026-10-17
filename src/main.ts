import { addCanvasAssistantButton, CANVAS_ASSISTANT_VIEW, CanvasAssistant } from "./analysis/canvasAssistant";
import { App, EventRef, Menu, Notice, Plugin, PluginManifest, TFile, setIcon } from "obsidian";
import { mountEmbeddedExcel } from "./excelEmbedded";
import { Keymap, Layout, Node, View, ComsiftSettingTab, DEFAULT_SETTINGS, ComsiftSettings } from "./module";
import { MaigretService, SherlockService, InvestigationService, GraphService } from "./service";
import type { Investigation } from "./service/investigation";
import { AnalysisService } from "./analysis/service";
import { GraphColorService } from "./service/graphColors";
import { CanvasService } from "./service/canvasTools";
import { registerRelationshipCommands } from "./service/relationships";
import { SheetSync } from "./analysis/sheetSync";
import { AnalysisView, ANALYSIS_VIEW_TYPE } from "./analysis/view";
import { DEFAULT_CANVAS_PROMPT, DEFAULT_CONTEXT_SELECTOR_PROMPT } from "./analysis/prompts";

interface ToolChildrenState {
  rootId: string;
  childIds: string[];
}

interface ComsiftState {
  sherlockChildren: Record<string, Record<string, ToolChildrenState>>;
  maigretChildren: Record<string, Record<string, ToolChildrenState>>;
  investigations: Record<string, Investigation>;
  graphSources: Record<string, Record<string, string[]>>;
  graphManagedFiles: string[];
  /** Color group queries this plugin wrote to graph.json. */
  graphColorQueries: string[];
  /** Search filters this plugin added to graph.json (hidden person Canvases). */
  graphSearchTokens: string[];
}

interface ComsiftData {
  settings: ComsiftSettings;
  state: ComsiftState;
  storageLocationVersion?: number;
  /** Excel (embedded) plugin flat settings, when present */
  excel?: unknown;
}

const DEFAULT_STATE: ComsiftState = {
  sherlockChildren: {},
  maigretChildren: {},
  investigations: {},
  graphSources: {},
  graphManagedFiles: [],
  graphColorQueries: [],
  graphSearchTokens: [],
};

const EXCEL_VIEW_TYPE = "excel-view";
const isMainNodeId = (id: unknown) => id === "comsift-main" || id === "whereami-main";

export default class ComsiftPlugin extends Plugin {
  canvas: M.Canvas | null = null;
  intervalTimer = new Map<string, number>();
  node: Node;
  keymap: Keymap;
  view: View;
  layout: Layout;
  setting: ComsiftSettings = { ...DEFAULT_SETTINGS };
  state: ComsiftState = { ...DEFAULT_STATE };
  sherlock!: SherlockService;
  maigret!: MaigretService;
  investigations!: InvestigationService;
  graph!: GraphService;
  analysis!: AnalysisService;
  sheets!: SheetSync;
  graphColors!: GraphColorService;
  canvasTools!: CanvasService;
  private blurCommandRegistered = false;
  private canvasDeleteGuardInstalled = false;
  private guardedCanvasRef: unknown = null;
  private mainNodeStyleTimer: number | null = null;
  /** Pre-bundled excel-modded instance; registrations go through this plugin */
  private excelEmbedded: Plugin | null = null;

  constructor(app: App, manifest: PluginManifest) {
    super(app, manifest);
    this.node = new Node(this);
    this.keymap = new Keymap(this);
    this.view = new View(this);
    this.layout = new Layout(this);
  }

  async onload() {
    await this.loadPluginData();
    this.sherlock = new SherlockService(this);
    this.maigret = new MaigretService(this);
    this.investigations = new InvestigationService(this);
    this.graph = new GraphService(this);
    this.analysis = new AnalysisService(this);
    this.sheets = new SheetSync(this);
    this.graphColors = new GraphColorService(this);
    this.canvasTools = new CanvasService(this);
    this.registerView(ANALYSIS_VIEW_TYPE, leaf => new AnalysisView(leaf, this));
    this.registerView(CANVAS_ASSISTANT_VIEW, leaf => new CanvasAssistant(leaf, this));

    try {
      this.excelEmbedded = await mountEmbeddedExcel(this);
    } catch (e) {
      console.error("[comsift] embedded Excel failed to load", e);
      new Notice("Comsift: Excel (.sheet) failed to load — check console.");
    }

    this.addSettingTab(new ComsiftSettingTab(this));
    this.onActiveLeafChange();
    this.onKeymap();
    this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleMainNodeStyleApply()));
    this.registerCoreCommands();
    this.addRibbonIcon("messages-square", "Comsift analysis and chat", () => { void this.openAnalysis(); });
    this.registerContextMenus();
    this.registerCanvasInteractionGuards();
    this.registerExcelSheetViewRouting();
    this.registerGraphOpenRouting();
    this.investigations.start();
    this.graph.start();
    this.sheets.start();
    this.graphColors.start();
    this.canvasTools.start();
    registerRelationshipCommands(this);
    this.app.workspace.onLayoutReady(() => {
      void this.analysis.migrateProfiles().catch(error => console.error("[comsift] profile migration failed", error));
    });
  }

  onunload() {
    this.keymap.unregisterAll();
    this.intervalTimer.forEach(id => window.clearInterval(id));
  }

  getActiveCanvasFile(): TFile | null {
    const leaf = this.app.workspace.getMostRecentLeaf();
    const file = (leaf?.view as { file?: unknown } | undefined)?.file;
    if (!(file instanceof TFile) || file.extension !== "canvas") {
      return null;
    }
    return file;
  }

  runSherlockFromSelection = () => {
    void this.sherlock.runFromSelection();
  };

  runMaigretFromSelection = () => {
    void this.maigret.runFromSelection();
  };

  private async openAnalysis() {
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: ANALYSIS_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private registerCoreCommands() {
    this.addCommand({
      id: "open-analysis",
      name: "Open analysis and chat",
      callback: () => { void this.openAnalysis(); },
    });
    this.addCommand({
      id: "new-user",
      name: "New person",
      callback: () => this.investigations.promptNewUser(),
    });

    this.addCommand({
      id: "migrate-legacy-pair",
      name: "Migrate legacy Markdown and Canvas pair",
      checkCallback: (checking) => {
        const active = this.app.workspace.getActiveFile();
        if (!active || !this.investigations.isLegacyPair(active)) return false;
        if (!checking) void this.investigations.showMigration(active);
        return true;
      },
    });

    this.addCommand({
      id: "open-user-counterpart",
      name: "Open user Markdown or Canvas",
      checkCallback: checking => {
        const active = this.app.workspace.getActiveFile();
        const item = active && this.investigations.forPath(active.path);
        if (!active || !item) return false;
        if (!checking) {
          const target = this.app.vault.getFileByPath(active.extension === "canvas"
            ? this.investigations.mdPath(item) : this.investigations.canvasPath(item));
          if (target) void this.app.workspace.getLeaf(true).openFile(target);
        }
        return true;
      },
    });

    this.addCommand({
      id: "run-sherlock",
      name: "Run Sherlock on selected Canvas node",
      checkCallback: (checking) => {
        if (!this.canvas || !this.node.getSingleSelection()) return false;
        if (!checking) {
          this.runSherlockFromSelection();
        }
        return true;
      },
    });

    this.addCommand({
      id: "run-maigret",
      name: "Run Maigret on selected Canvas node",
      checkCallback: (checking) => {
        if (!this.canvas || !this.node.getSingleSelection()) return false;
        if (!checking) {
          this.runMaigretFromSelection();
        }
        return true;
      },
    });

  }

  private createCanvasInstance() {
    const timer = window.setInterval(() => {
      const view = this.app.workspace.getLeavesOfType("canvas").first()?.view as { canvas?: M.Canvas } | undefined;
      this.canvas = view?.canvas ?? null;
      if (this.canvas) {
        this.installCanvasDeleteGuard();
        window.clearInterval(this.intervalTimer.get("canvas"));
      }
    }, 100);

    if (!this.intervalTimer.get("canvas")) {
      this.intervalTimer.set("canvas", timer);
    }
  }

  private onActiveLeafChange() {
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        const extension = (leaf?.view as { file?: TFile } | undefined)?.file?.extension;
        if (extension === "canvas") {
          this.onKeymap();
          return;
        }
        this.keymap.unregisterAll();
      }),
    );
  }

  onKeymap() {
    this.createCanvasInstance();
    this.keymap.unregisterAll();
    this.keymap.registerAll();
    this.registerBlurCommand();
    this.scheduleMainNodeStyleApply();
  }

  private registerExcelSheetViewRouting() {
    const maybeRouteActiveLeaf = () => {
      const leaf = this.app.workspace.getMostRecentLeaf();
      if (!leaf) return;

      const viewAny = leaf.view as {
        file?: TFile;
        getViewType?: () => string;
        getState?: () => Record<string, unknown>;
      };
      const file = viewAny.file;
      if (!file || !this.isSheetMarkdown(file)) return;
      if (typeof viewAny.getViewType === "function" && viewAny.getViewType() === EXCEL_VIEW_TYPE) return;

      const state = typeof viewAny.getState === "function" ? viewAny.getState() : {};
      void leaf.setViewState({
        type: EXCEL_VIEW_TYPE,
        state,
        active: true,
      });
    };

    this.registerEvent(this.app.workspace.on("file-open", () => maybeRouteActiveLeaf()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => maybeRouteActiveLeaf()));
    this.app.workspace.onLayoutReady(() => maybeRouteActiveLeaf());
  }

  /** Clicking a person's node in Graph View opens their Canvas (setting "Graph click opens"). */
  private registerGraphOpenRouting() {
    let lastGraphPointer = 0;
    const mark = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.workspace-leaf-content[data-type="graph"], .workspace-leaf-content[data-type="localgraph"]')) {
        lastGraphPointer = Date.now();
      }
    };
    this.registerDomEvent(document, "pointerup", mark, { capture: true });
    this.registerDomEvent(document, "click", mark, { capture: true });
    this.registerEvent(this.app.workspace.on("file-open", file => {
      if (this.setting.primaryOpens !== "canvas" || !file || Date.now() - lastGraphPointer > 1500) return;
      const item = this.investigations.forPrimaryPath(file.path);
      const canvas = item ? this.app.vault.getFileByPath(this.investigations.canvasPath(item)) : null;
      if (!canvas) return;
      lastGraphPointer = 0;
      const leaf = this.app.workspace.getLeavesOfType("markdown")
        .find(candidate => (candidate.view as { file?: TFile | null }).file === file) ?? this.app.workspace.getMostRecentLeaf();
      if (leaf) void leaf.openFile(canvas);
    }));
  }

  private isSheetMarkdown(file: TFile): boolean {
    return file.extension === "md" && /\.sheet$/i.test(file.basename);
  }

  private scheduleMainNodeStyleApply() {
    const apply = () => {
      this.applyMainNodeStyles();
      this.applySherlockQuickButtons();
    };
    apply();
    window.setTimeout(apply, 120);
    window.setTimeout(apply, 450);

    if (this.mainNodeStyleTimer !== null) return;
    // Run periodically but at low frequency, and only re-apply when the actual
    // node DOM has changed. This avoids constant style mutations that can make
    // Canvas re-layout / re-render edges unnecessarily.
    this.mainNodeStyleTimer = window.setInterval(apply, 1200);
    this.register(() => {
      if (this.mainNodeStyleTimer !== null) {
        window.clearInterval(this.mainNodeStyleTimer);
        this.mainNodeStyleTimer = null;
      }
    });
  }

  private collectMainNodes(): M.Node[] {
    const out: M.Node[] = [];
    const seen = new Set<M.Node>();

    const leaves = this.app.workspace.getLeavesOfType("canvas");
    for (const leaf of leaves) {
      const view = leaf.view as unknown as { canvas?: { nodes?: Map<string, M.Node> | Record<string, M.Node> } };
      const canvas = view?.canvas;
      if (!canvas?.nodes) continue;

      let mainNode: M.Node | undefined;
      if (canvas.nodes instanceof Map) {
        mainNode = canvas.nodes.get("comsift-main") ?? canvas.nodes.get("whereami-main");
      } else {
        mainNode = canvas.nodes["comsift-main"] ?? canvas.nodes["whereami-main"];
      }
      if (!mainNode || seen.has(mainNode)) continue;
      seen.add(mainNode);
      out.push(mainNode);
    }

    return out;
  }

  private applySherlockQuickButtons() {
    activeDocument.querySelectorAll<HTMLElement>(".canvas-controls").forEach(menu => addCanvasAssistantButton(this, menu));
    activeDocument.querySelectorAll(".canvas-menu").forEach((menuEl) => {
      if (!menuEl.instanceOf(HTMLElement)) return;
      if (!menuEl.closest(".workspace-leaf")?.querySelector(".canvas-controls")) addCanvasAssistantButton(this, menuEl);
      if (menuEl.querySelector(".comsift-sherlock-quick-btn")) return;

      const templateBtn = menuEl.querySelector<HTMLButtonElement>("button.clickable-icon:last-of-type");
      const btn = menuEl.createEl("button", {
        cls: [...(templateBtn?.className ?? "clickable-icon").split(/\s+/).filter(Boolean), "comsift-sherlock-quick-btn"],
        attr: { type: "button", title: "Run Sherlock on selected node", "aria-label": "Run Sherlock on selected node", "data-tooltip-position": "top" },
      });
      setIcon(btn, "search");
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const leafHost = btn.closest(".workspace-leaf");
        const viewFromLeaf = (leafHost as unknown as { view?: { canvas?: M.Canvas } } | null)?.view;
        let canvas = viewFromLeaf?.canvas;
        if (!canvas) {
          const active = this.app.workspace.getMostRecentLeaf();
          canvas = (active?.view as unknown as { canvas?: M.Canvas } | undefined)?.canvas;
        }
        if (!canvas) return;
        const selection = canvas.selection;
        if (!(selection instanceof Set) || selection.size !== 1) {
          new Notice("Comsift: select exactly one Canvas text node first.");
          return;
        }
        this.canvas = canvas;
        this.runSherlockFromSelection();
      });
    });
  }

  private applyMainNodeStyles() {
    const nodes = this.collectMainNodes();
    if (!nodes.length) return;

    const setIf = (el: HTMLElement, prop: string, value: string, priority: "important" | "" = "important") => {
      if (el.style.getPropertyValue(prop) === value && el.style.getPropertyPriority(prop) === priority) return;
      el.style.setProperty(prop, value, priority);
    };

    nodes.forEach((node) => {
      const root = node.nodeEl;
      const content = node.contentEl ?? root.querySelector<HTMLElement>(".canvas-node-content") ?? root;
      if (!root.classList.contains("comsift-main-node")) {
        root.classList.add("comsift-main-node");
      }
      if (!isMainNodeId(root.getAttribute("data-node-id"))) {
        root.setAttribute("data-node-id", "comsift-main");
      }
      const base = Math.max(17, Math.min(30, Math.round(Math.min(node.width, node.height) * 0.17)));
      const boosted = Math.max(22, Math.min(45, Math.round(base * 1.5)));
      setIf(root, "--comsift-main-font-size", `${boosted}px`, "");

      // Flex only — never position/transform inner markdown layers: Canvas uses
      // layout measurements for edge anchors and port handles; transforms desync arrows.
      setIf(content, "display", "flex");
      setIf(content, "flex-direction", "column");
      setIf(content, "align-items", "center");
      setIf(content, "justify-content", "center");
      setIf(content, "padding", "0px");
      setIf(content, "margin", "0px");
      setIf(content, "overflow", "visible");

      const styleEl = (el: HTMLElement) => {
        setIf(el, "font-size", "var(--comsift-main-font-size, 1.15em)");
        setIf(el, "font-weight", "900");
        setIf(el, "line-height", "1.25");
        setIf(el, "text-align", "center");
        setIf(el, "margin", "0px");
      };

      styleEl(content);

      const targets = content.querySelectorAll<HTMLElement>(
        ".canvas-node-label, .markdown-rendered, .markdown-preview-view, .markdown-preview-sizer, .cm-editor, .cm-scroller, .cm-content, .cm-line, p, h1, h2, h3, h4, h5, h6, span",
      );
      targets.forEach((el) => {
        const cls = el.className?.toString() ?? "";
        if (
          cls.includes("canvas-node") ||
          cls.includes("cm-") ||
          cls.includes("markdown") ||
          el.tagName === "P" ||
          /^H[1-6]$/.test(el.tagName) ||
          el.tagName === "SPAN"
        ) {
          styleEl(el);
        }
      });
    });
  }

  private registerCanvasInteractionGuards() {
    this.registerDomEvent(document, "keydown", (event: KeyboardEvent) => {
      const selected = this.node.getSingleSelection();
      if (!selected || !this.getActiveCanvasFile()) return;
      if (!isMainNodeId(selected.id)) return;
      if (selected.isEditing) return;
      if (this.isEditableTarget(event.target)) return;
      if (!this.isMainDeleteGesture(event)) return;

      event.preventDefault();
      event.stopPropagation();
    });

    this.registerDomEvent(document, "paste", (event: ClipboardEvent) => {
      const selected = this.node.getSingleSelection();
      if (!selected || !this.canvas || !this.getActiveCanvasFile()) return;
      // If the node is already being edited, let Obsidian handle the paste natively.
      if (selected.isEditing) return;
      // If focus is inside any real editable element, don't intercept.
      if (this.isEditableTarget(event.target)) return;

      const pastedText = event.clipboardData?.getData("text/plain")?.replace(/\r\n/g, "\n");
      if (!pastedText || pastedText.length === 0) return;

      event.preventDefault();
      event.stopPropagation();

      // Put the node into edit mode, then after the editor mounts, overwrite its content.
      selected.startEditing();
      window.setTimeout(() => {
        const editor = selected.child?.editor ?? selected.editor;
        if (editor?.setValue) {
          editor.setValue(pastedText);
          const lastLine = editor.lastLine?.() ?? 0;
          editor.setCursor?.(lastLine, pastedText.split("\n").at(-1)?.length ?? 0);
        } else if (editor?.dispatch && editor.state) {
          // CodeMirror 6 dispatch path
          const { state } = editor;
          editor.dispatch(state.update({ changes: { from: 0, to: state.doc.length, insert: pastedText } }));
        }
        this.canvas?.requestSave?.();
      }, 40);
    });
  }

  private installCanvasDeleteGuard() {
    if (!this.canvas) return;
    if (this.guardedCanvasRef !== this.canvas) {
      this.canvasDeleteGuardInstalled = false;
    }
    if (this.canvasDeleteGuardInstalled) return;
    const canvas = this.canvas;
    this.guardedCanvasRef = canvas;
    this.canvasDeleteGuardInstalled = true;

    const wrapDeleteMethod = (methodName: string) => {
      const original = canvas[methodName];
      if (typeof original !== "function") return;
      const call = original as (...args: unknown[]) => unknown;
      canvas[methodName] = (...args: unknown[]): unknown => {
        this.stripMainFromSelection(canvas);
        if (methodName === "removeNode" || methodName === "deleteNode") {
          const nodeArg = args[0] as { id?: unknown } | undefined;
          if (isMainNodeId(nodeArg?.id)) {
            return undefined;
          }
        }
        return call.apply<M.Canvas, unknown[], unknown>(canvas, args);
      };
    };

    wrapDeleteMethod("removeSelection");
    wrapDeleteMethod("deleteSelection");
    wrapDeleteMethod("removeNode");
    wrapDeleteMethod("deleteNode");
  }

  private stripMainFromSelection(canvas: M.Canvas): boolean {
    const selection = canvas.selection;
    if (!(selection instanceof Set) || selection.size === 0) return false;
    let removed = false;
    for (const node of [...selection]) {
      if (isMainNodeId(node?.id)) {
        selection.delete(node);
        removed = true;
      }
    }
    return removed;
  }

  private isMainDeleteGesture(event: KeyboardEvent): boolean {
    if (event.key === "Delete" || event.key === "Backspace") return true;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "x") return true;
    return false;
  }

  private isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName.toLowerCase();
    if (tag === "textarea" || tag === "input") return true;
    return !!target.closest("textarea, input, [contenteditable='true']");
  }

  private registerBlurCommand() {
    if (this.blurCommandRegistered) return;
    this.blurCommandRegistered = true;
    this.addCommand({
      id: "blur-node",
      name: "Blur node",
      checkCallback: () => this.keymap.blurNode(),
    });
  }

  private registerContextMenus() {
    const workspace = this.app.workspace as unknown as {
      on(name: "canvas:node-menu", callback: (menu: Menu, node: { id?: unknown }) => void): EventRef;
    };
    this.registerEvent(
      workspace.on("canvas:node-menu", (menu, node) => {
        const canvas = (node as { canvas?: M.Canvas }).canvas ?? this.canvas;
        if (canvas) this.canvasTools.addAssistantItem(menu, canvas, typeof node.id === "string" ? node.id : undefined);
        if (isMainNodeId(node?.id)) {
          this.hideDeleteMenuItems(menu);
        }
        if (!this.node.getSingleSelection()) return;
        menu.addItem(item =>
          item
            .setTitle("Run Sherlock on selected node")
            .setIcon("search")
            .onClick(() => this.runSherlockFromSelection()),
        );
        menu.addItem(item =>
          item
            .setTitle("Run Maigret on selected node")
            .setIcon("scan-search")
            .onClick(() => this.runMaigretFromSelection()),
        );
      }),
    );

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        menu.addItem(item =>
          item
            .setTitle("New person")
            .setIcon("user-round-plus")
            .onClick(() => this.investigations.promptNewUser()),
        );
        if (!(file instanceof TFile)) return;
        const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
        if (file.extension === "md" && typeof frontmatter?.comsift_account === "string") {
          menu.addItem(item => item.setTitle("New person from profile").setIcon("user-round-plus")
            .onClick(() => this.investigations.promptNewUser(file)));
        }
        if (!this.investigations.isLegacyPair(file)) return;
        menu.addItem(item =>
          item
            .setTitle("Comsift: Migrate")
            .setIcon("folder-input")
            .onClick(() => { void this.investigations.showMigration(file); }),
        );
      }),
    );
  }

  private hideDeleteMenuItems(menu: Menu) {
    const internal = menu as unknown as { items?: Array<{ title?: unknown }>; dom?: HTMLElement };
    if (Array.isArray(internal.items)) {
      internal.items = internal.items.filter(item => {
        const title = typeof item?.title === "string" ? item.title : "";
        return !title.toLowerCase().includes("delete");
      });
    }
    const menuEl = internal.dom;
    if (!menuEl) return;
    const candidates = Array.from(menuEl.querySelectorAll(".menu-item"));
    candidates.forEach((entry) => {
      const label = entry.textContent?.toLowerCase() ?? "";
      if (label.includes("delete")) {
        entry.remove();
      }
    });
  }

  async loadPluginData() {
    const data = (await this.loadData()) as ComsiftData | null;
    this.setting = {
      ...DEFAULT_SETTINGS,
      ...(data?.settings ?? {}),
      hotkeys: {
        ...DEFAULT_SETTINGS.hotkeys,
        ...(data?.settings?.hotkeys ?? {}),
      },
    };
    // Earlier Canvas profiles shipped with empty prompts; show useful, editable defaults on upgrade.
    if (!this.setting.canvasModel?.prompt) this.setting.canvasModel = { ...DEFAULT_SETTINGS.canvasModel, ...this.setting.canvasModel, prompt: DEFAULT_CANVAS_PROMPT };
    if (!this.setting.contextSelectorModel?.prompt) this.setting.contextSelectorModel = { ...DEFAULT_SETTINGS.contextSelectorModel, ...this.setting.contextSelectorModel, prompt: DEFAULT_CONTEXT_SELECTOR_PROMPT };
    if (data?.storageLocationVersion !== 2 && this.setting.usersFolder === "Comsift/Users") {
      this.setting.usersFolder = "";
    }
    if (this.setting.sherlockPosition === this.setting.maigretPosition) this.setting.maigretPosition = "left";
    this.state = {
      ...DEFAULT_STATE,
      ...(data?.state ?? {}),
      sherlockChildren: {
        ...DEFAULT_STATE.sherlockChildren,
        ...(data?.state?.sherlockChildren ?? {}),
      },
      maigretChildren: {
        ...DEFAULT_STATE.maigretChildren,
        ...(data?.state?.maigretChildren ?? {}),
      },
      investigations: {
        ...(data?.state?.investigations ?? {}),
      },
      graphSources: {
        ...(data?.state?.graphSources ?? {}),
      },
      graphManagedFiles: data?.state?.graphManagedFiles ?? [],
      graphColorQueries: data?.state?.graphColorQueries ?? [],
      graphSearchTokens: data?.state?.graphSearchTokens ?? [],
    };
  }

  async saveSettings() {
    const disk = ((await Plugin.prototype.loadData.call(this)) as Partial<ComsiftData> | null) ?? {};
    await this.saveData({
      settings: this.setting,
      state: this.state,
      storageLocationVersion: 2,
      excel: disk.excel ?? {},
    } satisfies ComsiftData);
  }

  async saveState() {
    const disk = ((await Plugin.prototype.loadData.call(this)) as Partial<ComsiftData> | null) ?? {};
    await this.saveData({
      settings: this.setting,
      state: this.state,
      storageLocationVersion: 2,
      excel: disk.excel ?? {},
    } satisfies ComsiftData);
  }

}
