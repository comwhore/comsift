import { FuzzySuggestModal, Modal, Notice, TFile, type App } from "obsidian";
import type ComsiftPlugin from "../main";
import { readProfileRecords, type StoredProfile } from "../analysis/profileIdentity";
import type { ReviewStatus } from "../analysis/service";
import type { Investigation } from "./investigation";
import { connectionScope, isConnectionProfile } from "./profilePaths";
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
  const profileFile = (file: TFile) => isProfile(file) || typeof app.metadataCache.getFileCache(file)?.frontmatter?.comsift_profile_data === "string";
  const open = (file: TFile) => { void editProfileRelationship(plugin, file).catch(error => new Notice(error instanceof Error ? error.message : String(error))); };
  plugin.addCommand({ id: "edit-profile-relationship", name: "Change profile relationship", checkCallback: checking => {
    const file = app.workspace.getActiveFile();
    if (!file || !profileFile(file)) return false;
    if (!checking) open(file);
    return true;
  } });
  plugin.registerEvent(app.workspace.on("file-menu", (menu, file) => {
    if (file instanceof TFile && profileFile(file)) {
      menu.addItem(item => item.setTitle("Change profile relationship…").setIcon("users").onClick(() => open(file)));
      if (!plugin.investigations.forPrimaryPath?.(file.path)) menu.addItem(item => item.setTitle("Promote to person…").setIcon("user-round-plus").onClick(() => plugin.investigations.promptNewUser(file)));
    }
  }));
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
        }).catch((error: unknown) => new Notice(error instanceof Error ? error.message : "Could not add relationship."));
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
      new PickModal(app, items, item => `${item.link}${item.generated ? " (generated; remove its Canvas arrow to unlink)" : ""}`, item => {
        void app.fileManager.processFrontMatter(active, (data: Record<string, unknown>) => {
          const key = item.generated ? LINKS_PROPERTY : MANUAL_PROPERTY;
          const list = asList(data[key]).filter(link => link !== item.link);
          if (list.length) data[key] = list; else delete data[key];
        }).catch((error: unknown) => new Notice(error instanceof Error ? error.message : "Could not remove relationship."));
      }, "Remove which relationship?").open();
      return true;
    },
  });
}


function isProfile(file: TFile): boolean {
  return file.extension === "md" && isConnectionProfile(file.path);
}

function recordLabel(record: StoredProfile): string {
  return `${record.fields.username || record.fields.display_name || record.id} (${record.fields.platform || record.dataset}), row ${record.row}`;
}

async function relationshipScope(plugin: ComsiftPlugin, file: TFile, a: StoredProfile, b: StoredProfile): Promise<{ item: Investigation; reverse: boolean }> {
  const keys = [`${a.id} → ${b.id}`, `${b.id} → ${a.id}`];
  for (const reviewFile of plugin.app.vault.getFiles().filter(candidate => candidate.path.endsWith("/Analysis/reviews.json"))) {
    const entries = JSON.parse(await plugin.app.vault.read(reviewFile)) as Record<string, unknown>;
    const key = keys.find(key => entries[key]);
    if (!key) continue;
    const folderPath = reviewFile.path.slice(0, -"/Analysis/reviews.json".length);
    const item = plugin.investigations.forPath(reviewFile.path) ?? { id: `comparison:${folderPath.split("/").at(-1)}`, folderPath };
    return { item, reverse: key === keys[1] };
  }
  const storedScope: unknown = plugin.app.metadataCache?.getFileCache(file)?.frontmatter?.comsift_connection_scope;
  const folderPath = connectionScope(file.path) ?? (typeof storedScope === "string" ? storedScope : file.path.split("/").slice(0, -1).join("/"));
  return { item: plugin.investigations.forPath(file.path) ?? { id: `comparison:${folderPath.split("/").at(-1)}`, folderPath }, reverse: false };
}

async function editProfileRelationship(plugin: ComsiftPlugin, file: TFile): Promise<void> {
  const records = readProfileRecords(await plugin.app.vault.read(file));
  if (!records.length) { new Notice("This profile has no stored account records."); return; }
  const pickTarget = async (source: StoredProfile) => {
    const targets: Array<{ record: StoredProfile; path: string }> = [];
    for (const note of plugin.app.vault.getMarkdownFiles().filter(note => isProfile(note) || !!plugin.investigations.forPrimaryPath?.(note.path))) {
      for (const record of readProfileRecords(await plugin.app.vault.read(note))) {
        if (record.id !== source.id && !targets.some(target => target.record.id === record.id)) targets.push({ record, path: note.path });
      }
    }
    new PickModal(plugin.app, targets, target => `${recordLabel(target.record)} · ${target.path}`, target => {
      void (async () => {
        const scope = await relationshipScope(plugin, file, source, target.record);
        const [left, right] = scope.reverse ? [target.record, source] : [source, target.record];
        const reviews = await plugin.analysis.reviews(scope.item);
        const current = reviews[`${left.id} → ${right.id}`]?.status;
        const modal = new Modal(plugin.app);
        modal.setTitle("Change profile relationship");
        modal.contentEl.createEl("p", { text: `${recordLabel(source)} ↔ ${recordLabel(target.record)}` });
        const choices: Array<[ReviewStatus | "neutral", string]> = [["confirmed", "Same person"], ["related", "Related"], ["uncertain", "Uncertain"], ["rejected", "Different people"], ["neutral", "Neutral / clear choice"]];
        for (const [status, label] of choices) {
          const button = modal.contentEl.createEl("button", { text: `${current === status ? "✓ " : ""}${label}` });
          button.onclick = () => {
            modal.contentEl.querySelectorAll("button").forEach(button => { button.disabled = true; });
            void (async () => {
              if (status === "neutral") {
                await plugin.analysis.unreview(scope.item, left.id, right.id);
                // Reopening a draft restores its committed choice. Neutral clears that choice too.
                const remaining = await plugin.analysis.reviews(scope.item);
                if (remaining[`${left.id} → ${right.id}`]) await plugin.analysis.unreview(scope.item, left.id, right.id);
              } else await plugin.analysis.review(scope.item, { ...left, raw: left.fields }, { ...right, raw: right.fields }, status);
              if (!scope.item.id.startsWith("comparison:")) await plugin.analysis.syncCanvasArrows(scope.item);
              modal.close();
              new Notice(`Relationship: ${label}.`);
            })().catch(error => {
              modal.contentEl.querySelectorAll("button").forEach(button => { button.disabled = false; });
              new Notice(error instanceof Error ? error.message : String(error));
            });
          };
        }
        modal.open();
      })().catch(error => new Notice(error instanceof Error ? error.message : String(error)));
    }, "Choose the other account (including accounts merged into this profile)…").open();
  };
  const choose = (record: StoredProfile) => { void pickTarget(record).catch(error => new Notice(error instanceof Error ? error.message : String(error))); };
  if (records.length === 1) choose(records[0]);
  else new PickModal(plugin.app, records, recordLabel, choose, "Choose the account whose relationship you want to change…").open();
}
