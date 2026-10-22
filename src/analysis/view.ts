import { createClient } from "./ollama";
import { DEFAULT_DECISION_PROMPT } from "./prompts";
import { publishConversation, latestConversation, conversationMention, openCanvasConversation } from "./chatBridge";
import { stripExecutableProposals } from "./chatLog";
import type { ChatToolOutput } from "./chatTools";
import { mentionedFolders, prioritizeMentionFiles } from "./fileMentions";
import { chatMarkdown } from "./chatMarkdown";
import { inlinePromptEditor, chatIconButton, errorDetails, traceDetails, throttleText, variantBar, type TraceSink } from "./chatUi";
import { DEFAULT_MODEL_PROFILE, parentSettings, resolveDecisionSettings } from "./modelProfiles";
import { DecisionAttemptsError } from "./decisionRetry";
import { Component, FuzzySuggestModal, ItemView, MarkdownRenderer, MarkdownView, Notice, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import ComsiftPlugin from "../main";
import type { Investigation } from "../service/investigation";
import type { AnalysisResult, ProfileRecord, CandidatePair } from "./runner";
import type { PreparedEdit, ReasonedResult, ReviewStatus } from "./service";
import type { ChatMessage } from "./ollama";
import { pairKey, type PairHistory } from "./history";
import { diffLines, parseEdits, unwrapToolFences, parseLineLink, visibleWhileStreaming, type ProposedEdit } from "./chatEdits";
import { decisionProfile, summarizeVerdicts } from "./ollama";
import { defaultChoices, DecisionReviewModal, type PendingDecision, type ReviewedChoice, type ReviewTools } from "./decisionReview";
import { contextSlider } from "./contextSlider";
import { parseCanvasEdits } from "../service/canvasModel";
import { ColumnMappingModal, DatasetPickerModal } from "./datasetModals";
import { SheetRangeModal } from "./sheetRangeModal";
import { runSummary, loadedPairs, type RunSummary } from "./resultState";
import { columnMismatches, datasetLabel } from "./columnMapping";

export const ANALYSIS_VIEW_TYPE = "comsift-analysis";

const OTHER_FOLDER = "__other__";
const REVIEW_LABELS: Record<ReviewStatus, string> = {
  confirmed: "Confirmed", related: "Related", rejected: "Rejected", uncertain: "Uncertain", later: "Review later",
};

class FolderModal extends FuzzySuggestModal<TFolder> {
  constructor(private plugin: ComsiftPlugin, private choose: (folder: TFolder) => void,
    placeholder = "Choose a chat folder") {
    super(plugin.app);
    this.setPlaceholder(placeholder);
  }
  getItems() { return this.app.vault.getAllFolders(false); }
  getItemText(folder: TFolder) { return folder.path; }
  onChooseItem(folder: TFolder) { this.choose(folder); }
}

interface Mention { path: string; folder: boolean }
/** Pick a file or a folder to include in a chat message. */
class MentionModal extends FuzzySuggestModal<Mention> {
  constructor(plugin: ComsiftPlugin, private items: Mention[], private choose: (item: Mention) => void) { super(plugin.app); }
  getItems() { return this.items; }
  getItemText(item: Mention) { return item.folder ? `${item.path}/` : item.path; }
  onChooseItem(item: Mention) { this.choose(item); }
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

interface ChatEntry { role: "user" | "assistant"; content: string; variants?: string[] }

function who(record: ProfileRecord): string {
  const name = record.fields.username || record.fields.display_name || label(record);
  const platform = record.fields.platform;
  return platform ? `${name} (${platform})` : name;
}

/** Premade one-line explanations of each review action, filled with the two records. */
function reviewHint(status: ReviewStatus, source: ProfileRecord, candidate: ProfileRecord): string {
  const a = who(source), b = who(candidate);
  switch (status) {
    case "confirmed": return `${a} and ${b} are the same person. Create linked profile notes.`;
    case "related": return `${a} and ${b} are different, related people. Create profile notes with a relationship link.`;
    case "rejected": return `${b} is a different person from ${a}. Reject this match.`;
    case "uncertain": return `Save ${a} and ${b} as an uncertain match.`;
    case "later": return `Move ${b} to Review later.`;
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
  private decisionWindows = new WeakMap<ReasonedResult, DecisionReviewModal>();
  private decisionWindowScopes = new WeakMap<DecisionReviewModal, string>();
  private reviews: Record<string, { status: ReviewStatus; pending?: boolean }> = {};
  private history: PairHistory = {};
  private resetDetailScroll = false;
  private selectedSource: string | null = null;
  private reasoningSource: string | null = null;
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
  private pendingEdits = new Set<() => void>();
  private submitChat: ((question: string, retry?: boolean) => void) | null = null;
  private chatReplies = new Map<number, ReturnType<AnalysisView["addMessage"]>>();
  private lastReply: ReturnType<AnalysisView["addMessage"]> | null = null;
  private retryButton: HTMLElement | null = null;
  private jobKind: "chat" | "analysis" | null = null;
  private models: string[] = [];
  private composerInput: HTMLTextAreaElement | null = null;
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

  /** Stop and Cancel buttons are live only while a task of their own kind runs. */
  private syncStops() {
    for (const stop of Array.from(this.contentEl.querySelectorAll<HTMLButtonElement>("button[data-stop]"))) stop.disabled = this.jobKind !== stop.dataset.stop;
  }

  private job<T>(text: string, operation: (signal: AbortSignal) => Promise<T>, done: (value: T) => unknown, failed?: (error: unknown, cancelled: boolean) => void, kind: "chat" | "analysis" = "analysis") {
    if (this.controller || this.loading) return;
    this.controller = new AbortController();
    this.jobKind = kind;
    this.setStatus(text);
    this.busy(true);
    this.syncStops();
    void operation(this.controller.signal).then(async value => { await done(value); }).catch((error: unknown) => {
      const cancelled = (error as Error).name === "AbortError";
      failed?.(error, cancelled);
      if (!cancelled) this.fail(error);
      else this.setStatus("Cancelled.");
    }).finally(() => { this.controller = null; this.jobKind = null; this.busy(false); this.syncStops(); });
  }

  private investigationSelect(parent: HTMLElement) {
    const select = parent.createEl("select", { attr: { "aria-label": "User folder" } });
    const all = Object.values(this.plugin.state.investigations);
    if (!all.length) select.createEl("option", { text: "No people yet", value: "" });
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

  /** Provider-neutral action label. */
  private get ai(): string { return "AI"; }

  /** Main folder first, then the optional extra folders. */
  private folders(): string[] {
    const mentioned = new Set<string>();
    for (const turn of this.chatHistory) if (turn.role === "user") for (const folder of mentionedFolders(turn.content)) mentioned.add(folder);
    return [this.chatFolder, ...[...mentioned].filter(folder => folder !== this.chatFolder)];
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
      attr: { title: "Include another folder and its linked notes." } });
    add.onclick = () => new FolderModal(this.plugin, folder => {
      if (!this.plugin.setting.extraFolders.includes(folder.path)) {
        this.plugin.setting.extraFolders = [...this.plugin.setting.extraFolders, folder.path];
        void this.plugin.saveSettings();
      }
      this.render();
    }, "Add a folder to search as well").open();
  }

  /** Accept model suggestions as draft choices; final application happens in the ordinary review summary. */
  private reviewDecisions(engine: string, pending: PendingDecision[], reassess = false) {
    pending = pending.filter(entry => this.isLoaded(entry.source) && entry.candidates.every(candidate => this.isLoaded(entry.source, candidate)));
    if (!pending.length) { this.setStatus("Nothing was decided."); return; }
    const previousWindow = this.decisionWindows.get(pending[0].reasoned);
    const scope = pending.flatMap(entry => entry.candidates.map(candidate => `${entry.source.id} → ${candidate.id}`)).sort().join("\n");
    if (previousWindow && this.decisionWindowScopes.get(previousWindow) === scope) {
      previousWindow.open(); if (reassess) previousWindow.openReassessment(); return;
    }
    const drafts = new Map(pending.flatMap(entry => this.decisionWindows.get(entry.reasoned)?.draftChoices() ?? [])
      .map(choice => [`${choice.source.id} → ${choice.candidate.id}`, choice]));
    this.setStatus(`Review ${engine} decisions.`);
    const reviewWindow = new DecisionReviewModal(this.app, pending, engine, choices => this.stageAiChoices(choices),
      () => { this.render(); this.setStatus("AI decisions kept in their review window."); }, ids => {
        const item = this.resultItem;
        for (const id of ids) this.reasoned.delete(id);
        if (item) void this.plugin.analysis.settleDecisions(item, ids, false).catch(error => this.fail(error));
        this.render();
        this.setStatus(`Discarded ${ids.length} AI decision${ids.length === 1 ? "" : "s"}.`);
      }, pending.flatMap(defaultChoices).map(choice => drafts.get(`${choice.source.id} → ${choice.candidate.id}`) ?? ({ ...choice, status: this.reviews[`${choice.source.id} → ${choice.candidate.id}`]?.status ?? choice.status })), choices => this.summarizeChoices(choices), "Add choices", "ai", this.reviewTools());
    this.decisionWindowScopes.set(reviewWindow, scope);
    for (const entry of pending) this.decisionWindows.set(entry.reasoned, reviewWindow);
    reviewWindow.open();
    if (reassess) reviewWindow.openReassessment();
  }

  private async runReviewAction(text: string, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.controller || this.loading) throw new Error("Wait for the current operation to finish.");
    const controller = new AbortController(); this.controller = controller; this.jobKind = "analysis";
    this.setStatus(text); this.busy(true); this.syncStops();
    try { await work(controller.signal); }
    finally { this.controller = null; this.jobKind = null; this.busy(false); this.syncStops(); }
  }

  private async stageAiChoices(choices: ReviewedChoice[]): Promise<void> {
    if (choices.some(choice => !this.isLoaded(choice.source, choice.candidate))) throw new Error("Those results are no longer loaded.");
    await this.runReviewAction("Adding AI choices to review…", async signal => {
      for (const choice of choices) {
        signal.throwIfAborted();
        await this.reviewPair(choice.source, choice.candidate, choice.status);
      }
      this.render(); this.setStatus(`Added ${choices.length} choices. Open Summary to confirm them.`);
    });
  }

  private async applyChoices(choices: ReviewedChoice[]): Promise<void> {
    if (choices.some(choice => !this.isLoaded(choice.source, choice.candidate))) throw new Error("Those results are no longer loaded.");
    const item = this.resultItem;
    await this.runReviewAction(`Applying ${choices.length} decisions…`, async signal => {
      try {
        for (const [index, choice] of choices.entries()) {
          signal.throwIfAborted();
          this.setStatus(`Applying decision ${index + 1} of ${choices.length}…`);
          if (item) await this.plugin.analysis.review(item, choice.source, choice.candidate, choice.status, choice.reasoned, true);
          else this.reviews[`${choice.source.id} → ${choice.candidate.id}`] = { status: choice.status };
        }
      } finally {
        if (item) { await this.plugin.analysis.finishReviewBatch(item); this.reviews = await this.plugin.analysis.reviews(item); }
      }
      if (item) {
        const completed = [...new Set(choices.map(choice => choice.source.id))].filter(id => loadedPairs(this.visibleResult()).filter(pair => pair.left_id === id).every(pair => {
          const review = this.reviews[`${pair.left_id} → ${pair.right_id}`]; return review && !review.pending;
        }));
        if (completed.length) await this.plugin.analysis.settleDecisions(item, completed, true);
        if (this.plugin.setting.autoCanvasArrows) await this.plugin.analysis.syncCanvasArrows(item);
      }
      if (choices.some(choice => choice.source.id === this.selectedSource)) this.selectedSource = null;
      this.reasoningSource = null;
      this.render(); this.setStatus(`Applied ${choices.length} decisions.`);
    });
  }

  private reviewTools(): ReviewTools {
    const settings = resolveDecisionSettings(this.plugin.setting);
    return {
      model: settings.ollamaModel,
      prompt: (settings.decisionPrompt || DEFAULT_DECISION_PROMPT) + "\n\nReassess the selected pairs using all visible profile context and previous decisions. Earlier judgments are fallible hypotheses, not proof. Explain whether new evidence changes the verdict; avoid copying a previous verdict merely for consistency.",
      models: () => createClient(settings).models(),
      redecide: async (choices, options) => {
        const replacements: ReviewedChoice[] = [];
        await this.runReviewAction("Reassessing decisions…", async signal => {
          const result = this.visibleResult();
          const records = new Map(result.records.map(record => [record.id, record]));
          const previous = [...this.reasoned.entries()].flatMap(([id, reasoned]) => {
            const source = records.get(id); if (!source) return [];
            const candidates = result.pairs.filter(pair => pair.left_id === id).map(pair => records.get(pair.right_id)).filter((record): record is ProfileRecord => !!record);
            return defaultChoices({ source, candidates, reasoned });
          });
          previous.push(...choices);
          for (const sourceId of new Set(choices.map(choice => choice.source.id))) {
            signal.throwIfAborted();
            const selected = choices.filter(choice => choice.source.id === sourceId);
            const reasoned = await this.plugin.analysis.reason(this.resultItem, selected[0].source, selected.map(choice => choice.candidate), result, false, signal,
              { settings: { ...settings, ollamaModel: options.model, decisionPrompt: options.prompt }, previous });
            const updated = defaultChoices({ source: selected[0].source, candidates: selected.map(choice => choice.candidate), reasoned });
            replacements.push(...updated); previous.push(...updated);
            const old = this.reasoned.get(sourceId);
            const changed = new Set(selected.map(choice => choice.candidate.id));
            const verdicts = [...(old?.decision.verdicts ?? []).filter(entry => !changed.has(entry.candidate_id)), ...(reasoned.decision.verdicts ?? [])];
            const merged = { ...reasoned, decision: { ...reasoned.decision, verdicts, ...summarizeVerdicts(verdicts) } };
            this.reasoned.set(sourceId, merged);
            const window = old && this.decisionWindows.get(old);
            if (window) this.decisionWindows.set(merged, window);
          }
          this.render(); this.setStatus(`Reassessed ${replacements.length} decisions. Review them before confirming.`);
        });
        return replacements;
      },
    };
  }

  private previousChoiceContext(result: AnalysisResult): ReviewedChoice[] {
    const records = new Map(result.records.map(record => [record.id, record]));
    return [...this.reasoned.entries()].flatMap(([id, reasoned]) => {
      const source = records.get(id); if (!source) return [];
      const candidates = result.pairs.filter(pair => pair.left_id === id).map(pair => records.get(pair.right_id)).filter((record): record is ProfileRecord => !!record);
      return defaultChoices({ source, candidates, reasoned }).map(choice => ({ ...choice,
        status: this.reviews[`${choice.source.id} → ${choice.candidate.id}`]?.status ?? choice.status }));
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
    const mapping = bar.createEl("button", { text: "Columns" });
    const mappingEpoch = this.loadEpoch;
    void this.plugin.analysis.discoverColumns(this.datasetPaths()).then(datasets => {
      if (mappingEpoch !== this.loadEpoch || !mapping.isConnected) return;
      const mismatch = columnMismatches(datasets, this.plugin.setting.columnMapping);
      const problems = mismatch.reduce((sum, dataset) => sum + dataset.conflicts.length, 0);
      mapping.toggleClass("comsift-column-mismatch", problems > 0 || mismatch.some(dataset => dataset.mismatch));
      if (problems) mapping.setText(`Columns (${problems} to fix)`);
      mapping.setAttr("title", problems ? "Two columns in one dataset have the same role." : mismatch.some(dataset => dataset.mismatch)
        ? "Datasets have different fields; open to compare them." : "Columns are set automatically. Open to review.");
    }).catch(() => { /* The modal reports discovery errors when opened. */ });
    mapping.onclick = () => {
      const paths = this.datasetPaths();
      if (!paths.length) { this.setStatus("Choose datasets first."); return; }
      new ColumnMappingModal(this.plugin, paths, () => { this.render(); this.setStatus("Column mapping saved. Re-run analysis to use it."); }).open();
    };
    const ranges = bar.createEl("button", { text: "Sheet ranges", attr: { title: "Choose row and column rectangles, including their header rows." } });
    ranges.onclick = () => {
      const paths = this.datasetPaths();
      if (!paths.length) { this.setStatus("Choose datasets first."); return; }
      new SheetRangeModal(this.plugin, paths, () => {
        void this.loadComparison();
        this.setStatus("Sheet ranges saved. Import connections or re-run analysis to use them.");
      }).open();
    };
    const importProfiles = bar.createEl("button", { text: "Import connections", attr: { title: "Create a connection profile for each selected row without running a comparison." } });
    importProfiles.onclick = () => {
      const paths = this.datasetPaths();
      if (!paths.length) { this.setStatus("Choose datasets first."); return; }
      this.job("Importing connection profiles…", signal => this.plugin.analysis.importConnections(paths, this.resultItem ?? undefined, signal),
        count => { this.render(); this.setStatus(`Imported ${count} records into Connections.`); });
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
    run.disabled = this.selectedDatasets !== null ? this.selectedDatasets.length < 1 : !this.item;
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
      attr: { title: "Sync Canvas nodes and arrows with reviewed relationships." } });
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
    cancel.dataset.cancel = "true"; cancel.dataset.stop = "analysis"; cancel.disabled = this.jobKind !== "analysis";
    cancel.onclick = () => { if (this.jobKind === "analysis") this.controller?.abort(); };
    if (this.selectedDatasets === null) this.extraFolderChips(bar);
    else shell.createDiv({ cls: "comsift-source-meta", text: this.selectedDatasets.length
      ? `${this.selectedDatasets.join(" · ")}: results and reviews are saved under Comsift/Comparisons; confirmed relationships create profile notes and graph links.`
      : "Choose CSV files, spreadsheet tabs or existing connection profiles from anywhere in the vault. One dataset can be compared within itself." });

    if (this.notes.length) {
      const box = shell.createDiv({ cls: "comsift-note" });
      for (const line of this.notes) box.createDiv({ text: line });
    }
    if (!this.item && this.selectedDatasets === null) {
      shell.createDiv({ cls: "comsift-empty", text: "Create a person from File Explorer and add a CSV file or spreadsheet, or choose datasets from the vault." });
      return;
    }
    if (!this.result) {
      const empty = shell.createDiv({ cls: "comsift-empty" });
      empty.createEl("h3", { text: "No analysis yet" });
      empty.createEl("p", { text: this.selectedDatasets !== null
        ? "Choose datasets, check Columns, then run analysis."
        : `Add a CSV file, spreadsheet or connection profile to “${this.item!.folderPath}”.` });
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
    lower.disabled = lowCount === 0 && !this.showLow;
    lower.onclick = () => { this.toggleLowerResults(); this.render(); };
    floor.createSpan({ cls: "comsift-source-meta", text: "Lowering the floor requires a re-run to find additional pairs." });
    const visible = this.visibleResult();
    this.renderSummary(shell, visible);
    this.renderBulk(shell, visible);
    const staged = this.stagedChoices(visible);
    if (staged.length) {
      shell.createEl("button", { text: "Summary", cls: "mod-cta", attr: { title: `Review ${staged.length} pending choices. Unchosen pairs stay open.` } }).onclick = () => this.showStagedSummary(visible);
    }
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

  private toggleLowerResults() {
    this.showLow = !this.showLow;
    this.search = "";
    this.filter = "all";
    const result = this.visibleResult();
    const lower = result.pairs.find(pair => pairScore(pair) < this.plugin.setting.splinkThreshold);
    this.selectedSource = (this.showLow ? lower?.left_id : undefined) ?? result.pairs[0]?.left_id ?? null;
    this.resetDetailScroll = true;
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
    if (this.resultItem) await this.plugin.analysis.stageReview(this.resultItem, source, candidate, status);
    this.reviews[`${source.id} → ${candidate.id}`] = { status, pending: true };
  }

  private async unreviewPair(source: ProfileRecord, candidate: ProfileRecord) {
    if (!this.isLoaded(source, candidate)) throw new Error("Those results are no longer loaded.");
    if (this.resultItem) await this.plugin.analysis.unreview(this.resultItem, source.id, candidate.id);
    delete this.reviews[`${source.id} → ${candidate.id}`];
    if (this.resultItem) this.reviews = await this.plugin.analysis.reviews(this.resultItem);
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
    const previous = this.previousChoiceContext(result);
    if (previous.length) {
      const redo = bar.createEl("button", { text: "Redecide with AI", cls: "comsift-ghost-border" });
      redo.onclick = () => {
        const pending = [...new Set(previous.map(choice => choice.source.id))].map(id => {
          const choices = previous.filter(choice => choice.source.id === id);
          return { source: choices[0].source, candidates: choices.map(choice => choice.candidate), reasoned: choices[0].reasoned };
        });
        this.reviewDecisions(this.ai, pending, true);
      };
    }


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
      confirmAll.title = `Confirm undecided pairs scoring ≥ ${input.value}.`;
      rejectAll.title = `Reject undecided pairs scoring < ${input.value}.`;
      confirmAll.disabled = confirm.length === 0;
      rejectAll.disabled = reject.length === 0;
      decideAll.textContent = `Ask ${this.ai} about ${open.length} open`;
      decideAll.title = `Review ${this.ai} decisions for all open records.`;
      decideAll.disabled = open.length === 0 || !resolveDecisionSettings(this.plugin.setting).ollamaModel.trim();
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
          this.reviews[`${pair.left_id} → ${pair.right_id}`] = { status: kind === "confirm" ? "confirmed" : "rejected", pending: true };
          done++;
        }
        return done;
      }, async count => {
        this.render();
        this.setStatus(`${kind === "confirm" ? "Confirmed" : "Rejected"} ${count}.`);
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

    const sweep = (engine: string, decide: (source: ProfileRecord, candidates: ProfileRecord[], signal: AbortSignal) => Promise<ReasonedResult>) => {
      const label = `${engine} is deciding…`;
      const pending: PendingDecision[] = [];
      const skipped: string[] = [];
      let shown = false;
      const finish = () => {
        if (shown) return;
        shown = true;
        this.render();
        this.reviewDecisions(engine, pending);
        if (skipped.length) {
          const summary = `${skipped.length} failed; ${pending.length} ready to review.`;
          this.setStatus(summary);
          new Notice(`${summary}\n${skipped.join("\n")}`, 12000);
        }
      };
      this.job(label, async signal => {
        for (const [id, pairs] of open) {
          if (signal.aborted) break;
          const source = records.get(id)!;
          const candidates = pairs.map(pair => records.get(pair.right_id)).filter((c): c is ProfileRecord => !!c);
          this.setStatus(`${label} ${pending.length + 1}/${open.length}`);
          try {
            const outcome = await decide(source, candidates, signal);
            this.reasoned.set(id, outcome);
            pending.push({ source, candidates, reasoned: outcome });
          } catch (error) {
            if (signal.aborted || (error instanceof Error && error.name === "AbortError")) break;
            if (!(error instanceof DecisionAttemptsError)) throw error;
            skipped.push(`${who(source)}: ${error.message}`);
          }
        }
        return pending.length;
      }, finish);
      // A cancelled sweep still offers what was decided so far.
      const controller = this.controller;
      controller?.signal.addEventListener("abort", () => window.setTimeout(() => { if (pending.length) finish(); }, 0), { once: true });
    };
    decideAll.onclick = () => sweep(this.ai, async (source, candidates, signal) =>
      this.cachedReason(source, candidates) ?? await this.plugin.analysis.reason(this.resultItem, source, candidates, result, false, signal, { previous: this.previousChoiceContext(result) }));
    refresh();
  }

  private sourceState(sourceId: string, matches: CandidatePair[]): ReviewStatus | "todo" {
    const states = matches.map(pair => this.reviewOf(sourceId, pair.right_id)).filter((s): s is ReviewStatus => !!s);
    if (!states.length) return "todo";
    return states.includes("confirmed") ? "confirmed" : states.includes("related") ? "related" : states.includes("uncertain") ? "uncertain"
      : states.includes("later") ? "later" : "rejected";
  }

  private matchesFilter(state: ReviewStatus | "todo", pending = false): boolean {
    if (this.filter === "open" && pending) return true;
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
      .filter(row => this.matchesFilter(row.state, row.matches.some(pair => this.reviews[`${pair.left_id} → ${pair.right_id}`]?.pending)) && (!needle || (label(row.record) + " " + row.record.dataset).toLowerCase().includes(needle)))
      .sort((a, b) => {
        if (this.showLow) {
          const low = (row: { matches: CandidatePair[] }) => Number(row.matches.some(pair => pairScore(pair) < this.plugin.setting.splinkThreshold));
          const order = low(b) - low(a);
          if (order) return order;
        }
        return b.score - a.score;
      });
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
        attr: { title: "Reopen reviewed pairs and remove their generated graph links." } });
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

    let limit = 300;
    const draw = () => {
      list.empty();
      const rows = this.sourceRows(result);
      if (!rows.length) list.createDiv({ cls: "comsift-empty", text: "Nothing matches this filter." });
      for (const row of rows.slice(0, limit)) {
        const entry = list.createDiv({ cls: "comsift-source" + (row.id === this.selectedSource ? " is-selected" : "") });
        const top = entry.createDiv({ cls: "comsift-source-top" });
        top.createSpan({ cls: "comsift-source-name", text: `${label(row.record)} (${datasetLabel(row.record.dataset)})` });
        top.createSpan({ cls: `comsift-chip is-${row.state}`, text: row.state === "todo" ? "new" : REVIEW_LABELS[row.state] });
        entry.createDiv({ cls: "comsift-source-meta",
          text: `${row.record.dataset.split("/").at(-1)} · row ${row.record.row} · ${row.matches.length} candidate${row.matches.length === 1 ? "" : "s"} · top ${row.score.toFixed(2)}` });
        entry.onclick = () => { this.selectedSource = row.id; this.resetDetailScroll = true; this.render(); };
      }
      if (rows.length > limit) list.createEl("button", { text: `Show more (${rows.length - limit} remaining)` }).onclick = () => { limit += 300; draw(); };
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
      host.createDiv({ cls: "comsift-empty", text: "Select a record to compare candidates." });
      return;
    }
    const matches = result.pairs.filter(pair => pair.left_id === source.id);
    const candidates = matches.map(pair => records.get(pair.right_id)).filter((c): c is ProfileRecord => !!c);

    const head = host.createDiv({ cls: "comsift-detail-head" });
    head.createEl("h3", { text: label(source) });
    head.createDiv({ cls: "comsift-source-meta", text: `${source.dataset} · row ${source.row}${source.section ? ` · ${source.section}` : ""}` });
    const ai = this.ai;
    const saved = this.cachedReason(source, candidates);
    const ask = head.createEl("button", { text: saved ? `Ask ${ai} again` : `Ask ${ai}`, cls: "mod-cta",
      attr: { title: `Ask ${ai} to pick a match, then review its answer before anything is saved.` } });
    ask.disabled = !candidates.length || !resolveDecisionSettings(this.plugin.setting).ollamaModel.trim();
    ask.onclick = () => this.job(`${ai} is deciding…`, async signal => {
      const outcome = await this.plugin.analysis.reason(this.resultItem, source, candidates, result, false, signal, { previous: this.previousChoiceContext(result) });
      this.reasoned.set(source.id, outcome);
      return outcome;
    }, outcome => {
      this.render();
      this.reviewDecisions(ai, [{ source, candidates, reasoned: outcome }]);
    });

    if (saved) {
      head.createEl("button", { text: "Redecide with AI" }).onclick = () =>
        this.reviewDecisions(ai, [{ source, candidates, reasoned: saved }], true);
      head.createEl("button", { text: "Reopen AI review" }).onclick = () =>
        this.reviewDecisions(ai, [{ source, candidates, reasoned: saved }]);
      head.createEl("button", { text: this.reasoningSource === source.id ? "Hide AI reasoning" : "Show AI reasoning" }).onclick = () => {
        this.reasoningSource = this.reasoningSource === source.id ? null : source.id; this.render();
      };
      if (this.reasoningSource === source.id) this.renderDecision(host, saved, source);
    }

    const sorted = [...matches].sort((x, y) => {
      if (this.showLow) {
        const order = Number(pairScore(x) >= this.plugin.setting.splinkThreshold) - Number(pairScore(y) >= this.plugin.setting.splinkThreshold);
        if (order) return order;
      }
      return pairScore(y) - pairScore(x);
    });
    for (const pair of sorted) {
      const candidate = records.get(pair.right_id);
      if (candidate) this.renderCandidate(host, source, candidate, pair, result);
    }
  }

  private renderDecision(host: HTMLElement, result: ReasonedResult, source: ProfileRecord) {
    const block = host.createDiv({ cls: "comsift-decision" });
    const chosen = result.decision.candidate_id;
    const modelVerdict = result.decision.verdicts?.find(entry => entry.candidate_id === chosen)?.verdict;
    const status = chosen === "NO_MATCH" ? "rejected" : modelVerdict === "related" ? "related" : (result.decision.uncertain ? "uncertain" : "confirmed");
    const verdict = chosen === "NO_MATCH" ? "Rejected all candidates" : `${status.charAt(0).toUpperCase() + status.slice(1)}: ${chosen}`;
    const title = block.createDiv({ cls: "comsift-decision-title" });
    title.createSpan({ text: `${result.engine?.replace(/Ollama/g, "AI") ?? this.ai} · ${verdict}` });
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
      block.createDiv({ cls: "comsift-note", text: "Jina ranks a different candidate first." });
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
      row.createEl("td", { text: a || "-" });
      row.createEl("td", { text: b || "-" });
    }

    const actions = card.createDiv({ cls: "comsift-review-actions" });
    if (current) {
      const reopen = actions.createEl("button", { text: "Reopen", cls: "comsift-ghost" });
      reopen.onclick = () => this.job("Reopening pair…", () => this.unreviewPair(source, candidate), () => {
        this.render();
      });
    }
    const hint = card.createDiv({ cls: "comsift-hint",
      text: current ? reviewHint(current, source, candidate) : "Choose a status." });
    for (const status of ["confirmed", "related", "rejected", "uncertain", "later"] as const) {
      const button = actions.createEl("button", { text: REVIEW_LABELS[status], cls: current === status ? "is-active" : "",
        attr: { title: reviewHint(status, source, candidate) } });
      const idle = hint.textContent;
      button.onmouseenter = button.onfocus = () => { hint.textContent = reviewHint(status, source, candidate); };
      button.onmouseleave = button.onblur = () => { hint.textContent = idle; };
      button.onclick = () => this.job("Saving choice…", () => this.reviewPair(source, candidate, status), () => {
        this.render();
        this.setStatus(reviewHint(status, source, candidate));
      });
    }
    if (this.reviews[`${source.id} → ${candidate.id}`]?.pending) {
      actions.createEl("button", { text: "Confirm now", cls: "mod-cta" }).onclick = () => this.applyChoices(this.stagedChoices(this.visibleResult()).filter(choice => choice.source.id === source.id && choice.candidate.id === candidate.id)).catch(error => this.fail(error));
    }
  }

  private stagedChoices(result: AnalysisResult): ReviewedChoice[] {
    const records = new Map(result.records.map(record => [record.id, record]));
    return loadedPairs(result).flatMap(pair => {
      const review = this.reviews[`${pair.left_id} → ${pair.right_id}`];
      const source = records.get(pair.left_id), candidate = records.get(pair.right_id);
      if (!review?.pending || !source || !candidate) return [];
      const reasoned = this.reasoned.get(source.id) ?? { decision: { candidate_id: candidate.id,
        explanation: "Chosen during review.", supporting_evidence: [], conflicting_evidence: [], uncertain: review.status === "uncertain" }, interpretation: [] };
      return [{ ...defaultChoices({ source, candidates: [candidate], reasoned })[0], status: review.status }];
    });
  }

  private showStagedSummary(result: AnalysisResult) {
    const choices = this.stagedChoices(result);
    if (!choices.length) return;
    new DecisionReviewModal(this.app, [], "Review summary", selections => this.applyChoices(selections),
      selections => {
        void (async () => {
          for (const choice of selections) {
            if (this.reviewOf(choice.source.id, choice.candidate.id) !== choice.status) await this.reviewPair(choice.source, choice.candidate, choice.status);
          }
          this.render();
        })().catch(error => this.fail(error));
      }, undefined, choices, selections => this.summarizeChoices(selections), undefined, "summary").open();
  }

  private async summarizeChoices(choices: ReviewedChoice[]): Promise<string> {
    const { summarizeAnalysis } = await import("./summaryAi");
    const profile = { ...DEFAULT_MODEL_PROFILE, ...this.plugin.setting.analysisSummaryModel };
    const settings = { ...(profile.inherit ? parentSettings(this.plugin.setting, profile.inheritFrom ?? "chat") : profile), ollamaThink: profile.ollamaThink };
    const data = choices.map(choice => {
      const original = defaultChoices({ source: choice.source, candidates: [choice.candidate], reasoned: choice.reasoned })[0];
      return { source: decisionProfile(this.plugin.setting, choice.source), candidate: decisionProfile(this.plugin.setting, choice.candidate),
        status: choice.status, ai_status: original.status, user_changed: choice.status !== original.status,
        reasoning: choice.reason, explanation: choice.reasoned.decision.explanation,
        supporting_evidence: choice.reasoned.decision.supporting_evidence, conflicting_evidence: choice.reasoned.decision.conflicting_evidence };
    });
    return summarizeAnalysis(this.plugin, settings, profile.prompt, { main_person: this.resultItem?.folderPath.split("/").pop(), choices: data });
  }

  private bar(parent: HTMLElement, name: string, value: number, text: string) {
    const row = parent.createDiv({ cls: "comsift-bar-row" });
    row.createSpan({ cls: "comsift-bar-name", text: name });
    const track = row.createDiv({ cls: "comsift-bar" });
    track.createDiv({ cls: "comsift-bar-fill" }).style.width = `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
    row.createSpan({ cls: "comsift-bar-text", text });
  }

  public importConversation(messages: ChatMessage[], prompt = "", folder = "") {
    if (this.controller) throw new Error("Finish the current chat request before importing a conversation.");
    for (const reject of this.pendingEdits) reject();
    this.pendingEdits.clear();
    this.chatHistory = messages.filter((turn): turn is ChatEntry => turn.role === "user" || turn.role === "assistant").map(turn => ({ ...turn, content: turn.role === "assistant" ? stripExecutableProposals(turn.content) : turn.content }));
    this.chatFolder = folder || "/";
    this.chatFile = null;
    this.tab = "chat";
    this.render();
    if (this.composerInput) this.composerInput.value = prompt;
    publishConversation(this.plugin, "chat", this.chatHistory, this.chatFolder);
  }

  private offerCanvasHandoff(path: string, prompt: string) {
    const box = this.messageHost?.createDiv({ cls: "comsift-handoff" });
    if (!box) return;
    box.createEl("strong", { text: `Continue in Canvas · ${path}` });
    const editor = box.createEl("textarea", { attr: { "aria-label": "Canvas handoff prompt", rows: "4" } });
    editor.value = prompt;
    const open = box.createEl("button", { text: "Open Canvas chat", cls: "mod-cta" });
    const cancel = box.createEl("button", { text: "Cancel" });
    cancel.onclick = () => box.remove();
    open.onclick = () => {
      if (!editor.value.trim()) return;
      open.disabled = true;
      void openCanvasConversation(this.plugin, path, this.chatHistory, editor.value.trim()).then(() => box.remove()).catch(error => { open.disabled = false; this.fail(error); });
    };
  }

  // ----------------------------------------------------------------- chat

  private renderChat(shell: HTMLElement) {
    publishConversation(this.plugin, "chat", this.chatHistory, this.chatFolder);
    const bar = shell.createDiv({ cls: "comsift-toolbar" });
    const folders = bar.createEl("select", { attr: { "aria-label": "Folder the assistant works in" } });
    const items = Object.values(this.plugin.state.investigations);
    const known = new Set(items.map(item => item.folderPath));
    folders.createEl("option", { text: "Vault", value: "/" });
    known.add("/");
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
    const gather = bar.createEl("label", { cls: "comsift-toggle" });
    const gatherBox = gather.createEl("input", { type: "checkbox" });
    gatherBox.checked = this.plugin.setting.chatContextAssistantEnabled;
    gather.appendText(" Context assistant");
    gatherBox.onchange = () => { this.plugin.setting.chatContextAssistantEnabled = gatherBox.checked; void this.plugin.saveSettings(); };
    bar.createEl("button", { text: "Mention Canvas chat" }).onclick = () => {
      const snapshot = latestConversation(this.plugin, "canvas");
      if (!snapshot) { this.setStatus("No Canvas conversation yet."); return; }
      if (this.composerInput) this.composerInput.value += `${this.composerInput.value ? "\n\n" : ""}${conversationMention(snapshot)}`;
    };
    bar.createEl("button", { text: "Continue in Canvas" }).onclick = () => {
      const picker = new ChatModal(this.plugin, this.app.vault.getFiles().filter(file => file.extension === "canvas"), file => this.offerCanvasHandoff(file.path, this.composerInput?.value.trim() || "Continue this conversation on this Canvas."));
      picker.setPlaceholder("Choose a Canvas board"); picker.open();
    };
    const think = bar.createEl("label", { cls: "comsift-toggle", attr: { title: "Let reasoning models think before answering. Slower, and may run out of tokens before answering." } });
    const thinkBox = think.createEl("input", { type: "checkbox" });
    thinkBox.checked = this.plugin.setting.ollamaThink;
    const syncThink = () => { thinkBox.checked = this.plugin.setting.ollamaThink; };
    this.registerDomEvent(window, "focus", syncThink);
    thinkBox.addEventListener("focus", syncThink);
    thinkBox.onchange = () => { this.plugin.setting.ollamaThink = thinkBox.checked; void this.plugin.saveSettings(); };
    think.createSpan({ text: " Think" });
    contextSlider(bar, this.plugin.setting.ollamaContext, value => {
      this.plugin.setting.ollamaContext = value;
      void this.plugin.saveSettings();
    }, cleanup => this.paintCleanups.push(cleanup));
    bar.createEl("button", { text: "Edit history" }).onclick = () => {
      void this.plugin.analysis.recentEdits().then(edits => {
        const history = this.messageHost?.createDiv({ cls: "comsift-edit-history" });
        if (!history) return;
        history.createEl("strong", { text: "Local note revisions" });
        if (!edits.length) history.createDiv({ text: "No approved edits yet." });
        for (const edit of edits) {
          const row = history.createDiv(); row.createSpan({ text: edit.path });
          const undo = row.createEl("button", { text: "Undo" });
          undo.onclick = () => { undo.disabled = true; void this.plugin.analysis.undoEdit(edit).then(() => row.remove()).catch(error => { undo.disabled = false; this.fail(error); }); };
        }
      }).catch(error => this.fail(error));
    };
    bar.createEl("button", { text: "New chat" }).onclick = () => { for (const reject of this.pendingEdits) reject(); this.pendingEdits.clear(); this.chatHistory = []; this.chatFile = null; this.render(); };
    const save = bar.createEl("button", { text: this.chatFile ? "Saved ✓" : "Save chat",
      attr: { title: "Saves this conversation as a readable Markdown note in <folder>/Chats/. New replies are saved automatically." } });
    save.onclick = () => {
      if (!this.chatHistory.length) { this.setStatus("Nothing to save yet."); return; }
      void this.plugin.analysis.saveChat(this.chatFolder, this.chatFile, this.chatHistory).then(path => {
        this.chatFile = path;
        save.textContent = "Saved ✓";
        this.setStatus("");
      }).catch(error => this.fail(error));
    };
    bar.createEl("button", { text: "Load chat" }).onclick = () => {
      const files = this.plugin.analysis.listChats();
      if (!files.length) return this.setStatus("No saved chats yet. Save a conversation first.");
      new ChatModal(this.plugin, files, file => void this.plugin.analysis.loadChat(file.path).then(log => {
        if (log.folder) this.chatFolder = log.folder;
        this.chatHistory = log.messages;
        this.chatFile = file.path;
        this.render();
        this.setStatus("");
      }).catch(error => this.fail(error))).open();
    };
    const stop = bar.createEl("button", { text: "Stop" });
    stop.dataset.cancel = "true"; stop.dataset.stop = "chat"; stop.disabled = this.jobKind !== "chat";
    stop.onclick = () => { if (this.jobKind === "chat") this.controller?.abort(); };

    this.chatReplies.clear();
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
        text: "Ask about your notes or request changes. Type @ to include a file or folder." });
    }
    for (const [index, entry] of this.chatHistory.entries()) {
      const bubble = this.addMessage(entry.role, entry.content, false, index);
      if (entry.role === "assistant") this.lastReply = bubble;
    }

    const composer = shell.createDiv({ cls: "comsift-composer" });
    const input = composer.createEl("textarea", { attr: { placeholder: "Ask a question or request a change…" } });
    this.composerInput = input;
    const chooseFile = () => {
      const files = this.app.vault.getFiles().filter(file => ["md", "txt", "csv", "json", "canvas"].includes(file.extension.toLowerCase()) && !file.path.split("/").some(part => part.startsWith(".")));
      const scope = this.plugin.investigations.forPath(this.chatFolder)?.folderPath ?? this.chatFolder;
      const folders = this.app.vault.getAllFolders(false).filter(folder => !folder.path.split("/").some(part => part.startsWith(".")));
      const items: Mention[] = prioritizeMentionFiles([...folders.map(folder => ({ path: folder.path, folder: true })), ...files.map(file => ({ path: file.path, folder: false }))], scope);
      const picker = new MentionModal(this.plugin, items, item => {
        const start = input.selectionStart;
        const before = input.value.slice(0, start).replace(/@$/, "");
        const insertion = `@[[${item.path}${item.folder ? "/" : ""}]] `;
        input.value = before + insertion + input.value.slice(input.selectionEnd);
        input.focus(); input.setSelectionRange(before.length + insertion.length, before.length + insertion.length);
      });
      picker.setPlaceholder("Include a file or folder"); picker.open();
    };
    const send = composer.createEl("button", { text: "Send", cls: "mod-cta" });
    const submit = (replacement?: string, retry = false) => {
      const question = (replacement ?? input.value).trim();
      if (!question || this.controller) return;
      for (const reject of this.pendingEdits) reject();
      this.pendingEdits.clear();
      let prior: ChatMessage[];
      let previous: string[] = [];
      let reply: ReturnType<AnalysisView["addMessage"]>;
      // Retry regenerates the last answer inside the same message. The old answer is kept as an earlier variant
      // and is not part of the context for the new one.
      if (retry && this.lastReply && this.chatHistory.at(-1)?.role === "assistant" && this.chatHistory.at(-2)?.role === "user") {
        const old = this.chatHistory.pop()!;
        previous = old.variants ?? [old.content];
        this.chatHistory[this.chatHistory.length - 1].content = question;
        prior = this.chatHistory.slice(0, -1).map(({ role, content }) => ({ role, content }));
        reply = this.lastReply; reply.reset();
      } else {
        prior = this.chatHistory.map(({ role, content }) => ({ role, content }));
        this.chatHistory.push({ role: "user", content: question });
        publishConversation(this.plugin, "chat", this.chatHistory, this.chatFolder);
        this.messageHost!.querySelector(".comsift-empty")?.remove();
        this.addMessage("user", question, false);
        input.value = "";
        reply = this.addMessage("assistant", "", true);
        this.lastReply = reply;
      }
      const trace: TraceSink | undefined = this.plugin.setting.showDetails ? reply.trace() : undefined;
      let timer: number | null = null;
      let latest = "";
      const paint = () => {
        timer = null;
        const handoff = /<canvas-handoff\b/i.test(latest);
        const { text, pendingEdit } = visibleWhileStreaming(latest.replace(/<canvas-handoff\b[\s\S]*/i, "").replace(/<([a-z-]{0,16})$/i, (all, name: string) => "canvas-handoff".startsWith(name.toLowerCase()) || "canvas".startsWith(name.toLowerCase()) ? "" : all));
        reply.setMarkdown(text + (handoff ? "\n\n*Preparing the Canvas handoff…*" : pendingEdit ? "\n\n*Drafting a change…*" : ""));
      };
      let reasoning = "";
      this.job("Thinking…", signal => this.plugin.analysis.chat(this.folders(), question, prior, text => {
        latest = text;
        if (timer === null) timer = window.setTimeout(paint, 120);
      }, this.plugin.app.workspace.getActiveFile()?.path ?? null, signal, thought => {
        reasoning = thought;
        reply.setThinking(thought);
        if (!latest) reply.setMarkdown("*Thinking…*");
      }, null, trace), ({ answer, context, edits: toolEdits = [], handoffs: toolHandoffs = [], toolResults = [] }) => {
        if (timer !== null) window.clearTimeout(timer);
        if (!answer.trim() && !toolEdits.length && !toolHandoffs.length && !toolResults.length) {
          const note = reasoning
            ? "The model spent its whole budget on reasoning and returned no answer. Turn **Think** off or increase the output token limit in settings."
            : "The model returned no text. Check that the selected model supports chat, then try again.";
          if (previous.length) this.chatHistory.push({ role: "assistant", content: previous.at(-1)!, ...(previous.length > 1 ? { variants: previous } : {}) });
          else this.chatHistory.pop();
          reply.setMarkdown(note);
          this.setStatus("Empty answer.");
          return;
        }
        const handoffs: Array<{ path: string; prompt: string }> = [...toolHandoffs];
        const cleanAnswer = answer.replace(/<canvas-handoff\b[^>]*>[\s\S]*?(?:<\/canvas-handoff>|$)/gi, "");
        const boards = parseCanvasEdits(unwrapToolFences(cleanAnswer));
        const parsed = parseEdits(boards.text);
        const edits = toolEdits;
        const changes = edits.length;
        const stored = parsed.text || (changes ? "Proposed changes (review cards are not saved)." : "No text response.");
        const variants = [...previous, stored];
        this.chatHistory.push({ role: "assistant", content: stored, ...(variants.length > 1 ? { variants } : {}) });
        reply.setVariants(variants, variants.length - 1);
        publishConversation(this.plugin, "chat", this.chatHistory, this.chatFolder);
        for (const handoff of handoffs) this.offerCanvasHandoff(handoff.path, handoff.prompt);
        reply.setMarkdown(parsed.text || (changes ? "Review the proposed file below." : handoffs.length ? "Review the Canvas prompt below." : ""));
        reply.showTools(toolResults);
        reply.finalize(`Context: ${context.files.length + context.canvases.length} files` +
          (context.bridges.length ? `, ${context.bridges.length} linking the folders` : "") +
          (context.omitted ? `, ${context.omitted} omitted for size` : ""),
          [...context.canvases.map(canvas => canvas.path), ...context.files.map(file => file.role === "folder" ? file.path : `${file.path}  (${file.role})`)]);
        for (const edit of edits) this.showEdit(edit);
        const base = changes ? "Review changes." : "";
        this.setStatus(base);
        if (this.chatFile) void this.plugin.analysis.saveChat(this.chatFolder, this.chatFile, this.chatHistory).catch(error => this.fail(error));
        if (this.plugin.setting.aiProvider === "openai") return;
        void this.plugin.analysis.running().then(models => {
          const used = models.find(model => model.name === this.plugin.setting.ollamaModel) ?? models[0];
          if (!used || !used.size) return;
          const gpu = Math.round(used.vram / used.size * 100);
          this.setStatus(`${base}  ·  ${used.name}: ${100 - gpu}% CPU / ${gpu}% GPU${gpu < 50 ? ", not enough free GPU memory when it loaded" : ""}`);
        }).catch(() => { /* informational only */ });
      }, (error, cancelled) => {
        if (timer !== null) window.clearTimeout(timer);
        if (previous.length) { this.chatHistory.push({ role: "assistant", content: previous.at(-1)!, ...(previous.length > 1 ? { variants: previous } : {}) }); reply.setVariants(previous, previous.length - 1); }
        else if (this.chatHistory.at(-1)?.role === "user") this.chatHistory.pop();
        reply.setMarkdown(previous.length ? previous.at(-1)! : cancelled ? "Cancelled." : (error as Error).message || "The request failed.");
        if (!cancelled) reply.showError(error);
      }, "chat");
    };
    this.submitChat = (question, retry) => submit(question, retry);
    send.onclick = () => submit();
    input.onkeydown = event => {
      if (event.key === "@" && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); chooseFile(); return; }
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
    };
    input.focus();
  }

  private addMessage(role: "user" | "assistant", markdown: string, live: boolean, index = this.chatHistory.length - (role === "user" ? 1 : 0)) {
    const host = this.messageHost!;
    const wrap = host.createDiv({ cls: `comsift-msg is-${role}` });
    const head = wrap.createDiv({ cls: "comsift-msg-head" });
    head.createSpan({ text: role === "user" ? "You" : "Assistant" });
    let raw = markdown;
    const retryPrompt = (prompt: string) => {
      if (this.controller || !this.submitChat) return false;
      const answer = this.chatReplies.get(index + 1);
      if (answer && this.chatHistory[index]?.role === "user") {
        this.chatHistory.splice(index + 2);
        answer.removeFollowing();
        this.lastReply = answer;
        this.chatHistory[index].content = prompt;
      }
      raw = prompt;
      this.submitChat(prompt, !!answer);
      return true;
    };
    const actions = head.createDiv({ cls: "comsift-msg-actions" });
    const copy = chatIconButton(actions, "copy", "Copy");
    copy.onclick = () => void navigator.clipboard.writeText(raw).then(() => {
      copy.setAttribute("aria-label", "Copied"); copy.setAttribute("title", "Copied");
      window.setTimeout(() => { copy.setAttribute("aria-label", "Copy"); copy.setAttribute("title", "Copy"); }, 1200);
    }).catch(error => this.fail(error));
    if (role === "user") {
      const retry = chatIconButton(actions, "rotate-ccw", "Retry");
      this.retryButton?.hide(); this.retryButton = retry;
      retry.onclick = () => { retryPrompt(raw); };
      const edit = chatIconButton(actions, "pencil", "Edit prompt");
      edit.onclick = () => openEditor();
    }
    const content = wrap.createDiv({ cls: "comsift-prose markdown-rendered" });
    const meta = wrap.createDiv({ cls: "comsift-msg-meta" });
    const thought = role === "assistant" ? wrap.createEl("details", { cls: "comsift-thinking" }) : null;
    if (thought) thought.hidden = true;
    const thoughtSummary = thought?.createEl("summary", { text: "Thinking" });
    const thoughtText = thought?.createEl("pre");
    const renderer = chatMarkdown(this.app, content, this.chatFolder, this.rendering, error => this.fail(error));
    this.paintCleanups.push(renderer.dispose);
    let versions: string[] = [];
    const bar = role === "assistant" ? variantBar(actions, versionIndex => {
      const entry = this.chatHistory[index];
      setMarkdown(versions[versionIndex]);
      if (entry?.role === "assistant") entry.content = versions[versionIndex];
      meta.hidden = versionIndex !== versions.length - 1;
      wrap.querySelectorAll<HTMLElement>(".comsift-trace, .comsift-error-details, .comsift-thinking").forEach(node => { node.hidden = versionIndex !== versions.length - 1; });
    }) : null;
    const setMarkdown = (value: string) => {
      raw = value;
      renderer.setMarkdown(value);
      host.scrollTop = host.scrollHeight;
    };
    const openEditor = inlinePromptEditor(content, () => raw, () => setMarkdown(raw), prompt => {
      return retryPrompt(prompt);
    }, renderer.clear, this);
    this.paintCleanups.push(openEditor.dispose);
    if (markdown || !live) setMarkdown(markdown);
    else content.setText("…");
    const showThought = throttleText(value => {
      if (!thought || !thoughtSummary || !thoughtText) return;
      thought.hidden = !value;
      thoughtSummary.setText(value ? `Thinking · ${value.length} characters` : "Thinking");
      thoughtText.setText(value);
    });
    const bubble = {
      removeFollowing: () => { while (wrap.nextElementSibling) wrap.nextElementSibling.remove(); },
      setMarkdown,
      setThinking: showThought,
      /** Start a regenerated answer in this same message. */
      reset: () => { meta.empty(); meta.hidden = false; meta.parentElement?.querySelectorAll(".comsift-trace, .comsift-error-details").forEach(node => node.remove()); showThought(""); if (thought) thought.hidden = true; content.setText("…"); },
      setVariants: (list: string[], index: number) => { versions = list; bar?.set(list.length, index); },
      trace: () => traceDetails(wrap),
      showError: (error: unknown) => { errorDetails(wrap, error, this.plugin.setting.showDetails); },
      showTools: (results: ChatToolOutput[]) => {
        if (!results.length) return;
        const details = meta.createEl("details", { cls: "comsift-tool-results" });
        details.createEl("summary", { text: `Tools · ${results.length}` });
        for (const result of results) details.createDiv({ text: result.summary, cls: result.status === "error" ? "comsift-tool-error" : "comsift-tool-result" });
      },
      finalize: (summary: string, paths: string[]) => {
        const details = meta.createEl("details");
        details.createEl("summary", { text: summary });
        details.createDiv({ text: paths.join("\n"), cls: "comsift-paths" });
      },
    };
    if (role === "assistant") this.chatReplies.set(index, bubble);
    return bubble;
  }

  private showEdit(edit: ProposedEdit) {
    const panel = this.messageHost!.createDiv({ cls: "comsift-edit" });
    const title = panel.createDiv({ cls: "comsift-edit-title" });
    const verb = edit.action === "create" ? "Create" : edit.action === "patch" ? "Patch" : edit.action === "append" ? "Append" : edit.action === "delete" ? "Delete" : "Rewrite";
    title.createSpan({ text: `${verb} ${edit.path}` });
    const body = panel.createDiv({ cls: "comsift-edit-body" });
    const actions = panel.createDiv({ cls: "comsift-review-actions" });
    let prepared: PreparedEdit;
    let discarded = false;
    let disposePreview = () => {};
    const discard = () => { discarded = true; disposePreview(); this.pendingEdits.delete(discard); panel.remove(); };
    this.pendingEdits.add(discard);
    void this.plugin.analysis.prepareEdit(this.folders(), edit).then(ready => {
      if (discarded) return;
      prepared = ready;
      if (ready.path !== edit.path) title.createSpan({ cls: "comsift-note", text: ` → ${ready.path} (portable filename)` });
      const preview = body.createDiv({ cls: "comsift-file-preview" });
      const renderer = chatMarkdown(this.app, preview, ready.path, this.rendering, error => this.fail(error));
      this.paintCleanups.push(renderer.dispose);
      disposePreview = renderer.dispose;
      if (ready.isDelete) preview.createDiv({ cls: "comsift-note", text: `${ready.path} will be moved to the trash. Undo restores it.` });
      else renderer.setMarkdown(ready.after);
      const source = body.createEl("details");
      source.createEl("summary", { text: "Changes" });
      this.drawDiff(source.createDiv(), ready);
      const apply = actions.createEl("button", { text: ready.isDelete ? "Delete" : "Apply", cls: ready.isDelete ? "mod-warning" : "mod-cta" });
      const reject = actions.createEl("button", { text: "Reject" });
      reject.onclick = discard;
      apply.onclick = () => {
        if (discarded || apply.disabled) return;
        apply.disabled = true; reject.disabled = true;
        void this.plugin.analysis.commitEdit(prepared).then(() => {
        this.pendingEdits.delete(discard);
        actions.empty();
        title.createSpan({ cls: "comsift-chip is-confirmed", text: prepared.isDelete ? "deleted" : "applied" });
        if (!prepared.isDelete) {
          const open = actions.createEl("button", { text: "Open file" });
          open.onclick = () => void this.plugin.app.workspace.openLinkText(prepared.path, "", true);
        }
        const undo = actions.createEl("button", { text: "Undo" });
        undo.onclick = () => void this.plugin.analysis.undoEdit(prepared).then(() => {
          disposePreview(); panel.remove();
          this.setStatus(`Reverted ${prepared.path}.`);
        }).catch(error => this.fail(error));
      }).catch(error => { apply.disabled = false; reject.disabled = false; this.fail(error); });
      };
    }).catch(error => {
      if (discarded) return;
      body.createDiv({ cls: "comsift-note", text: (error as Error).message });
      actions.createEl("button", { text: "Dismiss" }).onclick = discard;
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
