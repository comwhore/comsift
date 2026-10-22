import { registerReviewSession, forgetReviewSession } from "./reviewSessions";
import { chatMarkdown } from "./chatMarkdown";
import { App, Component, Modal, setIcon, type WorkspaceLeaf } from "obsidian";
import type { ProfileRecord } from "./runner";
import type { ReasonedResult, ReviewStatus } from "./service";
import type { Verdict } from "./ollama";

export interface PendingDecision {
  source: ProfileRecord;
  candidates: ProfileRecord[];
  reasoned: ReasonedResult;
}

/** One card: a single source and candidate pair with its own status. */
export interface ReviewedChoice {
  source: ProfileRecord;
  candidate: ProfileRecord;
  status: ReviewStatus;
  reasoned: ReasonedResult;
  reason: string;
}

const STATUS_LABELS: Record<ReviewStatus, string> = {
  confirmed: "Same person", related: "Related", uncertain: "Uncertain", rejected: "Rejected", later: "Later",
};
const STATUS_ORDER: ReviewStatus[] = ["confirmed", "related", "uncertain", "rejected", "later"];
const VERDICT_STATUS: Record<Verdict, ReviewStatus> = { same: "confirmed", related: "related", uncertain: "uncertain", different: "rejected" };

function name(record: ProfileRecord): string {
  const f = record.fields;
  const base = f.display_name || f.username || f.name || record.id;
  return f.platform ? `${base} (${f.platform})` : base;
}

/** Cards start from the model's verdicts. Saved decisions without verdicts fall back to their single pick. Never "later". */
export function defaultChoices(entry: PendingDecision): ReviewedChoice[] {
  const decision = entry.reasoned.decision;
  return entry.candidates.map(candidate => {
    const verdict = decision.verdicts?.find(item => item.candidate_id === candidate.id);
    const status: ReviewStatus = verdict ? VERDICT_STATUS[verdict.verdict]
      : decision.candidate_id !== candidate.id ? "rejected" : decision.uncertain ? "uncertain" : "confirmed";
    return { source: entry.source, candidate, status, reasoned: entry.reasoned, reason: verdict?.reason || decision.explanation };
  });
}

/**
 * Overview of what the model decided before anything is written: a card for every candidate
 * with quick buttons to change its status, and one confirm button.
 */
export interface RedecideOptions { model: string; prompt: string }
export interface ReviewTools {
  model: string;
  prompt: string;
  models?: () => Promise<string[]>;
  redecide: (choices: ReviewedChoice[], options: RedecideOptions) => Promise<ReviewedChoice[]>;
}

export class DecisionReviewModal extends Modal {
  private renderOwner = new Component();
  private summaryRenderer: ReturnType<typeof chatMarkdown> | null = null;
  private renderVersion = 0;
  private aiSummary = "";
  private choices: ReviewedChoice[];
  private initial: ReviewStatus[];
  private confirmed = false;
  private rejected = false;
  private hidden = new Set<ReviewStatus>();
  private busy: "confirm" | "visible" | "redecide" | null = null;
  private errorText = "";
  private summaryPending = false;
  private summaryEpoch = 0;
  private redecideOpen = false;
  private redecideStatuses = new Set(STATUS_ORDER);
  private redecideModel = "";
  private redecidePrompt = "";
  private tabHost: HTMLElement | null = null;
  private sessionId = "";
  private tabLeaf: WorkspaceLeaf | null = null;
  private sessionDetached = false;

  constructor(app: App, entries: PendingDecision[], private engine: string,
    private onConfirm: (choices: ReviewedChoice[]) => void | Promise<void>, private onCancel?: (choices: ReviewedChoice[]) => void,
    private onReject?: (sourceIds: string[]) => void, choices?: ReviewedChoice[],
    private summarize?: (choices: ReviewedChoice[]) => Promise<string>, private confirmLabel?: string,
    private reviewMode: "ai" | "summary" = "summary", private tools?: ReviewTools) {
    super(app);
    this.choices = choices ?? entries.flatMap(defaultChoices);
    this.initial = this.choices.map(choice => choice.status);
    this.redecideModel = tools?.model ?? "";
    this.redecidePrompt = tools?.prompt ?? "";
    this.modalEl.addClass("comsift-decision-review");
  }

  onOpen() {
    this.confirmed = false; this.rejected = false;
    this.modalEl.querySelector(".comsift-summary-expand")?.remove();
    this.renderOwner.load(); this.draw();
    if (this.reviewMode === "ai") return;
    const close = this.modalEl.querySelector<HTMLElement>(".modal-close-button");
    if (close) setIcon(close, "x");
    const expand = this.modalEl.createEl("button");
    expand.className = "comsift-summary-expand clickable-icon";
    expand.setAttribute("aria-label", "Open summary in new tab");
    expand.title = "Open summary in new tab"; setIcon(expand, "maximize");
    this.modalEl.querySelector(".modal-close-button")?.before(expand);
    expand.onclick = () => { void this.openTab(); };
  }

  open() {
    if (this.tabHost && this.tabLeaf) { void this.app.workspace.revealLeaf(this.tabLeaf); return; }
    super.open();
  }

  openReassessment() {
    if (!this.tools || this.busy) return;
    this.redecideOpen = true; this.draw();
  }

  draftChoices(): ReviewedChoice[] { return this.choices.map(choice => ({ ...choice })); }

  close() {
    // Obsidian routes X, backdrop and Escape through close(). Keep saves attached.
    if (this.busy && !this.tabHost) return;
    super.close();
  }

  onClose() {
    if (this.tabHost) { this.contentEl.empty(); return; }
    this.dispose();
  }

  private dispose() {
    this.renderVersion++; this.summaryRenderer?.dispose(); this.renderOwner.unload();
    this.contentEl.empty();
    if (!this.confirmed && !this.rejected) this.onCancel?.(this.choices);
    if (this.sessionId) forgetReviewSession(this.sessionId);
  }

  private snapshot(): string {
    return ["# Analysis summary", ...this.visible().map(choice =>
      `## ${name(choice.source)} → ${name(choice.candidate)}\n\n${STATUS_LABELS[choice.status]}\n\n${choice.reason}`),
      this.aiSummary ? `## AI summary\n\n${this.aiSummary}` : ""].join("\n\n");
  }

  private async openTab() {
    if (!this.sessionId) this.sessionId = registerReviewSession({
      mount: host => { this.sessionDetached = false; this.tabHost = host; host.addClass("comsift-decision-review"); this.draw(); },
      unmount: () => {
        this.tabHost = null;
        // A running save owns the controller until it settles, even if its tab is closed.
        if (!this.busy) this.dispose(); else this.sessionDetached = true;
      },
    });
    try {
      this.tabLeaf = this.app.workspace.getLeaf("tab");
      await this.tabLeaf.setViewState({ type: "comsift-review-summary", active: true,
        state: { markdown: this.snapshot(), reviewId: this.sessionId } });
      // Only dismiss after the live view mounted. A stale/missing view keeps the modal usable.
      if (this.tabHost) super.close();
    } catch (error) { this.errorText = String(error); this.draw(); }
  }

  private visible() { return this.choices.filter(choice => !this.hidden.has(choice.status)); }
  private invalidateSummary() { this.summaryEpoch++; this.aiSummary = ""; }

  private draw() {
    const contentEl = this.tabHost ?? this.contentEl;
    const version = ++this.renderVersion;
    this.summaryRenderer?.dispose(); this.summaryRenderer = null;
    // Preserve every scroll ancestor, plus expanded reasoning. Collapsing details changes
    // the list's height and clamps scrollTop before restoring it, which caused card jumps.
    const scroll: Array<[HTMLElement, number]> = [];
    for (let el: HTMLElement | null = contentEl; el; el = el.parentElement) scroll.push([el, el.scrollTop]);
    const previousList = contentEl.querySelector<HTMLElement>(".comsift-review-list");
    if (previousList) scroll.push([previousList, previousList.scrollTop]);
    const expanded = new Set(Array.from(contentEl.querySelectorAll?.<HTMLDetailsElement>("details[data-choice]") ?? [])
      .filter(el => el.open).map(el => el.dataset.choice));
    contentEl.empty();
    const sources = new Set(this.choices.map(choice => choice.source.id)).size;
    this.setTitle(`${this.engine.replace(/Ollama/g, "AI")} reviewed ${sources} record${sources === 1 ? "" : "s"}`);
    const summary = contentEl.createDiv({ cls: "comsift-review-summary" });
    for (const status of STATUS_ORDER) {
      const count = this.choices.filter(choice => choice.status === status).length;
      if (!count) continue;
      const chip = summary.createEl("button", { cls: `comsift-chip is-${status}${this.hidden.has(status) ? " is-hidden" : ""}`,
        text: `${count} ${STATUS_LABELS[status].toLowerCase()}` });
      chip.setAttribute("aria-pressed", String(!this.hidden.has(status)));
      chip.disabled = !!this.busy;
      chip.onclick = () => {
        if (this.hidden.has(status)) this.hidden.delete(status); else this.hidden.add(status);
        this.invalidateSummary(); this.draw();
      };
    }
    const list = contentEl.createDiv({ cls: "comsift-review-list" });
    let current = "";
    this.choices.forEach((choice, index) => {
      if (this.hidden.has(choice.status)) return;
      if (choice.source.id !== current) {
        current = choice.source.id;
        list.createDiv({ cls: "comsift-review-source", text: name(choice.source) });
      }
      this.card(list, choice, index, expanded.has(String(index)));
    });
    if (!this.visible().length) list.createDiv({ text: "No visible decisions. Toggle a status above to show them." });
    const footer = contentEl.createDiv({ cls: "comsift-review-footer" });
    if (this.reviewMode === "ai") {
      const cancel = footer.createEl("button", { text: "Cancel" });
      cancel.disabled = !!this.busy; cancel.onclick = () => this.close();
    }
    if (this.summarize) {
      const button = footer.createEl("button", { text: "Summarize with AI", cls: "comsift-summarize" });
      button.disabled = this.summaryPending || !this.visible().length;
      const output = contentEl.createDiv({ cls: "comsift-review-ai-summary comsift-prose markdown-rendered" });
      const renderer = chatMarkdown(this.app, output, "", this.renderOwner); this.summaryRenderer = renderer;
      if (this.aiSummary) renderer.setMarkdown(this.aiSummary);
      button.onclick = async () => {
        this.summaryPending = true; button.disabled = true; renderer.setMarkdown("Summarizing…");
        const selection = this.visible().map(choice => ({ ...choice }));
        const epoch = this.summaryEpoch;
        try {
          const answer = await this.summarize!(selection);
          if (epoch !== this.summaryEpoch) return;
          if (version === this.renderVersion) { this.aiSummary = answer; renderer.setMarkdown(answer); }
          // A closed, unchanged review may still retain the answer for reopening.
          else this.aiSummary = answer;
        } catch (error) { if (version === this.renderVersion) renderer.setMarkdown(error instanceof Error ? error.message : String(error)); }
        finally {
          this.summaryPending = false; button.disabled = false;
          const current = (this.tabHost ?? this.contentEl).querySelector<HTMLButtonElement>(".comsift-summarize");
          if (current) {
            current.disabled = !this.visible().length;
            if (epoch === this.summaryEpoch && this.aiSummary) this.summaryRenderer?.setMarkdown(this.aiSummary);
          }
        }
      };
    }
    if (this.tools && this.redecideOpen) this.drawRedecide(contentEl);
    if (this.onReject) {
      const reject = footer.createEl("button", { text: `Reject ${this.choices.length} decision${this.choices.length === 1 ? "" : "s"}` });
      reject.disabled = !!this.busy;
      reject.onclick = () => {
        this.rejected = true; this.close();
        this.onReject?.([...new Set(this.choices.map(choice => choice.source.id))]);
      };
    }
    const count = this.choices.filter(choice => choice.status !== "later").length;
    const confirm = footer.createEl("button", { cls: "mod-cta comsift-review-confirm", text: this.confirmLabel ?? `Confirm ${count} decisions` });
    this.actionButton(confirm, "confirm", () => this.confirmChoices(this.choices, false));
    if (this.hidden.size) {
      const visible = this.visible();
      const button = footer.createEl("button", { cls: "comsift-review-confirm", text: `Confirm visible (${visible.filter(choice => choice.status !== "later").length})` });
      this.actionButton(button, "visible", () => this.confirmChoices(visible, true));
      if (!visible.length) button.disabled = true;
    }
    if (this.errorText) contentEl.createDiv({ cls: "comsift-error", text: this.errorText });
    for (const [el, top] of scroll) el.scrollTop = top;
    if (previousList) list.scrollTop = scroll.find(([el]) => el === previousList)?.[1] ?? 0;
  }

  private actionButton(button: HTMLButtonElement, action: NonNullable<DecisionReviewModal["busy"]>, run: () => Promise<void>) {
    button.disabled = !!this.busy;
    if (this.busy === action) {
      button.addClass("is-loading");
      button.setAttribute("aria-busy", "true");
      button.createSpan({ cls: "comsift-review-spinner", attr: { "aria-hidden": "true" } });
    }
    button.onclick = () => run();
  }

  private async confirmChoices(selection: ReviewedChoice[], visibleOnly: boolean) {
    if (this.busy) return;
    this.busy = visibleOnly ? "visible" : "confirm"; this.errorText = ""; this.draw();
    try {
      await this.onConfirm(selection);
      if (visibleOnly) {
        const applied = new Set(selection);
        this.choices = this.choices.filter(choice => !applied.has(choice));
        this.initial = this.choices.map(choice => choice.status);
      }
      if (!visibleOnly || !this.choices.length) {
        this.confirmed = true;
        this.busy = null;
        if (this.tabHost) { this.tabHost.empty(); this.tabHost.createDiv({ text: "Decisions saved." }); }
        else this.close();
        return;
      }
    } catch (error) { this.errorText = error instanceof Error ? error.message : String(error); }
    finally { this.busy = null; if (this.sessionDetached) this.dispose(); }
    this.draw();
  }

  private drawRedecide(host: HTMLElement) {
    const panel = host.createDiv({ cls: "comsift-redecide-settings" });
    panel.createEl("h4", { text: "Redecide selected statuses" });
    for (const status of STATUS_ORDER) {
      const label = panel.createEl("label");
      const box = label.createEl("input", { type: "checkbox" });
      box.checked = this.redecideStatuses.has(status); box.disabled = !!this.busy;
      box.onchange = () => { if (box.checked) this.redecideStatuses.add(status); else this.redecideStatuses.delete(status); };
      label.createSpan({ text: STATUS_LABELS[status] });
    }
    panel.createDiv({ text: "Model" });
    const model = panel.createEl("input", { type: "text", value: this.redecideModel });
    model.disabled = !!this.busy; model.oninput = () => { this.redecideModel = model.value; };
    if (this.tools?.models) {
      const picker = panel.createEl("select");
      picker.createEl("option", { text: "Choose an available model…", value: "" });
      picker.disabled = !!this.busy;
      picker.onchange = () => { if (picker.value) { this.redecideModel = picker.value; model.value = picker.value; } };
      void this.tools.models().then(models => {
        if (!picker.isConnected) return;
        for (const name of models) picker.createEl("option", { text: name, value: name });
      }).catch(() => { picker.disabled = true; });
    }
    panel.createDiv({ text: "Instructions for this reassessment" });
    const prompt = panel.createEl("textarea"); prompt.value = this.redecidePrompt;
    prompt.disabled = !!this.busy; prompt.oninput = () => { this.redecidePrompt = prompt.value; };
    const run = panel.createEl("button", { text: "Run reassessment", cls: "mod-cta" });
    this.actionButton(run, "redecide", async () => {
      if (this.busy) return;
      const selection = this.choices.filter(choice => this.redecideStatuses.has(choice.status));
      if (!selection.length) { this.errorText = "Select at least one status with decisions."; this.draw(); return; }
      this.busy = "redecide"; this.errorText = ""; this.draw();
      try {
        const updated = await this.tools!.redecide(selection, { model: this.redecideModel, prompt: this.redecidePrompt });
        const replacements = new Map(updated.map(choice => [`${choice.source.id} → ${choice.candidate.id}`, choice]));
        this.choices = this.choices.map(choice => replacements.get(`${choice.source.id} → ${choice.candidate.id}`) ?? choice);
        this.initial = this.choices.map(choice => choice.status);
        this.invalidateSummary();
      } catch (error) { this.errorText = error instanceof Error ? error.message : String(error); }
      finally { this.busy = null; if (this.sessionDetached) this.dispose(); else this.draw(); }
    });
  }

  private card(list: HTMLElement, choice: ReviewedChoice, index: number, open: boolean) {
    const card = list.createDiv({ cls: `comsift-review-row is-${choice.status}` });
    const head = card.createDiv({ cls: "comsift-review-row-head" });
    head.createSpan({ cls: "comsift-review-pick", text: name(choice.candidate) });
    if (choice.status !== this.initial[index]) head.createSpan({ cls: "comsift-chip", text: "changed" });
    const buttons = card.createDiv({ cls: "comsift-review-actions" });
    for (const status of STATUS_ORDER) {
      const button = buttons.createEl("button", { text: STATUS_LABELS[status], cls: choice.status === status ? "is-active" : "" });
      button.disabled = !!this.busy;
      button.onclick = () => { if (!this.busy) { this.invalidateSummary(); this.choices[index] = { ...choice, status }; this.draw(); } };
    }
    const why = card.createEl("details", { cls: "comsift-review-why" });
    why.setAttribute("data-choice", String(index)); why.open = open;
    why.createEl("summary", { text: "Reasoning" });
    why.createDiv({ text: choice.reason });
    const { supporting_evidence: support, conflicting_evidence: conflict } = choice.reasoned.decision;
    if (support.length) why.createDiv({ cls: "comsift-source-meta", text: `Supports: ${support.join("; ")}` });
    if (conflict.length) why.createDiv({ cls: "comsift-source-meta", text: `Conflicts: ${conflict.join("; ")}` });
  }
}
