import { FuzzySuggestModal, Notice, TFile, type App } from "obsidian";
import type ComsiftPlugin from "../main";
import { MANUAL_PROPERTY, LINKS_PROPERTY } from "./graphLogic";

class PickModal<T> extends FuzzySuggestModal<T> {
  constructor(app: App, private items: T[], private text: (item: T) => string, private choose: (item: T) => void, placeholder: string) {
    super(app);
    this.setPlaceholder(placeholder);
  }
  getItems() { return this.items; }
  getItemText(item: T) { return this.text(item); }
  onChooseItem(item: T) { this.choose(item); }
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  return typeof value === "string" && value ? [value] : [];
}

/** Command palette actions for hand-made relationships, kept in the `relationships` property. */
export function registerRelationshipCommands(plugin: ComsiftPlugin) {
  const { app } = plugin;
  const linkTo = (from: TFile, to: TFile) => `[[${app.metadataCache.fileToLinktext(to, from.path, true)}]]`;

  plugin.addCommand({
    id: "add-relationship",
    name: "Add relationship",
    checkCallback: checking => {
      const active = app.workspace.getActiveFile();
      if (!active || active.extension !== "md") return false;
      if (checking) return true;
      const files = app.vault.getFiles().filter(file => file !== active && ["md", "canvas", "csv", "pdf"].includes(file.extension));
      new PickModal(app, files, file => file.path, target => {
        void app.fileManager.processFrontMatter(active, (frontmatter: Record<string, unknown>) => {
          const list = asList(frontmatter[MANUAL_PROPERTY]);
          const link = linkTo(active, target);
          if (!list.includes(link)) list.push(link);
          frontmatter[MANUAL_PROPERTY] = list;
        }).then(() => new Notice(`Comsift: linked to ${target.basename}.`));
      }, "Link this note to…").open();
      return true;
    },
  });

  plugin.addCommand({
    id: "remove-relationship",
    name: "Remove relationship",
    checkCallback: checking => {
      const active = app.workspace.getActiveFile();
      const frontmatter = active ? app.metadataCache.getFileCache(active)?.frontmatter : undefined;
      const manual = asList(frontmatter?.[MANUAL_PROPERTY]);
      const generated = asList(frontmatter?.[LINKS_PROPERTY]);
      if (!active || (!manual.length && !generated.length)) return false;
      if (checking) return true;
      const items = [...manual.map(link => ({ link, generated: false })), ...generated.map(link => ({ link, generated: true }))];
      new PickModal(app, items, item => `${item.link}${item.generated ? "  (generated from Canvas/folder; comes back while that link exists)" : ""}`, item => {
        void app.fileManager.processFrontMatter(active, (data: Record<string, unknown>) => {
          const key = item.generated ? LINKS_PROPERTY : MANUAL_PROPERTY;
          const list = asList(data[key]).filter(link => link !== item.link);
          if (list.length) data[key] = list; else delete data[key];
        }).then(() => new Notice(`Comsift: removed ${item.link}.`));
      }, "Remove which relationship?").open();
      return true;
    },
  });
}
