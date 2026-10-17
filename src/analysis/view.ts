import { Component, FuzzySuggestModal, ItemView, MarkdownRenderer, MarkdownView, Notice, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import ComsiftPlugin from "../main";
import type { Investigation } from "../service/investigation";
import type { AnalysisResult, ProfileRecord, CandidatePair } from "./runner";
import type { PreparedEdit, ReasonedResult, ReviewStatus } from "./service";
import type { ChatMessage } from "./ollama";
import { pairKey, type PairHistory } from "./history";
import { diffLines, parseEdits, parseLineLink, visibleWhileStreaming, type ProposedEdit } from "./chatEdits";
import { DecisionReviewModal, type PendingDecision, type ReviewedChoice } from "./decisionReview";
import { contextSlider } from "./contextSlider";
import { parseCanvasEdits } from "../service/canvasModel";
import { ColumnMappingModal, DatasetPickerModal } from "./datasetModals";
import { runSummary, loadedPairs, type RunSummary } from "./resultState";
import { columnMismatches, datasetLabel } from "./columnMapping";

export const ANALYSIS_VIEW_TYPE = "comsift-analysis";

const OTHER_FOLDER = "__other__";
const REVIEW_LABELS: Record<ReviewStatus, string> = {
  confirmed: "Confirmed", related: "Related", rejected: "Rejected", uncertain: "Uncertain", later: "Review later",
};

class FolderModal extends FuzzySuggestModal<TFolder> {
  constructor(private plugin: ComsiftPlugin, private choose: (folder: TFolder) => void,
    placeholder = "Choose a folder for the assistant to work in") {
    super(plugin.app);
    this.setPlaceholder(placeholder);
  }
  getItems() { return this.app.vault.getAllFolders(false); }
  getItemText(folder: TFolder) { return folder.path; }
  onChooseItem(folder: TFolder) { this.choose(folder); }
}

class ChatModal extends FuzzySuggestModal<TFile> {
  constructor(plugin: ComsiftPlugin, private files: TFile[], private choose: (file: TFile) => void) {
    super(plugin.app);
    this.setPlaceholder("Load a saved chat");
  }
  getItems() { return this.files; }
  getItemText(file: TFile) { return file.path; }
  onChooseItem(file: TFile) { this.choose(file); }
}

interface ChatEntry { role: "user" | "assistant"; content: string }

function who(record: ProfileRecord): string {
  const name = record.fields.username || record.fields.display_name || label(record);
  const platform = record.fields.platform;
  return platform ? `${name} (${platform})` : name;
}

/** Premade one-line explanations of each review action, filled with the two records. */
function reviewHint(status: ReviewStatus, source: ProfileRecord, candidate: ProfileRecord): string {
  const a = who(source), b = who(candidate);
  switch (status) {
    case "confirmed": return `Confirmed: ${a} and ${b} are the same person. Creates a profile note for each and links them in Graph View. Undo by choosing another status.`;
    case "related": return `Related: ${a} and ${b} are connected (friends, family, same circle) but NOT the same person. Creates profile notes and a Graph View link, marked as a relation.`;
    case "rejected": return `Rejected: ${b} is NOT the same person as ${a}. Nothing is linked; the candidate stays marked as ruled out.`;
    case "uncertain": return `Uncertain: can't tell whether ${a} and ${b} match. Saved as a note to yourself; no link is created.`;
    case "later": return `Review later: skip ${b} for now. No link is created; it stays in the “Review later” filter.`;
  }
}

function pairScore(pair: CandidatePair, jina?: number): number {
  const own = Math.max(pair.match_probability ?? 0, pair.evidence_score ?? 0);
  return own > 0 ? own : jina ?? 0;
}

const SIGNAL_LABELS: Record<string, string> = {
  username: "username", display_name: "display name", profile_url: "same profile URL", website: "website",
  bio: "bio overlap", location: "location", mention: "handle mentioned",
};

function label(record: ProfileRecord): string {
  const f = record.fields;
  return f.display_name || f.username || f.name || f.full_name || Object.entries(f).find(([key, value]) => key.startsWith("column:") && value.trim())?.[1] || record.id;
}

export class AnalysisView extends ItemView {
  private item: Investigation | null = null;
  private tab: "analysis" | "chat" = "analysis";
  private result: AnalysisResult | null = null;
  private reasoned = new Map<string, ReasonedResult>();
  private reviews: Record<string, { status: ReviewStatus }> = {};
  private history: PairHistory = {};
  private resetDetailScroll = false;
  private selectedSource: string | null = null;
  private filter: "open" | "decided" | "all" | "todo" | ReviewStatus = "open";
  private search = "";
  private controller: AbortController | null = null;
  private status: HTMLElement | null = null;
  private notes: string[] = [];
  private selectedDatasets: string[] | null = null;
  private showLow = false;
  private lastRun: RunSummary | null = null;
  private loadEpoch = 0;
  private loading = false;

  private chatFolder = "";
  private chatHistory: ChatEntry[] = [];
  private chatFile: string | null = null;
  private models: string[] = [];
  private messageHost: HTMLElement | null = null;
  private rendering = new Component();
  /** Window listeners of the current paint (context slider); released before each repaint. */
  private paintCleanups: Array<() => void> = [];

  constructor(leaf: WorkspaceLeaf, private plugin: ComsiftPlugin) { super(leaf); }
  getViewType() { return ANALYSIS_VIEW_TYPE; }
  getDisplayText() { return "Comsift"; }
  getIcon() { return "messages-square"; }

  async onOpen() {
    this.contentEl.addClass("comsift-analysis-view");
    this.addChild(this.rendering);
    const active = this.plugin.app.workspace.getActiveFile();
    const item = (active ? this.plugin.investigations.forPath(active.path) : null)
      ?? Object.values(this.plugin.state.investigations)[0] ?? null;
    if (item) await this.select(item, false);
    this.render();
  }

  async onClose() {
    this.loadEpoch++;
    this.loading = false;
    this.controller?.abort();
    this.paintCleanups.splice(0).forEach(cleanup => cleanup());
  }

  async select(item: Investigation, rerender = true) {
    if (this.controller) return;
    const epoch = ++this.loadEpoch;
    this.loading = true;
    this.selectedDatasets = null;
    this.showLow = false;
    this.lastRun = null;
    this.item = item;
    this.chatFolder = this.chatFolder || item.folderPath;
    if (this.chatFolder !== item.folderPath && !this.chatFolder.startsWith(item.folderPath + "/")) this.chatFolder = item.folderPath;
    this.result = null;
    this.selectedSource = null;
    this.reasoned.clear();
    this.reviews = {};
    this.history = {};
    if (rerender) { this.render(); this.setStatus("Loading saved results…"); }
    try {
      const [result, decisions, reviews, history] = await Promise.all([
        this.plugin.analysis.latestRun(item), this.plugin.analysis.previousDecisions(item),
        this.plugin.analysis.reviews(item), this.plugin.analysis.history(item)]);
      if (epoch !== this.loadEpoch) return;
      this.result = result;
      this.history = history;
      this.reasoned = new Map(Object.entries(decisions));
      this.reviews = reviews;
    } catch (error) {
      if (epoch === this.loadEpoch) this.fail(error);
    } finally {
      if (epoch === this.loadEpoch) { this.loading = false; if (rerender) this.render(); }
    }
  }

  // ---------------------------------------------------------------- shell

  private render() {
    const keep = ["comsift-sources", "comsift-detail", "comsift-messages"].map(cls =>
      [cls, this.contentEl.querySelector<HTMLElement>(`.${cls}`)?.scrollTop ?? 0] as const);
    this.paint();
    for (const [cls, top] of keep) {
      if (cls === "comsift-detail" && this.resetDetailScroll) continue;
      const el = this.contentEl.querySelector<HTMLElement>(`.${cls}`);
      if (el) el.scrollTop = top;
    }
    this.resetDetailScroll = false;
  }

  private paint() {
    this.paintCleanups.splice(0).forEach(cleanup => cleanup());
    this.contentEl.empty();
    const shell = this.contentEl.createDiv({ cls: "comsift-shell" });
    const header = shell.createDiv({ cls: "comsift-header" });
    const tabs = header.createDiv({ cls: "comsift-tabs" });
    for (const [mode, text] of [["analysis", "Analysis"], ["chat", "Chat"]] as const) {
      const button = tabs.createEl("button", { text, cls: this.tab === mode ? "is-active" : "" });
      button.onclick = () => { this.tab = mode; this.render(); };
    }
    this.status = header.createDiv({ cls: "comsift-status", attr: { role: "status" } });
    if (this.tab === "analysis") this.renderAnalysis(shell);
    else this.renderChat(shell);
    if (this.controller || this.loading) this.busy(true);
  }

  private setStatus(value: string) { if (this.status) this.status.textContent = value; }
  private fail(error: unknown) {
    const message = (error as Error).message || String(error);
    this.setStatus(message);
    new Notice(`Comsift: ${message}`, 9000);
  }

  private busy(on: boolean) {
    this.contentEl.toggleClass("is-busy", on);
    for (const control of Array.from(this.contentEl.querySelectorAll<HTMLButtonElement | HTMLSelectElement | HTMLInputElement>("button, select, input"))) {
      if (control.dataset.cancel === "true") continue;
      if (on) { control.dataset.wasDisabled = String(control.disabled); control.disabled = true; }
      else if (control.dataset.wasDisabled !== undefined) { control.disabled = control.dataset.wasDisabled === "true"; delete control.dataset.wasDisabled; }
    }
  }

  private job<T>(text: string, operation: (signal: AbortSignal) => Promise<T>, done: (value: T) => unknown) {
    if (this.controller || this.loading) return;
    this.controller = new AbortController();
    this.setStatus(text);
    this.busy(true);
    void operation(this.controller.signal).then(async value => { await done(value); }).catch((error: unknown) => {
      if ((error as Error).name !== "AbortError") this.fail(error);
      else this.setStatus("Cancelled.");
    }).finally(() => { this.controller = null; this.busy(false); });
  }

  private investigationSelect(parent: HTMLElement) {
    const select = parent.createEl("select", { attr: { "aria-label": "User folder" } });
    const all = Object.values(this.plugin.state.investigations);
    if (!all.length) select.createEl("option", { text: "No users yet", value: "" });
    for (const item of all) select.createEl("option", { text: item.folderPath, value: item.id });
    select.value = this.item?.id ?? "";
    select.onchange = () => {
      const picked = this.plugin.state.investigations[select.value];
      if (picked) { this.chatFolder = picked.folderPath; this.chatHistory = []; this.chatFile = null; void this.select(picked); }
    };
    return select;
  }

  private copyButton(parent: HTMLElement, text: () => string, caption = "Copy") {
    const button = parent.createEl("button", { text: caption, cls: "comsift-ghost" });
    button.onclick = () => void navigator.clipboard.writeText(text()).then(() => {
      button.textContent = "Copied";
      window.setTimeout(() => { button.textContent = caption; }, 1200);
    });
    return button;
  }

  /** "Ollama" for the local server, "AI" for an API provider. */
  private get ai(): string { return this.plugin.setting.aiProvider === "openai" ? "AI" : "Ollama"; }

  /** Main folder first, then the optional extra folders. */
  private folders(): string[] {
    return [this.chatFolder, ...this.plugin.setting.extraFolders.filter(folder => folder !== this.chatFolder)];
  }

  /** Chips for extra folders that widen chat context and analysis datasets. */
  private extraFolderChips(parent: HTMLElement) {
    const wrap = parent.createDiv({ cls: "comsift-folder-chips" });
    for (const folder of this.plugin.setting.extraFolders) {
      const chip = wrap.createSpan({ cls: "comsift-chip comsift-folder-chip", text: `+ ${folder || "/"}` });
      const remove = chip.createEl("button", { cls: "comsift-chip-remove", text: "×", attr: { "aria-label": `Remove ${folder}` } });
      remove.onclick = () => {
        this.plugin.setting.extraFolders = this.plugin.setting.extraFolders.filter(entry => entry !== folder);
        void this.plugin.saveSettings();
        this.render();
      };
    }
    const add = wrap.createEl("button", { text: "+ folder", cls: "comsift-ghost-border",
      attr: { title: "Add another folder to the analysis and chat. Notes linking the folders, and notes one link away from them, are added to the chat context." } });
    add.onclick = () => new FolderModal(this.plugin, folder => {
      if (!this.plugin.setting.extraFolders.includes(folder.path)) {
        this.plugin.setting.extraFolders = [...this.plugin.setting.extraFolders, folder.path];
        void this.plugin.saveSettings();
      }
      this.render();
    }, "Add a folder to search as well").open();
  }

  /** Show what the model decided and apply it only after the user confirms. */
  private reviewDecisions(engine: string, pending: PendingDecision[]) {
    pending = pending.filter(entry => this.isLoaded(entry.source) && entry.candidates.every(candidate => this.isLoaded(entry.source, candidate)));
    if (!pending.length) { this.setStatus("Nothing was decided."); return; }
    this.setStatus(`${engine} finished. Review its decisions.`);
    new DecisionReviewModal(this.app, pending, engine, choices => this.applyChoices(choices),
      () => this.setStatus(`${engine} decisions were not applied. They are saved; run again or decide by hand.`)).open();
  }

  private applyChoices(choices: ReviewedChoice[]) {
    choices = choices.filter(choice => this.isLoaded(choice.source) && choice.candidates.every(candidate => this.isLoaded(choice.source, candidate)));
    if (!choices.length) { this.setStatus("Those results are no longer loaded."); return; }
    const item = this.resultItem;
    this.job(`Applying ${choices.length} decision${choices.length === 1 ? "" : "s"}…`, async signal => {
      let done = 0;
      for (const choice of choices) {
        if (signal.aborted) break;
        if (choice.status === "later" && choice.chosen === "NO_MATCH") continue;
        if (item) await this.plugin.analysis.applyChoice(item, choice.source, choice.candidates, choice.chosen, choice.status, choice.reasoned);
        else for (const candidate of choice.candidates) {
          const status = choice.chosen === candidate.id ? choice.status : "rejected";
          await this.reviewPair(choice.source, candidate, status);
        }
        done++;
      }
      return done;
    }, async count => {
      if (item) this.reviews = await this.plugin.analysis.reviews(item);
      this.render();
      this.setStatus(`Applied ${count} decision${count === 1 ? "" : "s"}. Change any status on its card to undo it.`);
      if (item && this.plugin.setting.autoCanvasArrows) {
        const { added, removed } = await this.plugin.analysis.syncCanvasArrows(item);
        this.setStatus(`Applied ${count} decision${count === 1 ? "" : "s"}; Canvas arrows +${added} −${removed}.`);
      }
    });
  }

  /** Open internal links from rendered answers; `note#L12` / `note#L12-L20` jump to and select those lines. */
  private async openLink(href: string, newLeaf: boolean) {
    const target = parseLineLink(href);
    const linkPath = target ? target.path : href;
    const file = this.app.metadataCache.getFirstLinkpathDest(linkPath.split("#")[0], this.chatFolder)
      ?? this.app.vault.getFileByPath(linkPath);
    if (!target || !(file instanceof TFile)) {
      await this.app.workspace.openLinkText(href, this.chatFolder, newLeaf);
      return;
    }
    const leaf = this.app.workspace.getLeaf(newLeaf);
    await leaf.openFile(file, { eState: { line: target.from - 1 } });
    const view = leaf.view;
    if (view instanceof MarkdownView) {
      const editor = view.editor;
      const last = Math.min(target.to, editor.lineCount()) - 1;
      const from = { line: Math.min(target.from - 1, last), ch: 0 };
      const to = { line: last, ch: editor.getLine(last).length };
      editor.setSelection(from, to);
      editor.scrollIntoView({ from, to }, true);
    }
  }

  // ------------------------------------------------------------- analysis

  private renderAnalysis(shell: HTMLElement) {
    const bar = shell.createDiv({ cls: "comsift-toolbar" });
    const scope = bar.createEl("select", { attr: { "aria-label": "Analysis source scope" } });
    scope.createEl("option", { value: "folder", text: "Investigation folders" });
    scope.createEl("option", { value: "files", text: "Any datasets in vault" });
    scope.value = this.selectedDatasets === null ? "folder" : "files";
    scope.onchange = () => {
      if (this.controller) return;
      if (scope.value === "folder" && this.item) { void this.select(this.item); return; }
      this.selectedDatasets = scope.value === "files" ? [] : null;
      this.resetResults(); this.render();
    };
    if (this.selectedDatasets === null) this.investigationSelect(bar);
    else bar.createEl("button", { text: `Choose datasets (${this.selectedDatasets.length})` }).onclick = () => {
      new DatasetPickerModal(this.plugin, this.selectedDatasets ?? [], paths => {
        this.selectedDatasets = paths; void this.loadComparison();
      }).open();
    };
    const mapping = bar.createEl("button", { text: "Match columns" });
    const mappingEpoch = this.loadEpoch;
    void this.plugin.analysis.discoverColumns(this.datasetPaths()).then(datasets => {
      if (mappingEpoch !== this.loadEpoch || !mapping.isConnected) return;
      const mismatch = columnMismatches(datasets, this.plugin.setting.columnMapping);
      mapping.toggleClass("comsift-column-mismatch", mismatch.some(dataset => dataset.mismatch));
    }).catch(() => { /* The modal reports discovery errors when opened. */ });
    mapping.onclick = () => {
      const paths = this.datasetPaths();
      if (!paths.length) { this.setStatus("Choose datasets first."); return; }
      new ColumnMappingModal(this.plugin, paths, () => { this.render(); this.setStatus("Column mapping saved. Re-run analysis to use it."); }).open();
    };
    const mode = bar.createEl("select", { attr: { "aria-label": "Analysis engine" } });
    for (const [value, text] of [["splink", "Splink"], ["jina", "Jina"], ["combined", "Splink + Jina"]] as const) {
      mode.createEl("option", { text, value });
    }
    mode.value = this.plugin.setting.analysisMode;
    mode.onchange = () => {
      this.plugin.setting.analysisMode = mode.value as typeof this.plugin.setting.analysisMode;
      void this.plugin.saveSettings();
    };
    const run = bar.createEl("button", { text: this.result ? "Re-run" : "Run analysis", cls: "mod-cta" });
    run.disabled = this.selectedDatasets !== null ? this.selectedDatasets.length < 2 : !this.item;
    run.onclick = () => {
      if (this.controller) return;
      const item = this.resultItem;
      const paths = this.selectedDatasets ? [...this.selectedDatasets] : null;
      if (!paths && !item) return;
      const previous = this.result;
      const extra = this.plugin.setting.extraFolders.filter(folder => folder !== item?.folderPath);
      this.job("Analyzing datasets… (this can take a while)", async signal => {
        const result = paths ? await this.plugin.analysis.analyzeFiles(paths, signal, item ?? undefined)
          : await this.plugin.analysis.analyze(item!, signal, extra);
        if (item) [this.history, this.reviews] = await Promise.all([this.plugin.analysis.history(item), this.plugin.analysis.reviews(item)]);
        return result;
      }, result => {
        this.reasoned.clear();
        this.result = result;
        this.lastRun = runSummary(previous, result, this.plugin.setting.splinkThreshold, this.plugin.setting.analysisLowThreshold);
        this.showLow = false;
        this.selectedSource = null;
        this.render();
        this.setStatus(this.runMessage());
      });
    };
    const arrows = bar.createEl("button", { text: "Update Canvas arrows",
      attr: { title: "Adds profile nodes for confirmed and related pairs to the person's Canvas, joined by same-person or related arrows. Arrows of reopened or rejected pairs are removed." } });
    arrows.disabled = !this.result || this.selectedDatasets !== null || !this.resultItem;
    arrows.onclick = () => {
      if (!this.result || !this.resultItem) return;
      const item = this.resultItem;
      this.job("Updating Canvas arrows…", () => this.plugin.analysis.syncCanvasArrows(item),
        ({ added, removed }) => this.setStatus(`Canvas updated: ${added} arrow${added === 1 ? "" : "s"} added, ${removed} removed.`));
    };
    const check = bar.createEl("button", { text: "Check tools" });
    check.onclick = () => this.job("Checking Python environment…", signal => this.plugin.analysis.checkPython(signal),
      versions => {
        this.notes = Object.entries(versions).map(([key, value]) => `${key}: ${value ?? "MISSING"}`);
        this.render();
        this.setStatus("Environment checked.");
      });
    const cancel = bar.createEl("button", { text: "Cancel" });
    cancel.dataset.cancel = "true";
    cancel.onclick = () => this.controller?.abort();
    if (this.selectedDatasets === null) this.extraFolderChips(bar);
    else shell.createDiv({ cls: "comsift-source-meta", text: this.selectedDatasets.length
      ? `${this.selectedDatasets.join(" · ")} — results and reviews are saved under Comsift/Comparisons; confirmed relationships create profile notes and graph links.`
      : "Choose two or more CSV files or spreadsheet tabs from anywhere in the vault." });

    if (this.notes.length) {
      const box = shell.createDiv({ cls: "comsift-note" });
      for (const line of this.notes) box.createDiv({ text: line });
    }
    if (!this.item && this.selectedDatasets === null) {
      shell.createDiv({ cls: "comsift-empty", text: "Create a person (File Explorer → New person), put two or more CSV files in its folder, then run the analysis." });
      return;
    }
    if (!this.result) {
      const empty = shell.createDiv({ cls: "comsift-empty" });
      empty.createEl("h3", { text: "No analysis yet" });
      empty.createEl("p", { text: this.selectedDatasets !== null
        ? "Choose any datasets, match their columns, then run the comparison."
        : `Put at least two CSV files in “${this.item!.folderPath}”. Each record in one file is compared with records in the other files.` });
      empty.createEl("p", { text: "Scores are signals for you to review, not proof of identity." });
      return;
    }
    if (this.lastRun) shell.createDiv({ cls: "comsift-source-meta", text: this.runMessage() });
    const floor = shell.createDiv({ cls: "comsift-toolbar" });
    floor.createSpan({ cls: "comsift-source-meta", text: "Lower-score floor" });
    const minimum = floor.createEl("input", { type: "number", value: String(this.plugin.setting.analysisLowThreshold),
      attr: { min: "0", max: "1", step: "0.05", "aria-label": "Lower-score floor" } });
    minimum.onchange = () => {
      this.plugin.setting.analysisLowThreshold = Math.max(0, Math.min(1, Number(minimum.value) || 0));
      void this.plugin.saveSettings(); this.render();
    };
    const lowCount = loadedPairs(this.result).filter(pair => pairScore(pair) >= this.plugin.setting.analysisLowThreshold && pairScore(pair) < this.plugin.setting.splinkThreshold).length;
    const lower = floor.createEl("button", { text: this.showLow ? "Hide lower-score results" : `Show lower-score results (${lowCount})` });
    lower.disabled = lowCount === 0;
    lower.onclick = () => { this.showLow = !this.showLow; this.selectedSource = null; this.render(); };
    floor.createSpan({ cls: "comsift-source-meta", text: "Lowering the floor requires a re-run to find additional pairs." });
    const visible = this.visibleResult();
    this.renderSummary(shell, visible);
    this.renderBulk(shell, visible);
    const body = shell.createDiv({ cls: "comsift-split" });
    this.renderSources(body.createDiv({ cls: "comsift-sources" }), visible);
    this.renderDetail(body.createDiv({ cls: "comsift-detail" }), visible);
  }

  private get resultItem(): Investigation | null {
    return this.selectedDatasets === null ? this.item : this.selectedDatasets.length ? this.plugin.analysis.comparisonItem(this.selectedDatasets) : null;
  }

  private async loadComparison() {
    this.resetResults();
    const item = this.resultItem;
    if (!item) { this.render(); return; }
    const epoch = this.loadEpoch;
    this.loading = true; this.render();
    try {
      const [result, reviews, history, decisions] = await Promise.all([
        this.plugin.analysis.latestRun(item), this.plugin.analysis.reviews(item),
        this.plugin.analysis.history(item), this.plugin.analysis.previousDecisions(item),
      ]);
      if (epoch !== this.loadEpoch) return;
      this.result = result; this.reviews = reviews; this.history = history;
      this.reasoned = new Map(Object.entries(decisions));
    } catch (error) { if (epoch === this.loadEpoch) this.fail(error); }
    finally { if (epoch === this.loadEpoch) { this.loading = false; this.render(); } }
  }

  private runMessage(): string {
    const summary = this.lastRun;
    if (!summary) return "";
    if (summary.rerun && !summary.fresh) return `No new matches found.${summary.updated ? ` Updated evidence for ${summary.updated} existing pairs.` : ""}${summary.low ? ` ${summary.low} lower-score pairs are available below.` : ""}`;
    return `${summary.fresh} ${summary.rerun ? "new " : ""}candidate pairs found.${this.selectedDatasets === null ? " Saved in the investigation's Analysis folder." : " Saved in Comsift/Comparisons."}`;
  }

  private resetResults() {
    this.loadEpoch++;
    this.loading = false;
    this.result = null; this.selectedSource = null; this.reviews = {}; this.history = {};
    this.reasoned.clear(); this.lastRun = null; this.showLow = false;
  }

  private datasetPaths(): string[] {
    if (this.selectedDatasets) return this.selectedDatasets;
    if (!this.item) return [];
    const roots = [this.item.folderPath, ...this.plugin.setting.extraFolders];
    return this.plugin.analysis.listDatasets().filter(file => roots.some(root => !root || file.path.startsWith(root + "/"))).map(file => file.path);
  }

  private visibleResult(): AnalysisResult {
    const result = this.result!;
    const minimum = this.showLow ? this.plugin.setting.analysisLowThreshold : this.plugin.setting.splinkThreshold;
    return { ...result, pairs: loadedPairs(result).filter(pair => pairScore(pair) >= minimum) };
  }

  private reviewOf(sourceId: string, candidateId: string): ReviewStatus | undefined {
    return this.reviews[`${sourceId} → ${candidateId}`]?.status;
  }

  private isLoaded(source: ProfileRecord, candidate?: ProfileRecord): boolean {
    if (this.loading || !this.result?.records.includes(source)) return false;
    const visible = this.visibleResult();
    return candidate ? this.result.records.includes(candidate) && visible.pairs.some(pair => pair.left_id === source.id && pair.right_id === candidate.id)
      : visible.pairs.some(pair => pair.left_id === source.id);
  }

  private async reviewPair(source: ProfileRecord, candidate: ProfileRecord, status: ReviewStatus) {
    if (!this.isLoaded(source, candidate)) throw new Error("Those results are no longer loaded.");
    if (this.resultItem) await this.plugin.analysis.review(this.resultItem, source, candidate, status, this.reasoned.get(source.id));
    this.reviews[`${source.id} → ${candidate.id}`] = { status };
  }

  private async unreviewPair(source: ProfileRecord, candidate: ProfileRecord) {
    if (!this.isLoaded(source, candidate)) throw new Error("Those results are no longer loaded.");
    if (this.resultItem) await this.plugin.analysis.unreview(this.resultItem, source.id, candidate.id);
    delete this.reviews[`${source.id} → ${candidate.id}`];
  }

  private cachedReason(source: ProfileRecord, candidates: ProfileRecord[]): ReasonedResult | undefined {
    const saved = this.reasoned.get(source.id);
    return saved && (saved.decision.candidate_id === "NO_MATCH" || candidates.some(candidate => candidate.id === saved.decision.candidate_id)) ? saved : undefined;
  }

  private renderSummary(shell: HTMLElement, result: AnalysisResult) {
    const sources = new Set(result.pairs.map(pair => pair.left_id));
    const statuses = loadedPairs(result).map(pair => this.reviewOf(pair.left_id, pair.right_id));
    const reviewed = statuses.filter(status => status && status !== "later");
    const confirmed = statuses.filter(status => status === "confirmed").length;
    const datasets = new Set(result.records.map(record => record.dataset)).size;
    const strip = shell.createDiv({ cls: "comsift-stats" });
    for (const [value, text] of [
      [datasets, "datasets"], [result.records.length, "records"], [sources.size, "records with candidates"],
      [result.pairs.length, "candidate pairs"], [reviewed.length, "reviewed"], [confirmed, "confirmed"],
    ] as const) {
      const cell = strip.createDiv({ cls: "comsift-stat" });
      cell.createDiv({ cls: "comsift-stat-value", text: String(value) });
      cell.createDiv({ cls: "comsift-stat-label", text });
    }
  }

  private renderBulk(shell: HTMLElement, result: AnalysisResult) {
    const bar = shell.createDiv({ cls: "comsift-bulk" });
    const shownSources = new Set(this.sourceRows(result).map(row => row.id));
    const pairs = result.pairs.filter(pair => shownSources.has(pair.left_id));
    const records = new Map(result.records.map(record => [record.id, record]));
    const jinaOf = (pair: CandidatePair) => result.jina.find(item => item.source_id === pair.left_id && item.id === pair.right_id)?.score;
    const undecidedPairs = () => pairs.filter(pair =>
      !this.reviewOf(pair.left_id, pair.right_id) && records.has(pair.left_id) && records.has(pair.right_id));
    const groups = new Map<string, CandidatePair[]>();
    for (const pair of pairs) groups.set(pair.left_id, [...(groups.get(pair.left_id) ?? []), pair]);
    const open = [...groups.entries()].filter(([id, pairs]) => this.sourceState(id, pairs) === "todo" && records.has(id));

    bar.createSpan({ cls: "comsift-source-meta", text: "Undecided, score" });
    const input = bar.createEl("input", { type: "number", attr: { step: "0.05", min: "0", max: "1", "aria-label": "Score cut-off" } });
    input.value = String(this.plugin.setting.autoConfirmThreshold);
    const confirmAll = bar.createEl("button", { cls: "comsift-ghost-border" });
    const rejectAll = bar.createEl("button", { cls: "comsift-ghost-border" });
    const decideAll = bar.createEl("button", { cls: "comsift-ghost-border" });
    const jinaInput = bar.createEl("input", { type: "number", attr: { step: "0.05", min: "0", max: "1", "aria-label": "Jina decision threshold" } });
    jinaInput.value = String(this.plugin.setting.jinaDecideThreshold);
    const jinaAll = bar.createEl("button", { cls: "comsift-ghost-border" });

    const cutoff = () => Math.min(1, Math.max(0, Number(input.value) || 0));
    const sets = () => {
      const limit = cutoff();
      const all = undecidedPairs();
      return {
        confirm: all.filter(pair => pairScore(pair, jinaOf(pair)) >= limit),
        reject: all.filter(pair => pairScore(pair, jinaOf(pair)) < limit),
      };
    };
    let armed: "confirm" | "reject" | null = null;
    const refresh = () => {
      const { confirm, reject } = sets();
      confirmAll.textContent = armed === "confirm" ? `Click again: confirm ${confirm.length}` : `Confirm ${confirm.length} ≥ ${input.value}`;
      rejectAll.textContent = armed === "reject" ? `Click again: reject ${reject.length}` : `Reject ${reject.length} < ${input.value}`;
      confirmAll.title = `Marks every undecided candidate pair scoring ≥ ${input.value} as the same person. Set the cut-off to 0 to confirm all undecided. Each can be changed later.`;
      rejectAll.title = `Marks every undecided candidate pair scoring < ${input.value} as not the same person. Set the cut-off to 1 to reject all undecided.`;
      confirmAll.disabled = confirm.length === 0;
      rejectAll.disabled = reject.length === 0;
      decideAll.textContent = `Let ${this.ai} decide ${open.length} open`;
      decideAll.title = `Runs ${this.ai} on every source you have not reviewed, then shows an overview of its picks to adjust and confirm before anything is applied. Cancel any time.`;
      decideAll.disabled = open.length === 0 || !this.plugin.setting.ollamaModel.trim();
      jinaAll.textContent = `Let Jina decide ${open.length} open (≥ ${jinaInput.value})`;
      jinaAll.title = "Re-runs the Jina model per source on its results and the investigation note, with a “no match” option, then shows an overview to confirm.";
      jinaAll.disabled = open.length === 0 || !this.plugin.setting.jinaModelPath;
    };
    const run = (kind: "confirm" | "reject") => {
      if (armed !== kind) {
        armed = kind; refresh();
        window.setTimeout(() => { if (armed === kind) { armed = null; if (!this.controller && !this.loading) refresh(); } }, 6000);
        return;
      }
      armed = null;
      const batch = sets()[kind];
      const bySource = new Map<string, CandidatePair[]>();
      batch.forEach(pair => bySource.set(pair.left_id, [...(bySource.get(pair.left_id) ?? []), pair]));
      this.job(`${kind === "confirm" ? "Confirming" : "Rejecting"} ${batch.length}…`, async signal => {
        let done = 0;
        for (const pair of batch) {
          if (signal.aborted) break;
          await this.reviewPair(records.get(pair.left_id)!, records.get(pair.right_id)!, kind === "confirm" ? "confirmed" : "rejected");
          this.reviews[`${pair.left_id} → ${pair.right_id}`] = { status: kind === "confirm" ? "confirmed" : "rejected" };
          done++;
        }
        return done;
      }, async count => {
        this.render();
        this.setStatus(`${kind === "confirm" ? "Confirmed" : "Rejected"} ${count}. Change any status on its card to undo it.`);
      });
    };
    confirmAll.onclick = () => run("confirm");
    rejectAll.onclick = () => run("reject");
    input.onchange = () => {
      this.plugin.setting.autoConfirmThreshold = cutoff();
      void this.plugin.saveSettings();
      armed = null;
      refresh();
    };
    jinaInput.onchange = () => {
      this.plugin.setting.jinaDecideThreshold = Math.min(1, Math.max(0, Number(jinaInput.value) || 0.75));
      void this.plugin.saveSettings();
      refresh();
    };

    const sweep = (engine: string, decide: (source: ProfileRecord, candidates: ProfileRecord[], signal: AbortSignal) => Promise<ReasonedResult>) => {
      const label = `${engine} is deciding…`;
      const pending: PendingDecision[] = [];
      let shown = false;
      const finish = () => {
        if (shown) return;
        shown = true;
        this.render();
        this.reviewDecisions(engine, pending);
      };
      this.job(label, async signal => {
        for (const [id, pairs] of open) {
          if (signal.aborted) break;
          const source = records.get(id)!;
          const candidates = pairs.map(pair => records.get(pair.right_id)).filter((c): c is ProfileRecord => !!c);
          this.setStatus(`${label} ${pending.length + 1}/${open.length}`);
          const outcome = await decide(source, candidates, signal);
          this.reasoned.set(id, outcome);
          pending.push({ source, candidates, reasoned: outcome });
        }
        return pending.length;
      }, finish);
      // A cancelled sweep still offers what was decided so far.
      const controller = this.controller;
      controller?.signal.addEventListener("abort", () => window.setTimeout(() => { if (pending.length) finish(); }, 0), { once: true });
    };
    decideAll.onclick = () => sweep(this.ai, async (source, candidates, signal) =>
      this.cachedReason(source, candidates) ?? await this.plugin.analysis.reason(this.resultItem, source, candidates, result, false, signal));
    jinaAll.onclick = () => sweep("Jina", (source, candidates, signal) =>
      this.plugin.analysis.jinaDecide(this.resultItem, source, candidates, result, this.plugin.setting.jinaDecideThreshold, signal));
    refresh();
  }

  private sourceState(sourceId: string, matches: CandidatePair[]): ReviewStatus | "todo" {
    const states = matches.map(pair => this.reviewOf(sourceId, pair.right_id)).filter((s): s is ReviewStatus => !!s);
    if (!states.length) return "todo";
    return states.includes("confirmed") ? "confirmed" : states.includes("related") ? "related" : states.includes("uncertain") ? "uncertain"
      : states.includes("later") ? "later" : "rejected";
  }

  private matchesFilter(state: ReviewStatus | "todo"): boolean {
    const decided = state === "confirmed" || state === "related" || state === "rejected";
    switch (this.filter) {
      case "all": return true;
      case "open": return !decided;
      case "decided": return decided;
      default: return state === this.filter;
    }
  }

  private topScore(matches: CandidatePair[], sourceId: string, result: AnalysisResult): number {
    return Math.max(0, ...matches.map(pair => pairScore(pair,
      result.jina.find(item => item.source_id === sourceId && item.id === pair.right_id)?.score)));
  }

  private sourceRows(result: AnalysisResult) {
    const records = new Map(result.records.map(record => [record.id, record]));
    const grouped = new Map<string, CandidatePair[]>();
    for (const pair of loadedPairs(result)) grouped.set(pair.left_id, [...(grouped.get(pair.left_id) ?? []), pair]);
    const needle = this.search.trim().toLowerCase();
    return [...grouped.entries()].map(([id, matches]) => ({ id, matches, record: records.get(id)!,
      state: this.sourceState(id, matches), score: this.topScore(matches, id, result) }))
      .filter(row => this.matchesFilter(row.state) && (!needle || (label(row.record) + " " + row.record.dataset).toLowerCase().includes(needle)))
      .sort((a, b) => b.score - a.score).slice(0, 300);
  }

  private renderSources(host: HTMLElement, result: AnalysisResult) {
    const controls = host.createDiv({ cls: "comsift-source-controls" });
    const search = controls.createEl("input", { type: "search", placeholder: "Search records…", value: this.search });
    const filter = controls.createEl("select", { attr: { "aria-label": "Filter" } });
    for (const [value, text] of [["open", "Open"], ["decided", "History (decided)"], ["all", "Everything"],
      ["todo", "Never reviewed"], ["confirmed", "Confirmed"], ["related", "Related"], ["rejected", "Rejected"],
      ["uncertain", "Uncertain"], ["later", "Review later"]] as const) {
      filter.createEl("option", { text, value });
    }
    filter.value = this.filter;
    if (this.filter === "decided") {
      const reopen = host.createEl("button", { text: "Reopen all decided", cls: "comsift-ghost-border",
        attr: { title: "Moves every decided pair back to open and removes the Graph View links this plugin generated for them." } });
      reopen.onclick = () => {
        const shown = new Set(this.sourceRows(result).map(row => row.id));
        const targets = result.pairs.filter(pair => {
          const status = this.reviewOf(pair.left_id, pair.right_id);
          return shown.has(pair.left_id) && (status === "confirmed" || status === "related" || status === "rejected");
        });
        if (!targets.length) return;
        this.job(`Reopening ${targets.length}…`, async () => {
          const records = new Map(result.records.map(record => [record.id, record]));
          for (const pair of targets) await this.unreviewPair(records.get(pair.left_id)!, records.get(pair.right_id)!);
          return targets.length;
        }, async count => {
          this.render();
          this.setStatus(`Reopened ${count}.`);
        });
      };
    }
    const list = host.createDiv({ cls: "comsift-source-list" });

    const draw = () => {
      list.empty();
      const rows = this.sourceRows(result);
      if (!rows.length) list.createDiv({ cls: "comsift-empty", text: "Nothing matches this filter." });
      for (const row of rows.slice(0, 300)) {
        const entry = list.createDiv({ cls: "comsift-source" + (row.id === this.selectedSource ? " is-selected" : "") });
        const top = entry.createDiv({ cls: "comsift-source-top" });
        top.createSpan({ cls: "comsift-source-name", text: `${label(row.record)} (${datasetLabel(row.record.dataset)})` });
        top.createSpan({ cls: `comsift-chip is-${row.state}`, text: row.state === "todo" ? "new" : REVIEW_LABELS[row.state] });
        entry.createDiv({ cls: "comsift-source-meta",
          text: `${row.record.dataset.split("/").at(-1)} · row ${row.record.row} · ${row.matches.length} candidate${row.matches.length === 1 ? "" : "s"} · top ${row.score.toFixed(2)}` });
        entry.onclick = () => { this.selectedSource = row.id; this.resetDetailScroll = true; this.render(); };
      }
    };
    search.oninput = () => {
      this.search = search.value; this.selectedSource = null; this.render();
      const next = this.contentEl.querySelector<HTMLInputElement>(".comsift-source-controls input");
      next?.focus();
    };
    filter.onchange = () => { this.filter = filter.value as typeof this.filter; this.selectedSource = null; this.render(); };
    draw();
  }

  private renderDetail(host: HTMLElement, result: AnalysisResult) {
    const records = new Map(result.records.map(record => [record.id, record]));
    const source = this.selectedSource ? records.get(this.selectedSource) : undefined;
    if (!source) {
      host.createDiv({ cls: "comsift-empty", text: "Select a record on the left to compare it with its candidates." });
      return;
    }
    const matches = result.pairs.filter(pair => pair.left_id === source.id);
    const candidates = matches.map(pair => records.get(pair.right_id)).filter((c): c is ProfileRecord => !!c);

    const head = host.createDiv({ cls: "comsift-detail-head" });
    head.createEl("h3", { text: label(source) });
    head.createDiv({ cls: "comsift-source-meta", text: `${source.dataset} · row ${source.row}${source.section ? ` · ${source.section}` : ""}` });
    const ai = this.ai;
    const reason = head.createEl("button", { text: this.reasoned.has(source.id) ? `Ask ${ai} again` : `Ask ${ai}`, cls: "mod-cta" });
    reason.disabled = !candidates.length || !this.plugin.setting.ollamaModel.trim();
    reason.onclick = () => {
      const jina = !!this.plugin.setting.jinaModelPath;
      this.job(`${ai} is weighing the candidates…`,
        signal => this.plugin.analysis.reason(this.resultItem, source, candidates, result, jina, signal),
        decided => { this.reasoned.set(source.id, decided); this.render(); this.setStatus(`${ai} finished. Review its reasoning below.`); });
    };

    const decide = head.createEl("button", { text: `Let ${ai} decide`,
      attr: { title: `${ai} picks a candidate (or none); you get an overview to adjust or confirm before it is applied.` } });
    decide.disabled = !candidates.length || !this.plugin.setting.ollamaModel.trim();
    decide.onclick = () => this.job(`${ai} is deciding…`, async signal => {
      const outcome = this.cachedReason(source, candidates) ?? await this.plugin.analysis.reason(this.resultItem, source, candidates, result, false, signal);
      this.reasoned.set(source.id, outcome);
      return outcome;
    }, outcome => {
      this.render();
      this.reviewDecisions(ai, [{ source, candidates, reasoned: outcome }]);
    });

    const jinaDecide = head.createEl("button", { text: "Let Jina decide",
      attr: { title: "Re-runs the Jina model on this record's results (scores, evidence, earlier assessment) plus the investigation note, with a “no match” option, then shows the outcome to confirm." } });
    jinaDecide.disabled = !candidates.length || !this.plugin.setting.jinaModelPath;
    jinaDecide.onclick = () => {
      this.job("Jina is weighing the results…", async signal => {
        const verdict = await this.plugin.analysis.jinaDecide(this.resultItem, source, candidates, result,
          this.plugin.setting.jinaDecideThreshold, signal);
        this.reasoned.set(source.id, verdict);
        return verdict;
      }, verdict => {
        this.render();
        this.reviewDecisions("Jina", [{ source, candidates, reasoned: verdict }]);
      });
    };

    const saved = this.cachedReason(source, candidates);
    if (saved) this.renderDecision(host, saved, source);

    const sorted = [...matches].sort((x, y) => pairScore(y) - pairScore(x));
    for (const pair of sorted) {
      const candidate = records.get(pair.right_id);
      if (candidate) this.renderCandidate(host, source, candidate, pair, result);
    }
  }

  private renderDecision(host: HTMLElement, result: ReasonedResult, source: ProfileRecord) {
    const block = host.createDiv({ cls: "comsift-decision" });
    const verdict = result.decision.candidate_id === "NO_MATCH" ? "No candidate matches" : `Picked: ${result.decision.candidate_id}`;
    const title = block.createDiv({ cls: "comsift-decision-title" });
    title.createSpan({ text: `${this.ai} · ${verdict}` });
    if (result.decision.uncertain) title.createSpan({ cls: "comsift-chip is-uncertain", text: "uncertain" });
    const prose = block.createDiv({ cls: "comsift-prose markdown-rendered" });
    void MarkdownRenderer.render(this.app, result.decision.explanation, prose, "", this.rendering);
    for (const [heading, items] of [["Supports", result.decision.supporting_evidence], ["Conflicts", result.decision.conflicting_evidence]] as const) {
      if (!items.length) continue;
      const group = block.createDiv({ cls: "comsift-evidence" });
      group.createEl("strong", { text: heading });
      const ul = group.createEl("ul");
      for (const text of items) ul.createEl("li", { text });
    }
    if (result.interpretation?.length && result.interpretation[0].id !== result.decision.candidate_id) {
      block.createDiv({ cls: "comsift-note", text: "Jina ranks a different option first. Weigh both before deciding." });
    }
    void source;
  }

  private renderCandidate(host: HTMLElement, source: ProfileRecord, candidate: ProfileRecord,
    pair: CandidatePair, result: AnalysisResult) {
    const card = host.createDiv({ cls: "comsift-candidate" });
    const top = card.createDiv({ cls: "comsift-candidate-top" });
    top.createEl("strong", { text: label(candidate) });
    top.createSpan({ cls: "comsift-source-meta", text: `${candidate.dataset.split("/").at(-1)} · row ${candidate.row}${candidate.section ? ` · ${candidate.section}` : ""}` });
    const current = this.reviewOf(source.id, candidate.id);
    if (current) top.createSpan({ cls: `comsift-chip is-${current}`, text: REVIEW_LABELS[current] });

    card.createDiv({ cls: "comsift-question",
      text: `Is ${who(candidate)} the same person as ${who(source)}?` });

    const scores = card.createDiv({ cls: "comsift-scores" });
    const ranking = result.jina.find(item => item.source_id === source.id && item.id === candidate.id);
    if (pair.match_probability !== undefined) this.bar(scores, "Splink", pair.match_probability, `${(pair.match_probability * 100).toFixed(1)}%`);
    if (pair.evidence_score !== undefined) this.bar(scores, "Evidence", pair.evidence_score, `${(pair.evidence_score * 100).toFixed(0)}% combined`);
    if (ranking) this.bar(scores, "Jina", Math.max(0, Math.min(1, ranking.score)), `#${ranking.rank} · ${ranking.score.toFixed(2)}`);

    const signals = (pair.evidence as { signals?: Record<string, number> } | undefined)?.signals ?? {};
    const chips = card.createDiv({ cls: "comsift-signals" });
    for (const [name, value] of Object.entries(signals)) {
      chips.createSpan({ cls: "comsift-chip", text: `${SIGNAL_LABELS[name] ?? name} ${Math.round(value * 100)}%` });
    }
    const past = this.history[pairKey(source, candidate)];
    if (past) {
      const parts: string[] = [];
      if (past.runs === 1) parts.push("new in the latest scan");
      else {
        parts.push(`seen in ${past.runs} scans`);
        if (past.prev !== undefined && past.score - past.prev >= 0.05) parts.push(`evidence ↑ ${Math.round((past.score - past.prev) * 100)} pts`);
        if (past.gained.length) parts.push(`new evidence: ${past.gained.map(name => SIGNAL_LABELS[name] ?? name).join(", ")}`);
      }
      card.createDiv({ cls: "comsift-source-meta", text: parts.join(" · ") });
    }

    const keys = [...new Set([...Object.keys(source.fields), ...Object.keys(candidate.fields)])]
      .filter(key => (source.fields[key] || candidate.fields[key]) && key !== "relation");
    const table = card.createEl("table", { cls: "comsift-compare" });
    const headRow = table.createEl("thead").createEl("tr");
    for (const text of ["Field", `Source (${datasetLabel(source.dataset)})`, `Candidate (${datasetLabel(candidate.dataset)})`]) headRow.createEl("th", { text });
    const body = table.createEl("tbody");
    for (const key of keys) {
      const a = (source.fields[key] ?? "").trim();
      const b = (candidate.fields[key] ?? "").trim();
      const state = !a || !b || key === "platform" ? "is-missing"
        : a.toLowerCase() === b.toLowerCase() ? "is-same" : "is-diff";
      const row = body.createEl("tr", { cls: state });
      row.createEl("td", { text: key });
      row.createEl("td", { text: a || "—" });
      row.createEl("td", { text: b || "—" });
    }

    const actions = card.createDiv({ cls: "comsift-review-actions" });
    if (current) {
      const reopen = actions.createEl("button", { text: "Reopen", cls: "comsift-ghost" });
      reopen.onclick = () => this.job("Reopening pair…", () => this.unreviewPair(source, candidate), () => {
        this.render();
      });
    }
    const hint = card.createDiv({ cls: "comsift-hint",
      text: current ? reviewHint(current, source, candidate) : "Pick an answer. Nothing changes in your notes until you do." });
    for (const status of ["confirmed", "related", "rejected", "uncertain", "later"] as const) {
      const button = actions.createEl("button", { text: REVIEW_LABELS[status], cls: current === status ? "is-active" : "",
        attr: { title: reviewHint(status, source, candidate) } });
      const idle = hint.textContent;
      button.onmouseenter = button.onfocus = () => { hint.textContent = reviewHint(status, source, candidate); };
      button.onmouseleave = button.onblur = () => { hint.textContent = idle; };
      button.onclick = () => this.job("Saving review…", () => this.reviewPair(source, candidate, status), () => {
        this.render();
        this.setStatus(reviewHint(status, source, candidate));
      });
    }
  }

  private bar(parent: HTMLElement, name: string, value: number, text: string) {
    const row = parent.createDiv({ cls: "comsift-bar-row" });
    row.createSpan({ cls: "comsift-bar-name", text: name });
    const track = row.createDiv({ cls: "comsift-bar" });
    track.createDiv({ cls: "comsift-bar-fill" }).style.width = `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
    row.createSpan({ cls: "comsift-bar-text", text });
  }

  // ----------------------------------------------------------------- chat

  private renderChat(shell: HTMLElement) {
    const bar = shell.createDiv({ cls: "comsift-toolbar" });
    const folders = bar.createEl("select", { attr: { "aria-label": "Folder the assistant works in" } });
    const items = Object.values(this.plugin.state.investigations);
    const known = new Set(items.map(item => item.folderPath));
    for (const item of items) folders.createEl("option", { text: item.folderPath, value: item.folderPath });
    if (this.chatFolder && !known.has(this.chatFolder)) folders.createEl("option", { text: this.chatFolder, value: this.chatFolder });
    folders.createEl("option", { text: "Other folder…", value: OTHER_FOLDER });
    folders.value = this.chatFolder || (items[0]?.folderPath ?? OTHER_FOLDER);
    folders.onchange = () => {
      if (folders.value === OTHER_FOLDER) {
        new FolderModal(this.plugin, folder => { this.chatFolder = folder.path; this.chatHistory = []; this.chatFile = null; this.render(); }).open();
        folders.value = this.chatFolder;
        return;
      }
      this.chatFolder = folders.value;
      this.chatHistory = [];
      this.chatFile = null;
      this.render();
    };

    this.extraFolderChips(bar);

    const modelSelect = bar.createEl("select", { attr: { "aria-label": "Model" } });
    const fill = (names: string[]) => {
      modelSelect.empty();
      const current = this.plugin.setting.ollamaModel;
      const list = names.includes(current) || !current ? names : [current, ...names];
      if (!list.length) modelSelect.createEl("option", { text: "No models", value: "" });
      for (const name of list) modelSelect.createEl("option", { text: name, value: name });
      modelSelect.value = current || list[0] || "";
    };
    fill(this.models);
    modelSelect.onchange = () => { this.plugin.setting.ollamaModel = modelSelect.value; void this.plugin.saveSettings(); };
    if (!this.models.length) {
      void this.plugin.analysis.models().then(names => {
        this.models = names;
        if (names.length && !names.includes(this.plugin.setting.ollamaModel)) {
          this.plugin.setting.ollamaModel = names[0];
          void this.plugin.saveSettings();
        }
        fill(names);
      }).catch(error => this.fail(error));
    }
    const think = bar.createEl("label", { cls: "comsift-toggle", attr: { title: "Let reasoning models think before answering. Slower, and may run out of tokens before answering." } });
    const thinkBox = think.createEl("input", { type: "checkbox" });
    thinkBox.checked = this.plugin.setting.ollamaThink;
    thinkBox.onchange = () => { this.plugin.setting.ollamaThink = thinkBox.checked; void this.plugin.saveSettings(); };
    think.createSpan({ text: " Think" });
    contextSlider(bar, this.plugin.setting.ollamaContext, value => {
      this.plugin.setting.ollamaContext = value;
      void this.plugin.saveSettings();
    }, cleanup => this.paintCleanups.push(cleanup));
    bar.createEl("button", { text: "New chat" }).onclick = () => { this.chatHistory = []; this.chatFile = null; this.render(); };
    const save = bar.createEl("button", { text: this.chatFile ? "Saved ✓" : "Save chat",
      attr: { title: "Saves this conversation as a readable Markdown note in <folder>/Chats/. Once saved, new replies are added automatically." } });
    save.onclick = () => {
      if (!this.chatHistory.length) { this.setStatus("Nothing to save yet."); return; }
      void this.plugin.analysis.saveChat(this.chatFolder, this.chatFile, this.chatHistory).then(path => {
        this.chatFile = path;
        save.textContent = "Saved ✓";
        this.setStatus(`Saved to ${path}`);
      }).catch(error => this.fail(error));
    };
    bar.createEl("button", { text: "Load chat" }).onclick = () => {
      const files = this.plugin.analysis.listChats();
      if (!files.length) return this.setStatus("No saved chats yet. Use “Save chat” first.");
      new ChatModal(this.plugin, files, file => void this.plugin.analysis.loadChat(file.path).then(log => {
        if (log.folder) this.chatFolder = log.folder;
        this.chatHistory = log.messages;
        this.chatFile = file.path;
        this.render();
        this.setStatus(`Loaded ${file.basename}`);
      }).catch(error => this.fail(error))).open();
    };
    bar.createEl("button", { text: "Stop" }).onclick = () => this.controller?.abort();

    this.messageHost = shell.createDiv({ cls: "comsift-messages" });
    this.messageHost.addEventListener("click", event => {
      const link = (event.target as HTMLElement | null)?.closest("a.internal-link");
      const href = link?.getAttribute("data-href") ?? link?.getAttribute("href");
      if (!link || !href) return;
      event.preventDefault();
      void this.openLink(href, event.ctrlKey || event.metaKey).catch(error => this.fail(error));
    });
    if (!this.chatFolder) {
      this.messageHost.createDiv({ cls: "comsift-empty", text: "Choose a folder to work in." });
      return;
    }
    if (!this.chatHistory.length) {
      this.messageHost.createDiv({ cls: "comsift-empty",
        text: `Ask about the files in “${this.folders().join("”, “")}”, request summaries, or tell me to add information. Answers link to notes and exact lines. Every change is shown as a diff and needs your approval; you can undo it afterwards.` });
    }
    for (const entry of this.chatHistory) this.addMessage(entry.role, entry.content, false);

    const composer = shell.createDiv({ cls: "comsift-composer" });
    const input = composer.createEl("textarea", { attr: { placeholder: "Ask a question or request a change…  (Enter to send, Shift+Enter for newline)" } });
    const send = composer.createEl("button", { text: "Send", cls: "mod-cta" });
    const submit = () => {
      const question = input.value.trim();
      if (!question || this.controller) return;
      const prior: ChatMessage[] = this.chatHistory.map(entry => ({ ...entry }));
      this.chatHistory.push({ role: "user", content: question });
      this.messageHost!.querySelector(".comsift-empty")?.remove();
      this.addMessage("user", question, false);
      input.value = "";
      const reply = this.addMessage("assistant", "", true);
      let timer: number | null = null;
      let latest = "";
      const paint = () => {
        timer = null;
        const { text, pendingEdit } = visibleWhileStreaming(latest);
        reply.setMarkdown(text + (pendingEdit ? "\n\n*✎ drafting a change…*" : ""));
      };
      let reasoning = "";
      this.job("Thinking…", signal => this.plugin.analysis.chat(this.folders(), question, prior, text => {
        latest = text;
        if (timer === null) timer = window.setTimeout(paint, 120);
      }, this.plugin.app.workspace.getActiveFile()?.path ?? null, signal, thought => {
        reasoning = thought;
        reply.setThinking(thought);
        if (!latest) reply.setMarkdown("*Thinking…*");
      }), ({ answer, context }) => {
        if (timer !== null) window.clearTimeout(timer);
        if (!answer.trim()) {
          const note = reasoning
            ? "The model spent its whole budget on reasoning and returned no answer. Turn **Think** off or raise the context length in settings."
            : "The model returned no text. Check that the selected model supports chat, then try again.";
          this.chatHistory.pop();
          reply.setMarkdown(note);
          this.setStatus("Empty answer.");
          return;
        }
        const boards = parseCanvasEdits(answer);
        const parsed = parseEdits(boards.text);
        const changes = parsed.edits.length;
        this.chatHistory.push({ role: "assistant", content: parsed.text || answer });
        reply.setMarkdown(parsed.text || (changes ? "Proposed changes:" : "(empty answer)"));
        reply.finalize(`Context: ${context.files.length} file(s)` +
          (context.bridges.length ? `, ${context.bridges.length} linking the folders` : "") +
          (context.omitted ? `, ${context.omitted} omitted for size` : ""),
          context.files.map(file => file.role === "folder" ? file.path : `${file.path}  (${file.role})`));
        for (const edit of parsed.edits) this.showEdit(edit);
        const base = changes ? "Review the proposed changes below." : "Ready.";
        this.setStatus(base);
        if (this.chatFile) void this.plugin.analysis.saveChat(this.chatFolder, this.chatFile, this.chatHistory).catch(error => this.fail(error));
        if (this.plugin.setting.aiProvider === "openai") return;
        void this.plugin.analysis.running().then(models => {
          const used = models.find(model => model.name === this.plugin.setting.ollamaModel) ?? models[0];
          if (!used || !used.size) return;
          const gpu = Math.round(used.vram / used.size * 100);
          this.setStatus(`${base}  ·  ${used.name}: ${100 - gpu}% CPU / ${gpu}% GPU${gpu < 50 ? " — not enough free GPU memory when it loaded" : ""}`);
        }).catch(() => { /* informational only */ });
      });
    };
    send.onclick = submit;
    input.onkeydown = event => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
    };
    input.focus();
  }

  private addMessage(role: "user" | "assistant", markdown: string, live: boolean) {
    const host = this.messageHost!;
    const wrap = host.createDiv({ cls: `comsift-msg is-${role}` });
    const head = wrap.createDiv({ cls: "comsift-msg-head" });
    head.createSpan({ text: role === "user" ? "You" : "Assistant" });
    let raw = markdown;
    this.copyButton(head, () => raw);
    const content = wrap.createDiv({ cls: "comsift-prose markdown-rendered" });
    const meta = wrap.createDiv({ cls: "comsift-msg-meta" });
    const thought = role === "assistant" ? wrap.createEl("details", { cls: "comsift-thinking" }) : null;
    if (thought) thought.hidden = true;
    const thoughtSummary = thought?.createEl("summary", { text: "Thinking" });
    const thoughtText = thought?.createEl("pre");
    const holder = new Component();
    this.rendering.addChild(holder);
    const setMarkdown = (value: string) => {
      raw = value;
      content.empty();
      void MarkdownRenderer.render(this.app, value, content, this.chatFolder, holder).then(() => {
        host.scrollTop = host.scrollHeight;
      });
    };
    if (markdown || !live) setMarkdown(markdown);
    else content.setText("…");
    return {
      setMarkdown,
      setThinking: (value: string) => {
        if (!thought || !thoughtSummary || !thoughtText) return;
        thought.hidden = !value;
        thoughtSummary.setText(value ? `Thinking · ${value.length} characters` : "Thinking");
        thoughtText.setText(value);
      },
      finalize: (summary: string, paths: string[]) => {
        const details = meta.createEl("details");
        details.createEl("summary", { text: summary });
        details.createDiv({ text: paths.join("\n"), cls: "comsift-paths" });
      },
    };
  }

  private showEdit(edit: ProposedEdit) {
    const panel = this.messageHost!.createDiv({ cls: "comsift-edit" });
    const title = panel.createDiv({ cls: "comsift-edit-title" });
    const verb = edit.action === "create" ? "Create" : edit.action === "patch" ? "Patch" : "Rewrite";
    title.createSpan({ text: `${verb} ${edit.path}` });
    const body = panel.createDiv({ cls: "comsift-edit-body" });
    const actions = panel.createDiv({ cls: "comsift-review-actions" });
    let prepared: PreparedEdit;
    void this.plugin.analysis.prepareEdit(this.folders(), edit).then(ready => {
      prepared = ready;
      this.drawDiff(body, ready);
      const apply = actions.createEl("button", { text: "Apply", cls: "mod-cta" });
      const reject = actions.createEl("button", { text: "Reject" });
      reject.onclick = () => panel.remove();
      apply.onclick = () => void this.plugin.analysis.commitEdit(prepared).then(() => {
        actions.empty();
        title.createSpan({ cls: "comsift-chip is-confirmed", text: "applied" });
        const open = actions.createEl("button", { text: "Open file" });
        open.onclick = () => void this.plugin.app.workspace.openLinkText(prepared.path, "", true);
        const undo = actions.createEl("button", { text: "Undo" });
        undo.onclick = () => void this.plugin.analysis.undoEdit(prepared).then(() => {
          panel.remove();
          this.setStatus(`Reverted ${prepared.path}.`);
        }).catch(error => this.fail(error));
      }).catch(error => this.fail(error));
    }).catch(error => {
      body.createDiv({ cls: "comsift-note", text: (error as Error).message });
      actions.createEl("button", { text: "Dismiss" }).onclick = () => panel.remove();
    });
  }

  private drawDiff(host: HTMLElement, edit: PreparedEdit) {
    const lines = diffLines(edit.before ?? "", edit.after);
    const added = lines.filter(line => line.kind === "add").length;
    const removed = lines.filter(line => line.kind === "del").length;
    host.createDiv({ cls: "comsift-source-meta", text: `+${added} −${removed}` });
    const pre = host.createDiv({ cls: "comsift-diff" });
    const CONTEXT = 2;
    const show = lines.map((line, index) => line.kind !== "same" ||
      lines.slice(Math.max(0, index - CONTEXT), index + CONTEXT + 1).some(near => near.kind !== "same"));
    let hidden = 0;
    const flush = () => {
      if (hidden) pre.createDiv({ cls: "comsift-diff-gap", text: `⋯ ${hidden} unchanged line${hidden === 1 ? "" : "s"}` });
      hidden = 0;
    };
    lines.forEach((line, index) => {
      if (!show[index]) { hidden++; return; }
      flush();
      const row = pre.createDiv({ cls: `comsift-diff-line is-${line.kind}` });
      row.createSpan({ cls: "comsift-diff-sign", text: line.kind === "add" ? "+" : line.kind === "del" ? "−" : " " });
      row.createSpan({ text: line.text || " " });
    });
    flush();
  }
}
