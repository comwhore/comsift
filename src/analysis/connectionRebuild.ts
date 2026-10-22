import { Modal, Notice, TFolder } from "obsidian";
import type ComsiftPlugin from "../main";
import type { Investigation } from "../service/investigation";

class ConnectionRebuildModal extends Modal {
  constructor(private plugin: ComsiftPlugin, private item: Investigation) { super(plugin.app); }
  onOpen() {
    this.setTitle("Remake connections");
    this.contentEl.createEl("p", { text: "Read the source sheets again using the current column settings and selected sheet ranges." });
    this.contentEl.createEl("p", { text: "Merge keeps existing people and adds newly enabled fields and accounts. Destructive replaces generated connection profiles; a backup is saved in the person's backups folder. Promoted people and other notes are kept." });
    const actions = this.contentEl.createDiv({ cls: "comsift-review-actions" });
    const run = async (mode: "merge" | "destructive") => {
      actions.querySelectorAll("button").forEach(button => { button.disabled = true; });
      try {
        const count = await this.plugin.analysis.rebuildConnections(this.item, mode);
        new Notice(`Remade connections from ${count} records.`);
        this.close();
      } catch (error) {
        new Notice(`Could not remake connections: ${error instanceof Error ? error.message : String(error)}`);
        actions.querySelectorAll("button").forEach(button => { button.disabled = false; });
      }
    };
    actions.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    actions.createEl("button", { text: "Confirm merge", cls: "mod-cta" }).onclick = () => { void run("merge"); };
    actions.createEl("button", { text: "Confirm destructive rebuild", cls: "mod-warning" }).onclick = () => { void run("destructive"); };
  }
  onClose() { this.contentEl.empty(); }
}

export function registerConnectionRebuild(plugin: ComsiftPlugin): void {
  plugin.registerEvent(plugin.app.workspace.on("file-menu", (menu, file) => {
    if (!(file instanceof TFolder) || file.name !== "Connections") return;
    const item = plugin.investigations.forPath(file.path);
    if (!item || file.path !== `${item.folderPath}/Connections`) return;
    menu.addItem(entry => entry.setTitle("Remake connections…").setIcon("refresh-cw")
      .onClick(() => new ConnectionRebuildModal(plugin, item).open()));
  }));
}
