import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import { chatMarkdown } from "./chatMarkdown";
import { reviewSession, type LiveReviewSession } from "./reviewSessions";

export const SUMMARY_VIEW_TYPE = "comsift-review-summary";

/** A persistent workspace tab; summary text remains selectable and copyable. */
export class SummaryView extends ItemView {
  private markdown = "";
  private renderer: ReturnType<typeof chatMarkdown> | null = null;
  private reviewId = "";
  private live: LiveReviewSession | undefined;
  constructor(leaf: WorkspaceLeaf) { super(leaf); }
  getViewType() { return SUMMARY_VIEW_TYPE; }
  getDisplayText() { return "Analysis summary"; }
  getIcon() { return "file-text"; }
  getState() { return { markdown: this.markdown, reviewId: this.reviewId }; }
  async setState(state: { markdown?: string; reviewId?: string }, result: Parameters<ItemView["setState"]>[1]) {
    if (this.reviewId !== (state.reviewId ?? "")) { this.live?.unmount(); this.live = undefined; }
    this.markdown = state.markdown ?? "";
    this.reviewId = state.reviewId ?? "";
    this.draw();
    await super.setState(state, result);
  }
  async onOpen() { this.draw(); }
  async onClose() { this.renderer?.dispose(); this.live?.unmount(); this.live = undefined; }
  private draw() {
    this.renderer?.dispose(); this.contentEl.empty();
    this.contentEl.addClass("comsift-summary-tab");
    this.live = reviewSession(this.reviewId);
    if (this.live) { this.live.mount(this.contentEl); return; }
    this.contentEl.createEl("button", { text: "Copy summary" }).onclick = () => {
      void navigator.clipboard.writeText(this.markdown).catch(() => new Notice("Could not copy summary. Select the text to copy it."));
    };
    const body = this.contentEl.createDiv({ cls: "comsift-prose markdown-rendered" });
    this.renderer = chatMarkdown(this.app, body, "", this);
    this.renderer.setMarkdown(this.markdown);
  }
}
