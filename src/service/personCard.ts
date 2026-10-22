// Rendered person card for connection profiles and people's primary notes.
// The note holds an empty ```comsift-person``` block; the card is drawn from frontmatter, so Graph View
// still sees every source, alias and relationship link. Below the block the user writes normal notes.
import { FuzzySuggestModal, MarkdownRenderChild, Modal, Notice, TFile, normalizePath, setIcon, type App, type MarkdownPostProcessorContext } from "obsidian";
import type ComsiftPlugin from "../main";
import { canonicalPlatform, readProfileRecords, upgradeProfileNote, type StoredProfile } from "../analysis/profileIdentity";
import { CellEmbeds, tablesFromText } from "../analysis/cellEmbeds";
import { datasetParts, formatCellRef, pickSheet, sourceCells } from "../analysis/cellRefs";
import { parseCanvas } from "./canvasModel";
import { clearCanvasRelation, inheritedRelation, personCanvasRelations } from "./canvasRelations";
import type { Investigation } from "./investigation";
import { markLinkTarget, readMarks, setMark, type MarkType, type SetMarkType } from "./personMarks";
import { PERSON_CARD_LANGUAGE, hasPersonCard } from "./personCardFormat";
import { toolReportKind } from "./toolProfiles";
import { ownedFilesByOwner } from "./fileOwners";
import { profileFieldLabel, visibleProfileFields } from "./profileFields";
import { reviewRelations } from "./reviewRelations";

/** `graphSources` key of the owner links (graph.ts `OWNER_SOURCE`). */
const OWNER_LINKS = "owners";
import { connectionScope, isConnectionProfile } from "./profilePaths";

type Frontmatter = Record<string, unknown>;
type CardRecord = StoredProfile & { raw?: Record<string, string>; section?: string };

const MARK_LABELS: Record<SetMarkType, string> = { same: "Same person", related: "Related", uncertain: "Uncertain" };
const HIDDEN_FIELDS = new Set(["platform", "avatar_url", "avatar_hash", "display_name", "username"]);
const IDENTITY_ORDER = ["username", "user_id", "profile_url", "website", "email", "phone"];

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string" && !!entry.trim());
  return typeof value === "string" && value.trim() ? [value] : [];
}

/** User fields are stored apart from imported rows, so rebuilding connections preserves them. */
export function customFields(frontmatter: Frontmatter | undefined): Record<string, string> {
  const raw: unknown = frontmatter?.comsift_custom_fields;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([key, value]) => key.trim() && typeof value === "string" && value.trim()));
}

/** Stored import rows from `comsift_profile_data` (already parsed by the metadata cache). */
export function cardRecords(frontmatter: Frontmatter | undefined): CardRecord[] {
  const data = frontmatter?.comsift_profile_data;
  if (typeof data !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(data);
    return Array.isArray(parsed) ? (parsed as unknown[]).filter((entry): entry is CardRecord => !!entry && typeof entry === "object" && "fields" in entry && !!entry.fields && typeof entry.fields === "object" && "dataset" in entry && typeof entry.dataset === "string") : [];
  } catch { return []; }
}

/** First non-empty value of each field across the stored rows. */
export function mergedFields(records: CardRecord[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const record of records) for (const [key, value] of Object.entries(record.fields)) if (typeof value === "string" && value.trim() && !fields[key]) fields[key] = value.trim();
  return fields;
}

function initials(name: string): string {
  const words = name.replace(/[@_.\-()[\]]+/g, " ").trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2)).toUpperCase();
}

function isUrl(value: string): boolean { return /^https?:\/\/\S+$/i.test(value); }

interface Relation { path: string; type: SetMarkType; origin: "mark" | "incoming" | "canvas" | "review"; holder?: string }

class PickModal<T> extends FuzzySuggestModal<T> {
  constructor(app: App, private items: T[], private text: (item: T) => string, private choose: (item: T) => void, placeholder: string) {
    super(app);
    this.setPlaceholder(placeholder);
  }
  getItems() { return this.items; }
  getItemText(item: T) { return this.text(item); }
  onChooseItem(item: T) { this.choose(item); }
}

class CardChild extends MarkdownRenderChild {
  private related = new Set<string>();
  private timer = 0;
  constructor(containerEl: HTMLElement, private cards: PersonCards, private path: string) { super(containerEl); }

  onload() {
    this.draw();
    const { metadataCache } = this.cards.plugin.app;
    this.registerEvent(metadataCache.on("changed", (file, _data, cache) => {
      if (file.path === this.path || this.related.has(file.path) || readMarks(cache.frontmatter).some(mark => this.cards.resolve(mark.value, file.path) === this.path)) this.schedule();
    }));
    this.registerEvent(this.cards.plugin.app.vault.on("rename", (file, oldPath) => { if (oldPath === this.path) { this.path = file.path; this.schedule(); } }));
    this.registerEvent(this.cards.plugin.app.vault.on("modify", file => {
      if (file.path.endsWith("/Analysis/reviews.json") || file.path.endsWith(".canvas")) this.schedule();
    }));
  }

  onunload() { window.clearTimeout(this.timer); }

  private schedule() {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.draw(), 250);
  }

  private draw() {
    const file = this.cards.plugin.app.vault.getFileByPath(this.path);
    this.containerEl.empty();
    if (!file) return;
    this.related = this.cards.draw(this.containerEl, file);
  }
}

export class PersonCards {
  readonly cells: CellEmbeds;

  constructor(readonly plugin: ComsiftPlugin) {
    this.cells = new CellEmbeds(plugin);
  }

  start() {
    this.plugin.registerMarkdownCodeBlockProcessor(PERSON_CARD_LANGUAGE, (_source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
      ctx.addChild(new CardChild(el.createDiv({ cls: "comsift-person-card" }), this, ctx.sourcePath));
    });
  }

  /** Mark value → path of the note it points to. */
  resolve(value: string, from: string): string | null {
    const target = markLinkTarget(value);
    if (!target) return null;
    return this.plugin.app.metadataCache.getFirstLinkpathDest(target, from)?.path ?? null;
  }

  private isPrimary(path: string): boolean { return !!this.plugin.investigations.forPrimaryPath?.(path); }

  /** People (primary notes) and connection profiles that a note can be linked to. */
  private targets(exclude: string): TFile[] {
    const { metadataCache } = this.plugin.app;
    return this.plugin.app.vault.getMarkdownFiles().filter(file => file.path !== exclude && (this.isPrimary(file.path) || isConnectionProfile(file.path) ||
      typeof metadataCache.getFileCache(file)?.frontmatter?.comsift_profile_data === "string"));
  }

  private label(file: TFile): string {
    if (this.isPrimary(file.path)) return `${file.basename} (person)`;
    const owner = connectionScope(file.path)?.split("/").at(-1);
    return owner ? `${file.basename} · ${owner}` : file.basename;
  }

  /** Relationship marks written in this note, marks other notes point at it, and typed Canvas arrows. */
  relations(file: TFile): Relation[] {
    const { metadataCache } = this.plugin.app;
    const out = new Map<string, Relation>();
    for (const mark of readMarks(metadataCache.getFileCache(file)?.frontmatter)) {
      const path = this.resolve(mark.value, file.path);
      if (path && path !== file.path && !out.has(path)) out.set(path, { path, type: mark.type, origin: "mark", holder: file.path });
    }
    for (const candidate of this.plugin.app.vault.getMarkdownFiles()) {
      const source = candidate.path;
      if (source === file.path || out.has(source)) continue;
      const other = this.plugin.app.vault.getFileByPath(source);
      const mark = other ? readMarks(metadataCache.getFileCache(other)?.frontmatter).find(entry => this.resolve(entry.value, source) === file.path) : undefined;
      if (mark) out.set(source, { path: source, type: mark.type, origin: "incoming", holder: source });
    }
    return [...out.values()];
  }

  private async profileCanvasRelation(file: TFile, owner: Investigation, frontmatter: Record<string, unknown> | undefined): Promise<Relation | null> {
    const { metadataCache } = this.plugin.app;
    const raw: unknown = frontmatter?.comsift_sources;
    const sources = (Array.isArray(raw) ? raw as unknown[] : [raw]).map(markLinkTarget).filter((link): link is string => !!link)
      .flatMap(link => [link, `${link}.md`, metadataCache.getFirstLinkpathDest(link, file.path)?.path ?? link]);
    const type = inheritedRelation(await personCanvasRelations(this.plugin, owner), file.path, sources);
    return type ? { path: this.plugin.investigations.mdPath(owner), type, origin: "canvas" } : null;
  }

  private async canvasRelations(file: TFile): Promise<Relation[]> {
    const item = this.plugin.investigations.forPrimaryPath?.(file.path);
    if (!item) return [];
    try {
      return [...(await personCanvasRelations(this.plugin, item)).entries()]
        .map(([path, type]) => ({ path, type, origin: "canvas" as const }));
    } catch { return []; }
  }

  /** Draw the card; returns the paths whose changes should redraw it. */
  draw(root: HTMLElement, file: TFile): Set<string> {
    const { app, setting } = this.plugin;
    const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
    const records = cardRecords(frontmatter);
    const fields = { ...visibleProfileFields(records, setting), ...customFields(frontmatter) };
    const item = this.plugin.investigations.forPrimaryPath?.(file.path) ?? null;
    const owner = item ?? this.plugin.investigations.forPath(file.path);
    const title = typeof frontmatter?.title === "string" && frontmatter.title.trim() ? frontmatter.title.trim() : "";
    const name = item ? title || file.basename : fields.display_name || fields.username || title || file.basename;
    const platforms = [...new Set(records.map(record => canonicalPlatform(record.fields)).filter(Boolean))];
    const relations = this.relations(file);
    const watched = new Set(relations.map(relation => relation.path));

    const head = root.createDiv({ cls: "comsift-person-head" });
    const avatar = head.createDiv({ cls: "comsift-person-avatar" });
    if (owner?.color) avatar.setCssProps({ "--comsift-person-color": owner.color });
    const remote = fields.avatar_url;
    if (remote && isUrl(remote) && setting.remoteAvatars) {
      const img = avatar.createEl("img", { attr: { src: remote, alt: "", loading: "lazy", referrerpolicy: "no-referrer" } });
      img.addEventListener("error", () => { img.remove(); avatar.setText(initials(name)); });
    } else avatar.setText(initials(name));
    const identity = head.createDiv({ cls: "comsift-person-identity" });
    const nameLine = identity.createDiv({ cls: "comsift-person-name" });
    nameLine.createSpan({ text: name });
    if (item) nameLine.createSpan({ cls: "comsift-person-badge is-person", text: "Person" });
    for (const platform of platforms) nameLine.createSpan({ cls: "comsift-person-badge", text: platform });
    if (fields.username && fields.username !== name) identity.createDiv({ cls: "comsift-person-handle", text: fields.username.startsWith("@") ? fields.username : `@${fields.username}` });
    const aliases = list(frontmatter?.aliases).filter(alias => alias !== name && alias !== fields.username);
    if (aliases.length) {
      const row = identity.createDiv({ cls: "comsift-person-aliases" });
      row.createSpan({ cls: "comsift-person-label", text: "Also known as" });
      for (const alias of aliases) row.createSpan({ cls: "comsift-person-chip", text: alias });
    }
    if (!item && owner) {
      const seen = identity.createDiv({ cls: "comsift-person-owner" });
      seen.createSpan({ cls: "comsift-person-label", text: "Found in" });
      this.link(seen, this.plugin.investigations.mdPath(owner), owner.folderPath.split("/").at(-1) ?? owner.folderPath, file.path);
      watched.add(this.plugin.investigations.mdPath(owner));
    }

    const facts = Object.entries(fields).filter(([key]) => !HIDDEN_FIELDS.has(key));
    if (fields.username) facts.unshift(["username", fields.username]);
    facts.sort(([a], [b]) => {
      const rank = (key: string) => { const index = IDENTITY_ORDER.indexOf(key); return index >= 0 ? index : key.startsWith("id:") ? IDENTITY_ORDER.length : IDENTITY_ORDER.length + 1; };
      return rank(a) - rank(b);
    });
    if (facts.length) {
      const grid = root.createEl("dl", { cls: "comsift-person-fields" });
      for (const [key, value] of facts) {
        grid.createEl("dt", { text: profileFieldLabel(key) });
        const dd = grid.createEl("dd");
        if (isUrl(value)) dd.createEl("a", { cls: "external-link", text: value, attr: { href: value, target: "_blank", rel: "noopener noreferrer" } });
        else dd.setText(value);
      }
    }
    const accounts = list(frontmatter?.comsift_accounts);
    if (accounts.length > 1) {
      const row = root.createDiv({ cls: "comsift-person-section" });
      row.createDiv({ cls: "comsift-person-section-title", text: "Accounts in this note" });
      const chips = row.createDiv({ cls: "comsift-person-chips" });
      for (const account of accounts) chips.createSpan({ cls: "comsift-person-chip", text: account.replace("|", " · ") });
    }

    const relationsEl = root.createDiv({ cls: "comsift-person-section comsift-person-relations" });
    const drawRelations = (all: Relation[]) => {
      relationsEl.empty();
      relationsEl.createDiv({ cls: "comsift-person-section-title", text: item ? "Accounts and people" : "Linked people" });
      if (!all.length) { relationsEl.createDiv({ cls: "comsift-person-empty", text: "No links yet. Use the buttons below." }); return; }
      for (const type of Object.keys(MARK_LABELS) as SetMarkType[]) {
        const group = all.filter(relation => relation.type === type);
        if (!group.length) continue;
        const row = relationsEl.createDiv({ cls: `comsift-person-relation is-${type}` });
        row.createSpan({ cls: "comsift-person-label", text: item && type === "same" ? "Accounts" : MARK_LABELS[type] });
        const chips = row.createDiv({ cls: "comsift-person-chips" });
        for (const relation of group) {
          const target = app.vault.getFileByPath(relation.path);
          const chip = chips.createSpan({ cls: `comsift-person-chip is-link${relation.origin === "canvas" ? " is-canvas" : ""}` });
          this.link(chip, relation.path, target ? this.label(target) : relation.path, file.path);
          if (relation.origin === "review") chip.setAttr("aria-label", "From a confirmed analysis choice");
          else if (relation.origin === "canvas") chip.setAttr("aria-label", "From a Canvas arrow");
          else if (relation.origin === "incoming") chip.setAttr("aria-label", "Marked in the other note");
        }
      }
    };
    drawRelations(relations);
    void reviewRelations(this.plugin).then(reviews => {
      const extra: Relation[] = reviews.flatMap(relation => relation.source === file.path
        ? [{ path: relation.target, type: relation.type, origin: "review" as const }]
        : relation.target === file.path ? [{ path: relation.source, type: relation.type, origin: "review" as const }] : []);
      for (const relation of extra) {
        watched.add(relation.path);
        const existing = relations.findIndex(existing => existing.path === relation.path);
        if (existing < 0) relations.push(relation);
        else if (relations[existing].origin === "canvas") relations[existing] = relation;
      }
      if (relationsEl.isConnected) drawRelations(relations);
    }).catch(error => console.error("[comsift] reading profile decisions", error));
    if (item) void this.canvasRelations(file).then(extra => {
      const known = new Set(relations.map(relation => relation.path));
      const added = extra.filter(relation => !known.has(relation.path));
      relations.push(...added);
      if (added.length && relationsEl.isConnected) drawRelations(relations);
    });
    else if (owner) void this.profileCanvasRelation(file, owner, frontmatter).then(relation => {
      // Explicit profile choices take precedence over a Canvas relationship.
      if (!relation || relations.some(entry => entry.path === relation.path) || !relationsEl.isConnected) return;
      relations.push(relation);
      drawRelations(relations);
    });

    this.drawSources(root, file, records, item ? list(frontmatter?.comsift_links) : []);
    for (const owner of this.drawOwnedFiles(root, file, item?.folderPath ?? null)) watched.add(owner);
    this.drawActions(root, file, !!item, records.length > 0 || isConnectionProfile(file.path));
    for (const record of records) watched.add(datasetParts(record.dataset).path);
    return watched;
  }

  private link(parent: HTMLElement, path: string, text: string, from: string) {
    const a = parent.createEl("a", { cls: "internal-link", text, attr: { href: path.replace(/\.md$/, ""), "data-href": path.replace(/\.md$/, "") } });
    a.addEventListener("click", event => { event.preventDefault(); void this.plugin.app.workspace.openLinkText(path, from, event.ctrlKey || event.metaKey); });
  }

  /**
   * Files that belong to an account (see fileOwners.ts: friend-list exports, Maigret/Sherlock results): a profile
   * card lists its own files; a person's card lists the files of their accounts, grouped by account, because the
   * person's note no longer links to them. Returns the owner notes shown.
   */
  private drawOwnedFiles(root: HTMLElement, file: TFile, personFolder: string | null): string[] {
    const isNote = (path: string) => isConnectionProfile(path) || !!this.plugin.investigations.forPrimaryPath?.(path);
    const owned = ownedFilesByOwner(this.plugin.state.graphSources?.[OWNER_LINKS], isNote);
    const groups = personFolder
      ? [...owned].filter(([owner, files]) => owner !== file.path && (owner.startsWith(`${personFolder}/`) || files.some(path => path.startsWith(`${personFolder}/`))))
      : owned.has(file.path) ? [[file.path, owned.get(file.path) ?? []] as [string, string[]]] : [];
    if (!groups.length) return [];
    const section = root.createDiv({ cls: "comsift-person-section comsift-person-files" });
    section.createDiv({ cls: "comsift-person-section-title", text: personFolder ? "Files from accounts" : "Files" });
    const name = (path: string) => path.split("/").at(-1)?.replace(/\.md$/, "").replace(/\.sheet$/, "") ?? path;
    for (const [owner, files] of groups.sort(([a], [b]) => a.localeCompare(b))) {
      const row = section.createDiv({ cls: "comsift-person-relation" });
      if (personFolder) {
        const label = row.createSpan({ cls: "comsift-person-label" });
        const target = this.plugin.app.vault.getFileByPath(owner);
        this.link(label, owner, target ? this.label(target) : name(owner), file.path);
      }
      const chips = row.createDiv({ cls: "comsift-person-chips" });
      for (const path of [...files].sort()) this.link(chips.createSpan({ cls: "comsift-person-chip is-link" }), path, name(path), file.path);
    }
    return groups.map(([owner]) => owner);
  }

  private drawSources(root: HTMLElement, file: TFile, records: CardRecord[], links: string[]) {
    const { vault } = this.plugin.app;
    const sheetLinks = links.map(value => markLinkTarget(value)).filter((target): target is string => !!target && /\.(?:sheet|csv)$|\.sheet\.md$|\.csv$/i.test(target));
    if (!records.length && !sheetLinks.length) return;
    const section = root.createDiv({ cls: "comsift-person-section comsift-person-sources" });
    section.createDiv({ cls: "comsift-person-section-title", text: "Sources" });
    const shown = new Set<string>();
    records.slice(0, 12).forEach(record => {
      const { path } = datasetParts(record.dataset);
      shown.add(path);
      const source = vault.getFileByPath(path);
      const box = section.createDiv({ cls: "comsift-person-source" });
      const caption = box.createDiv({ cls: "comsift-person-source-caption" });
      const label = path.split("/").at(-1)?.replace(/\.md$/, "").replace(/\.sheet$/, "") ?? path;
      // Maigret/Sherlock results are one note per account, not a row of a sheet.
      this.link(caption, path, toolReportKind(path) ? label : `${label}, row ${record.row + 1}`, file.path);
      if (record.section) caption.createSpan({ cls: "comsift-person-chip", text: record.section });
      if (!source || !/\.(?:sheet\.md|csv)$/i.test(path)) return;
      const cells = box.createDiv({ cls: "comsift-cells" });
      void vault.cachedRead(source).then(text => {
        const tables = tablesFromText(source.path, text);
        const sheet = pickSheet(tables, datasetParts(record.dataset).sheet);
        const located = sheet ? sourceCells(sheet.rows, record) : null;
        if (!located) { cells.remove(); return; }
        const ref = { sheet: sheet?.name, ranges: located.ranges };
        this.cells.mount(cells, source, ref);
        const embed = `![[${path.replace(/\.md$/, "")}#${formatCellRef(ref)}]]`;
        const copy = caption.createEl("button", { cls: "clickable-icon comsift-person-copy", attr: { "aria-label": `Copy embed: ${embed}` } });
        setIcon(copy, "copy");
        copy.addEventListener("click", () => { void navigator.clipboard.writeText(embed).then(() => new Notice("Cell embed copied.")); });
      }).catch(() => cells.remove());
    });
    if (records.length > 12) section.createDiv({ cls: "comsift-person-empty", text: `${records.length - 12} more rows are stored in this note's properties.` });
    const rest = sheetLinks.filter(target => !shown.has(this.plugin.app.metadataCache.getFirstLinkpathDest(target, file.path)?.path ?? target));
    if (rest.length) {
      const chips = section.createDiv({ cls: "comsift-person-chips" });
      for (const target of rest) {
        const dest = this.plugin.app.metadataCache.getFirstLinkpathDest(target, file.path);
        this.link(chips.createSpan({ cls: "comsift-person-chip is-link" }), dest?.path ?? target, target.split("/").at(-1) ?? target, file.path);
      }
    }
  }

  private drawActions(root: HTMLElement, file: TFile, primary: boolean, profile: boolean) {
    const bar = root.createDiv({ cls: "comsift-person-actions" });
    const button = (text: string, icon: string, run: () => void) => {
      const el = bar.createEl("button", { cls: "comsift-person-action" });
      setIcon(el.createSpan({ cls: "comsift-person-action-icon" }), icon);
      el.createSpan({ text });
      el.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); run(); });
    };
    button("Same as…", "equal", () => this.pickAndMark(file, "same"));
    button("Related to…", "users", () => this.pickAndMark(file, "related"));
    button("Uncertain…", "circle-help", () => this.pickAndMark(file, "uncertain"));
    button("Remove link…", "unlink", () => { void this.pickAndRemove(file); });
    button("Edit fields…", "pencil", () => this.editFields(file));
    button("Focus in graph", "focus", () => { void this.plugin.graphColors.focus(file); });
    if (!primary && profile) button("Promote to person", "user-round-plus", () => this.plugin.investigations.promptNewUser(file));
    if (primary) button("Open canvas", "layout-dashboard", () => {
      const item = this.plugin.investigations.forPrimaryPath?.(file.path);
      const canvas = item ? this.plugin.app.vault.getFileByPath(this.plugin.investigations.canvasPath(item)) : null;
      if (canvas) void this.plugin.app.workspace.getLeaf(false).openFile(canvas);
      else new Notice("This person has no Canvas.");
    });
  }

  private pickAndMark(file: TFile, type: SetMarkType) {
    const targets = this.targets(file.path);
    new PickModal(this.plugin.app, targets, target => this.label(target), target => {
      void this.mark(file, target, type).then(() => new Notice(`${MARK_LABELS[type]}: ${this.label(target)}`))
        .catch((error: unknown) => new Notice(error instanceof Error ? error.message : String(error)));
    }, `${MARK_LABELS[type]} as which person or account?`).open();
  }

  private editFields(file: TFile) {
    const modal = new Modal(this.plugin.app);
    modal.setTitle("Custom fields and links");
    modal.contentEl.createEl("p", { text: "Add a name and value for each field. Links open from the profile. Imported fields are preserved; a custom field with the same name overrides its displayed value." });
    const rows = modal.contentEl.createDiv();
    const entries: Array<{ key: HTMLInputElement; value: HTMLInputElement; removed: boolean }> = [];
    const add = (key = "", value = "") => {
      const row = rows.createDiv({ cls: "comsift-person-field-editor" });
      const entry = { key: row.createEl("input", { attr: { placeholder: "Field name", "aria-label": "Field name" }, value: key }), value: row.createEl("input", { attr: { placeholder: "Value or URL", "aria-label": "Value or URL" }, value }), removed: false };
      entries.push(entry);
      row.createEl("button", { text: "Remove" }).onclick = () => { entry.removed = true; row.remove(); };
    };
    for (const [key, value] of Object.entries(customFields(this.plugin.app.metadataCache.getFileCache(file)?.frontmatter))) add(key, value);
    if (!entries.length) add();
    modal.contentEl.createEl("button", { text: "Add field" }).onclick = () => add();
    const save = modal.contentEl.createEl("button", { text: "Save", cls: "mod-cta" });
    save.onclick = () => {
      const values = Object.fromEntries(entries.filter(entry => !entry.removed && entry.key.value.trim() && entry.value.value.trim()).map(entry => [entry.key.value.trim(), entry.value.value.trim()]));
      save.disabled = true;
      void this.plugin.app.fileManager.processFrontMatter(file, (frontmatter: Frontmatter) => {
        if (Object.keys(values).length) frontmatter.comsift_custom_fields = values;
        else delete frontmatter.comsift_custom_fields;
      }).then(() => modal.close()).catch(error => { save.disabled = false; new Notice(String(error)); });
    };
    modal.open();
  }

  private async pickAndRemove(file: TFile) {
    const canvas = await this.canvasRelations(file);
    const owner = this.plugin.investigations.forPath(file.path);
    if (!this.isPrimary(file.path) && owner) {
      const relation = await this.profileCanvasRelation(file, owner, this.plugin.app.metadataCache.getFileCache(file)?.frontmatter);
      if (relation) canvas.push(relation);
    }
    const reviewed = (await reviewRelations(this.plugin)).flatMap(relation => relation.source === file.path
      ? [{ path: relation.target, type: relation.type, origin: "review" as const }]
      : relation.target === file.path ? [{ path: relation.source, type: relation.type, origin: "review" as const }] : []);
    const direct = this.relations(file);
    for (const relation of reviewed) if (!direct.some(existing => existing.path === relation.path)) direct.push(relation);
    const removable = [...direct, ...canvas.filter(relation => !this.relations(file).some(mark => mark.path === relation.path))];
    if (!removable.length) { new Notice("This note has no relationship links."); return; }
    new PickModal(this.plugin.app, removable, relation => {
      const target = this.plugin.app.vault.getFileByPath(relation.path);
      return `${MARK_LABELS[relation.type]}: ${target ? this.label(target) : relation.path}`;
    }, relation => {
      void this.removeRelation(file, relation.path).catch((error: unknown) => new Notice(error instanceof Error ? error.message : String(error)));
    }, "Remove which link?").open();
  }

  /** Clear marks in both directions and typed arrows between these notes. */
  async removeRelation(file: TFile, targetPath: string): Promise<void> {
    await this.plugin.analysis.clearProfileRelation(file.path, targetPath);
    await this.writeMark(file, "none", targetPath);
    const target = this.plugin.app.vault.getFileByPath(targetPath);
    if (target) await this.writeMark(target, "none", file.path);
    for (const canvasFile of this.plugin.app.vault.getFiles().filter(candidate => candidate.extension === "canvas")) {
      const item = this.plugin.investigations.forPath(canvasFile.path);
      if (!item) continue;
      const data = parseCanvas(await this.plugin.app.vault.read(canvasFile));
      const primary = this.plugin.investigations.mdPath(item);
      const changed = clearCanvasRelation(data, primary, file.path, targetPath, item.folderPath.split("/").at(-1));
      if (changed) await this.plugin.app.vault.modify(canvasFile, JSON.stringify(data, null, 2));
    }
    this.plugin.graphColors?.schedule?.(300);
  }

  /** Write a mark from `file` to `target` (a person's primary note or another profile). */
  async mark(file: TFile, target: TFile, type: SetMarkType): Promise<void> {
    // Replace the relationship everywhere, including a contrary mark in the other note.
    await this.removeRelation(file, target.path);
    await this.writeMark(file, type, target.path);
  }

  private async writeMark(holder: TFile, type: MarkType, targetPath: string): Promise<void> {
    const link = `[[${targetPath.replace(/\.md$/, "")}]]`;
    await this.plugin.app.fileManager.processFrontMatter(holder, (frontmatter: Frontmatter) => {
      setMark(frontmatter, type, link, value => this.resolve(value, holder.path) === targetPath || markLinkTarget(value) === targetPath.replace(/\.md$/, ""));
    });
    this.plugin.graphColors?.schedule?.(300);
  }

  /** Save the original text of notes about to be rewritten; returns the backup file path. */
  async backupNotes(notes: Array<{ path: string; content: string }>, label: string): Promise<string> {
    const { vault } = this.plugin.app;
    const folder = normalizePath(`${vault.configDir}/plugins/${this.plugin.manifest.id}/profile-backups/${Date.now()}-${label}`);
    let path = "";
    for (const part of folder.split("/")) {
      path = path ? `${path}/${part}` : part;
      if (!(await vault.adapter.exists(path))) await vault.adapter.mkdir(path);
    }
    const file = `${folder}/notes.json`;
    await vault.adapter.write(file, JSON.stringify(notes));
    return file;
  }

  /**
   * Run on layout ready (main.ts), before connection upgrades rewrite profiles.
   * Replace the old `<!-- comsift:profile:start -->` block with the card block in every connection profile.
   * People's primary notes get their layout from `InvestigationService.normalizePrimaries`.
   * Originals are saved to a backup file first.
   */
  async migrate(): Promise<number> {
    const { vault, metadataCache } = this.plugin.app;
    const changes: Array<{ file: TFile; content: string }> = [];
    for (const file of vault.getMarkdownFiles()) {
      if (this.isPrimary(file.path)) continue;
      if (!isConnectionProfile(file.path) && typeof metadataCache.getFileCache(file)?.frontmatter?.comsift_profile_data !== "string") continue;
      const content = await vault.cachedRead(file);
      if (hasPersonCard(content)) continue;
      // Notes in a Connections folder that hold no imported rows are the user's own; leave them alone.
      if (!content.includes("<!-- comsift:profile:start -->") && !readProfileRecords(content).length) continue;
      if (upgradeProfileNote(content) !== content) changes.push({ file, content });
    }
    if (!changes.length) return 0;
    const backup = await this.backupNotes(changes.map(change => ({ path: change.file.path, content: change.content })), "person-cards");
    let done = 0;
    for (const change of changes) {
      try { await vault.process(change.file, current => upgradeProfileNote(current)); done++; }
      catch (error) { console.error(`[comsift] could not add the person card to ${change.file.path}`, error); }
    }
    new Notice(`Comsift: ${done} notes now show a person card. Backup of the old text: ${backup}`, 10000);
    return done;
  }
}
