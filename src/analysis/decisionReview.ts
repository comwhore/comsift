import { App, Modal } from "obsidian";
import type { ProfileRecord } from "./runner";
import type { ReasonedResult, ReviewStatus } from "./service";

export interface PendingDecision {
  source: ProfileRecord;
  candidates: ProfileRecord[];
  reasoned: ReasonedResult;
}

export interface ReviewedChoice extends PendingDecision {
  chosen: string;
  status: ReviewStatus;
}

const STATUS_LABELS: Record<ReviewStatus, string> = {
  confirmed: "Same person", related: "Related", uncertain: "Uncertain", rejected: "Not a match", later: "Later",
};
const MATCH_STATUSES: ReviewStatus[] = ["confirmed", "related", "uncertain", "later"];
const NO_MATCH_STATUSES: ReviewStatus[] = ["rejected", "later"];

function name(record: ProfileRecord): string {
  const f = record.fields;
  const base = f.display_name || f.username || f.name || record.id;
  return f.platform ? `${base} (${f.platform})` : base;
}

export function defaultChoice(entry: PendingDecision): ReviewedChoice {
  const chosen = entry.reasoned.decision.candidate_id;
  const status: ReviewStatus = chosen === "NO_MATCH" ? "rejected" : entry.reasoned.decision.uncertain ? "uncertain" : "confirmed";
  return { ...entry, chosen, status };
}

/**
 * Overview of what the model decided before anything is written: one row per source with
 * the picked candidate, quick buttons to change the outcome, and one big confirm button.
 */
export class DecisionReviewModal extends Modal {
  private choices: ReviewedChoice[];
  private confirmed = false;

  constructor(app: App, entries: PendingDecision[], private engine: string,
    private onConfirm: (choices: ReviewedChoice[]) => void, private onCancel?: () => void) {
    super(app);
    this.choices = entries.map(defaultChoice);
    this.modalEl.addClass("comsift-decision-review");
  }

  onOpen() { this.draw(); }

  onClose() {
    this.contentEl.empty();
    if (!this.confirmed) this.onCancel?.();
  }

  private draw() {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle(`${this.engine} decided ${this.choices.length} record${this.choices.length === 1 ? "" : "s"}`);
    const counts = { match: 0, none: 0, unsure: 0, later: 0 };
    for (const choice of this.choices) {
      if (choice.status === "later") counts.later++;
      else if (choice.chosen === "NO_MATCH") counts.none++;
      else if (choice.status === "uncertain") counts.unsure++;
      else counts.match++;
    }
    const summary = contentEl.createDiv({ cls: "comsift-review-summary" });
    for (const [value, text, cls] of [[counts.match, "matches", "is-confirmed"], [counts.none, "no match", "is-rejected"],
      [counts.unsure, "uncertain", "is-uncertain"], [counts.later, "later", "is-later"]] as const) {
      summary.createSpan({ cls: `comsift-chip ${cls}`, text: `${value} ${text}` });
    }
    contentEl.createDiv({ cls: "setting-item-description",
      text: "Nothing has been written yet. Change any row, then confirm to save the reviews and Graph View links." });

    const bulk = contentEl.createDiv({ cls: "comsift-review-bulk" });
    const all = (status: ReviewStatus | "reset") => {
      this.choices = this.choices.map(choice => status === "reset" ? defaultChoice(choice)
        : { ...choice, status: choice.chosen === "NO_MATCH" && status !== "later" ? "rejected" : status });
      this.draw();
    };
    bulk.createEl("button", { text: "Reset to model answers" }).onclick = () => all("reset");
    bulk.createEl("button", { text: "Everything later" }).onclick = () => all("later");
    bulk.createEl("button", { text: "Mark picks uncertain" }).onclick = () => all("uncertain");

    const list = contentEl.createDiv({ cls: "comsift-review-list" });
    this.choices.forEach((choice, index) => this.row(list, choice, index));

    const footer = contentEl.createDiv({ cls: "comsift-review-footer" });
    footer.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    const applied = this.choices.filter(choice => choice.status !== "later").length;
    const confirm = footer.createEl("button", { cls: "mod-cta comsift-review-confirm",
      text: applied ? `Confirm ${applied} decision${applied === 1 ? "" : "s"}` : "Done (nothing to apply)" });
    confirm.onclick = () => {
      this.confirmed = true;
      this.close();
      this.onConfirm(this.choices);
    };
    window.setTimeout(() => confirm.focus(), 0);
  }

  private row(list: HTMLElement, choice: ReviewedChoice, index: number) {
    const row = list.createDiv({ cls: `comsift-review-row is-${choice.status}` });
    const head = row.createDiv({ cls: "comsift-review-row-head" });
    head.createSpan({ cls: "comsift-review-source", text: name(choice.source) });
    head.createSpan({ cls: "comsift-review-arrow", text: "→" });
    const select = head.createEl("select", { attr: { "aria-label": `Pick for ${name(choice.source)}` } });
    for (const candidate of choice.candidates) select.createEl("option", { text: name(candidate), value: candidate.id });
    select.createEl("option", { text: "No match", value: "NO_MATCH" });
    select.value = choice.chosen;
    if (choice.chosen !== choice.reasoned.decision.candidate_id) head.createSpan({ cls: "comsift-chip", text: "changed" });
    select.onchange = () => {
      const chosen = select.value;
      const status: ReviewStatus = chosen === "NO_MATCH" ? (choice.status === "later" ? "later" : "rejected")
        : choice.status === "rejected" ? "confirmed" : choice.status;
      this.choices[index] = { ...choice, chosen, status };
      this.draw();
    };

    const buttons = row.createDiv({ cls: "comsift-review-actions" });
    for (const status of choice.chosen === "NO_MATCH" ? NO_MATCH_STATUSES : MATCH_STATUSES) {
      const button = buttons.createEl("button", { text: STATUS_LABELS[status], cls: choice.status === status ? "is-active" : "" });
      button.onclick = () => {
        this.choices[index] = { ...choice, status };
        this.draw();
      };
    }
    const why = row.createEl("details", { cls: "comsift-review-why" });
    why.createEl("summary", { text: choice.reasoned.decision.uncertain ? "Why (model was unsure)" : "Why" });
    why.createDiv({ text: choice.reasoned.decision.explanation });
    const support = choice.reasoned.decision.supporting_evidence;
    const conflict = choice.reasoned.decision.conflicting_evidence;
    if (support.length) why.createDiv({ cls: "comsift-source-meta", text: `Supports: ${support.join("; ")}` });
    if (conflict.length) why.createDiv({ cls: "comsift-source-meta", text: `Conflicts: ${conflict.join("; ")}` });
  }
}
