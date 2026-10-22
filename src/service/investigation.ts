import { Modal, Notice, Setting, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";
import ComsiftPlugin from "../main";
import { uuid } from "../tool";
import { safeName, legacyPairId, stripLegacyBlocks } from "./legacy";
import { randomColor } from "./colors";
import { convertLegacyTitle, frontmatterTitle, primaryNoteLayout, withTitle } from "./primaryNote";
import { promises as fs } from "fs";
import { isAbsolute, join, resolve } from "path";
import { homedir } from "os";
import { relocatePersonText, safeRelativePath } from "./personPortability";
import { upgradeProfileNote } from "../analysis/profileIdentity";

export interface Investigation { id: string; folderPath: string; /** Graph View color, #rrggbb. */ color?: string }


export class InvestigationService {
  private renameLock = false;
  private titleTimers = new Map<string, number>();
  constructor(private plugin: ComsiftPlugin) {}

  start() {
    this.plugin.registerEvent(this.plugin.app.vault.on("rename", (file, oldPath) => {
      void this.onRename(file, oldPath).catch(error => new Notice(`Comsift rename: ${(error as Error).message}`));
    }));
    this.plugin.registerEvent(this.plugin.app.vault.on("delete", file => {
      void this.onDelete(file.path).catch(error => new Notice(`Comsift delete: ${(error as Error).message}`));
    }));
    this.plugin.app.workspace?.onLayoutReady(() => {
      void this.pruneMissing().then(() => this.normalizePrimaries())
        .catch(error => console.error("[comsift] startup maintenance failed", error));
    });
    this.plugin.registerEvent(this.plugin.app.vault.on("modify", file => {
      if (!(file instanceof TFile) || file.extension !== "md" || !this.forPrimaryPath(file.path)) return;
      const prior = this.titleTimers.get(file.path);
      if (prior) window.clearTimeout(prior);
      this.titleTimers.set(file.path, window.setTimeout(() => {
        this.titleTimers.delete(file.path);
        void this.onTitleChanged(file).catch(error => new Notice(`Comsift title: ${(error as Error).message}`));
      }, 500));
    }));
  }

  /** Drop people whose folder (or an ancestor) was deleted, plus their per-canvas tool state. */
  private async onDelete(path: string) {
    const gone = Object.values(this.plugin.state.investigations)
      .filter(item => item.folderPath === path || item.folderPath.startsWith(path + "/"));
    if (gone.length) await this.forget(gone);
  }

  /** People deleted while the plugin was off. */
  private async pruneMissing() {
    const gone = Object.values(this.plugin.state.investigations)
      .filter(item => !this.plugin.app.vault.getFolderByPath(item.folderPath));
    if (gone.length) await this.forget(gone);
  }

  /** Layout of a person's primary note from the current settings (card, Canvas embed, `***`, `## Notes`). */
  primaryLayout(content: string, name: string): string {
    const setting = this.plugin.setting ?? {};
    const card = setting.personCards !== false;
    // Old generated profile blocks (promoted profiles) become the card; their rows move to frontmatter.
    const carded = card ? upgradeProfileNote(content, true) : content;
    return primaryNoteLayout(carded, { name, card, embedCanvas: setting.embedCanvas !== false, divider: setting.embedDivider !== false });
  }

  /**
   * Move old `<!-- …:title -->` headings into the `title` property, add a title where missing and put the note
   * in the current layout. Originals of changed notes are backed up first (profile-backups/<time>-person-notes).
   */
  async normalizePrimaries() {
    const changes: Array<{ file: TFile; content: string; upgrade: (text: string) => string }> = [];
    for (const item of Object.values(this.plugin.state.investigations)) {
      const file = this.plugin.app.vault.getFileByPath(this.mdPath(item));
      if (!file) continue;
      const name = item.folderPath.split("/").at(-1) ?? item.folderPath;
      const current = await this.plugin.app.vault.read(file);
      const upgrade = (text: string) => {
        const converted = convertLegacyTitle(text);
        const titled = frontmatterTitle(converted) ? converted : withTitle(converted, name);
        return this.primaryLayout(titled, name);
      };
      if (upgrade(current) !== current) changes.push({ file, content: current, upgrade });
    }
    if (!changes.length) return;
    await this.plugin.personCards?.backupNotes(changes.map(change => ({ path: change.file.path, content: change.content })), "person-notes");
    for (const change of changes) {
      this.renameLock = true;
      try { await this.plugin.app.vault.process(change.file, change.upgrade); }
      catch (error) { console.error(`[comsift] could not update ${change.file.path}`, error); }
      finally { this.renameLock = false; }
    }
    new Notice(`Comsift: updated the layout of ${changes.length} people's notes.`, 6000);
  }

  private async forget(items: Investigation[]) {
    const { state } = this.plugin;
    for (const item of items) {
      delete state.investigations[item.id];
      const inside = (key: string) => key === item.folderPath || key.startsWith(item.folderPath + "/");
      for (const bucket of [state.sherlockChildren, state.maigretChildren]) {
        for (const key of Object.keys(bucket)) if (inside(key)) delete bucket[key];
      }
      state.graphManagedFiles = state.graphManagedFiles.filter(path => !inside(path));
    }
    await this.plugin.saveState();
    this.plugin.graphColors?.schedule(300);
    new Notice(`Comsift: removed ${items.map(item => item.folderPath.split("/").at(-1)).join(", ")} from the user index.`);
  }

  forCanvasPath(path: string): Investigation | null {
    return Object.values(this.plugin.state.investigations).find(item => path === this.canvasPath(item) || path.startsWith(item.folderPath + "/")) ?? null;
  }

  forPrimaryPath(path: string): Investigation | null {
    return Object.values(this.plugin.state.investigations).find(item => path === this.mdPath(item)) ?? null;
  }

  forPath(path: string): Investigation | null {
    return Object.values(this.plugin.state.investigations).find(item => path === item.folderPath || path.startsWith(item.folderPath + "/")) ?? null;
  }

  mdPath(item: Investigation): string { return `${item.folderPath}/${item.folderPath.split("/").at(-1)}.md`; }
  canvasPath(item: Investigation): string { return `${item.folderPath}/${item.folderPath.split("/").at(-1)}.canvas`; }

  private usersRoot(): string {
    const configured = this.plugin.setting.usersFolder.trim();
    if (!configured || configured === "/") return "";
    if (configured.startsWith("/") || configured.startsWith("../") || configured.includes("/../") || configured === "..") {
      throw new Error("Users folder must be vault-relative, or blank for the vault root.");
    }
    return normalizePath(configured);
  }

  private destination(name: string): string {
    const root = this.usersRoot();
    return normalizePath(root ? `${root}/${name}` : name);
  }

  promptNewUser(profile?: TFile) {
    const modal = new Modal(this.plugin.app);
    modal.setTitle("New person");
    const suggested = profile ? profile.basename : "";
    let name = suggested;
    let color = randomColor();
    const examples = ["Alex", "Sam", "Jordan", "Taylor", "Morgan"];
    const example = examples[Math.floor(Math.random() * examples.length)];
    new Setting(modal.contentEl).setName("Name").addText(input => input.setPlaceholder(example).setValue(suggested).onChange(value => { name = value; }));
    let depth = 1;
    if (profile) {
      modal.contentEl.createEl("p", { text: `Promote ${profile.path} into this person's main note and carry its connections.` });
      new Setting(modal.contentEl).setName("Connection depth").setDesc("Immediate connections are included at depth 1. Higher values follow their connections; depth 0 carries only this profile.")
        .addSlider(slider => slider.setLimits(0, 10, 1).setValue(depth).onChange(value => { depth = value; }));
    }
    new Setting(modal.contentEl).setName("Graph color").setDesc("Pick a color for this person.")
      .addColorPicker(picker => picker.setValue(color).onChange(value => { color = value; }))
      .addExtraButton(button => button.setIcon("dices").setTooltip("Another random color").onClick(() => {
        color = randomColor();
        const input = modal.contentEl.querySelector<HTMLInputElement>("input[type=color]");
        if (input) input.value = color;
      }));
    new Setting(modal.contentEl)
      .addButton(button => button.setButtonText("Import folder").onClick(() => this.pickImportFolder(() => modal.close())))
      .addButton(button => button.setButtonText("Create person").setCta().onClick(async () => {
      try {
        const item = await this.create(name, color, profile, depth);
        modal.close();
        const canvas = this.plugin.app.vault.getFileByPath(this.canvasPath(item));
        if (canvas) await this.plugin.app.workspace.getLeaf(true).openFile(canvas);
      } catch (error) { new Notice((error as Error).message, 8000); }
    }));
    modal.open();
  }

  pickImportFolder(onImported?: () => void) {
    const input = createEl("input");
    input.type = "file";
    input.setAttribute("webkitdirectory", "");
    input.multiple = true;
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      if (!files.length) return;
      void this.importFolder(files).then(async item => {
        onImported?.();
        const file = this.plugin.app.vault.getFileByPath(this.mdPath(item));
        if (file) await this.plugin.app.workspace.getLeaf(true).openFile(file);
        new Notice(`Imported ${item.folderPath}.`);
      }).catch(error => new Notice(`Import failed: ${(error as Error).message}`, 10000));
    };
    input.click();
  }

  async importFolder(files: File[]): Promise<Investigation> {
    const entries = files.map(file => ({ file, path: safeRelativePath(file.webkitRelativePath || file.name) }));
    const sourceName = entries[0]?.path.split("/")[0];
    if (!sourceName || entries.some(entry => !entry.path.startsWith(sourceName + "/"))) throw new Error("Choose one person folder.");
    const manifestFile = entries.find(entry => entry.path === `${sourceName}/comsift-person.json`);
    const manifest = manifestFile ? JSON.parse(await manifestFile.file.text()) as { folderPath?: string; name?: string; color?: string } : {};
    const name = safeName(manifest.name || sourceName);
    const folderPath = this.destination(name);
    if (this.plugin.app.vault.getAbstractFileByPath(folderPath)) throw new Error(`Folder already exists: ${folderPath}`);
    const primary = entries.find(entry => entry.path === `${sourceName}/${name}.md`);
    if (!primary) throw new Error(`Missing primary note ${name}.md. Choose an exported person folder.`);
    const sourcePath = manifest.folderPath || sourceName;
    const item: Investigation = { id: uuid(), folderPath, color: /^#[0-9a-f]{6}$/i.test(manifest.color ?? "") ? manifest.color : randomColor() };
    // Validate and load everything before creating the destination.
    const prepared = await Promise.all(entries.filter(entry => entry !== manifestFile).map(async entry => {
      const relative = safeRelativePath(entry.path.slice(sourceName.length + 1));
      const target = `${folderPath}/${relative}`;
      if (/\.(md|canvas|json|csv|sheet)$/i.test(relative)) {
        let text = relocatePersonText(await entry.file.text(), sourcePath, folderPath);
        if (entry === primary) {
          text = text.replace(/^comsift_id:[^\r\n]*$/m, `comsift_id: ${item.id}`);
          if (!/^comsift_id:/m.test(text)) text = text.startsWith("---\n") ? text.replace(/^---\n/, `---\ncomsift_id: ${item.id}\n`) : `---\ncomsift_id: ${item.id}\n---\n${text}`;
        }
        return { target, text, data: undefined };
      }
      return { target, text: undefined, data: await entry.file.arrayBuffer() };
    }));
    await this.ensureFolder(folderPath);
    try {
      for (const entry of prepared) {
        const parent = entry.target.slice(0, entry.target.lastIndexOf("/"));
        await this.ensureFolder(parent);
        if (entry.text !== undefined) await this.plugin.app.vault.create(entry.target, entry.text);
        else await this.plugin.app.vault.createBinary(entry.target, entry.data);
      }
      if (!this.plugin.app.vault.getFileByPath(this.canvasPath(item))) await this.plugin.app.vault.create(this.canvasPath(item), JSON.stringify({ nodes: [], edges: [] }));
      this.plugin.state.investigations[item.id] = item;
      await this.plugin.saveState();
      await this.plugin.graph.refreshInvestigation(item);
      this.plugin.graphColors?.schedule(300);
      return item;
    } catch (error) {
      new Notice(`Import incomplete in ${folderPath}; inspect that folder before retrying.`, 10000);
      throw error;
    }
  }

  promptExport(item: Investigation) {
    const modal = new Modal(this.plugin.app);
    modal.setTitle("Export person folder");
    const defaultDirectory = this.plugin.setting.defaultExportDirectory?.trim() || homedir();
    let directory = this.plugin.setting.lastExportDirectory?.trim() || defaultDirectory;
    new Setting(modal.contentEl).setName("Export directory").setDesc(`Creates a new ${item.folderPath.split("/").at(-1)} folder here, including notes, sheets, connections and attachments. Existing folders are never overwritten. Leave blank to use ${defaultDirectory}.`)
      .addText(input => input.setPlaceholder(defaultDirectory).setValue(directory).onChange(value => { directory = value.trim(); }));
    new Setting(modal.contentEl).addButton(button => button.setButtonText("Export").setCta().onClick(async () => {
      try { const destination = await this.exportToDirectory(item, directory); modal.close(); new Notice(`Exported to ${destination}.`); }
      catch (error) { new Notice(`Export failed: ${(error as Error).message}`, 10000); }
    }));
    modal.open();
  }

  async exportToDirectory(item: Investigation, directory: string) {
    const requested = directory.trim() || this.plugin.setting.defaultExportDirectory?.trim() || homedir();
    if (!isAbsolute(requested)) throw new Error("Enter an absolute export directory.");
    const parent = resolve(requested);
    const destination = join(parent, item.folderPath.split("/").at(-1)!);
    await this.exportFolder(item, destination);
    this.plugin.setting.lastExportDirectory = parent;
    await this.plugin.saveSettings();
    return destination;
  }

  async exportFolder(item: Investigation, destination: string) {
    if (!destination || resolve(destination) !== destination) throw new Error("Enter an absolute destination path.");
    const files = this.plugin.app.vault.getFiles().filter(file => file.path.startsWith(item.folderPath + "/"));
    // Nonrecursive mkdir refuses an existing folder, so an export never overwrites files.
    await fs.mkdir(destination);
    for (const file of files) {
      const relative = safeRelativePath(file.path.slice(item.folderPath.length + 1));
      const output = join(destination, relative);
      await fs.mkdir(join(output, ".."), { recursive: true });
      await fs.writeFile(output, new Uint8Array(await this.plugin.app.vault.readBinary(file)));
    }
    await fs.writeFile(join(destination, "comsift-person.json"), JSON.stringify({ format: "comsift-person", version: 1, folderPath: item.folderPath, name: item.folderPath.split("/").at(-1), color: item.color }, null, 2));
  }

  async create(name: string, color = randomColor(), profile?: TFile, depth = 1): Promise<Investigation> {
    if (profile && this.plugin.analysis?.promoteProfile) {
      const promoted = this.forPrimaryPath(profile.path);
      if (promoted) return promoted;
      const item = await this.create(name, color);
      await this.plugin.analysis.promoteProfile(profile, item, depth);
      return item;
    }
    const clean = safeName(name);
    const root = this.usersRoot();
    const folderPath = this.destination(clean);
    if (this.plugin.app.vault.getAbstractFileByPath(folderPath)) throw new Error(`Folder already exists: ${folderPath}`);
    if (root) await this.ensureFolder(root);
    await this.plugin.app.vault.createFolder(folderPath);
    const item: Investigation = { id: uuid(), folderPath, color };
    const titled = withTitle(`---\ncomsift_id: ${item.id}\n---\n\n`, clean);
    const linked = profile ? `${titled}\nSource profile: [[${profile.path.replace(/\.md$/i, "")}]]\n` : titled;
    const md = this.primaryLayout(linked, clean);
    const nodes: Array<Record<string, unknown>> = [{ id: "comsift-main", type: "text", text: clean, x: 0, y: 0, width: 340, height: 96 }];
    const edges: Array<Record<string, unknown>> = [];
    if (profile) {
      nodes.push({ id: "comsift-source-profile", type: "file", file: profile.path, x: 540, y: 0, width: 400, height: 300 });
      edges.push({ id: "comsift-source-link", fromNode: "comsift-main", fromSide: "right", toNode: "comsift-source-profile", toSide: "left", comsift_type: "same", label: clean, color });
    }
    const canvas = JSON.stringify({ nodes, edges }, null, 2);
    try {
      await this.plugin.app.vault.create(this.mdPath(item), md);
      await this.plugin.app.vault.create(this.canvasPath(item), canvas);
      this.plugin.state.investigations[item.id] = item;
      await this.plugin.saveState();
      await this.plugin.graph.refreshInvestigation(item);
      this.plugin.graphColors?.schedule(300);
      return item;
    } catch (error) {
      new Notice(`Person creation incomplete in ${folderPath}; inspect the folder before retrying.`, 10000);
      throw error;
    }
  }

  isLegacyPair(file: TFile): boolean {
    if (file.extension !== "md" || this.forPath(file.path)) return false;
    return this.plugin.app.vault.getFileByPath(file.path.replace(/\.md$/i, ".canvas")) !== null;
  }

  async showMigration(file: TFile) {
    if (!this.isLegacyPair(file)) return;
    const sourceCanvas = this.plugin.app.vault.getFileByPath(file.path.replace(/\.md$/i, ".canvas"));
    if (!sourceCanvas) return;
    const content = await this.plugin.app.vault.read(file);
    const name = safeName(file.basename);
    const destination = this.destination(name);
    const modal = new Modal(this.plugin.app);
    modal.setTitle("Migrate legacy pair");
    modal.contentEl.createEl("p", { text: `${file.path} + ${sourceCanvas.path} → ${destination}/` });
    modal.contentEl.createEl("p", { text: "Backs up both files, moves them into the person's folder, and removes old generated JSON blocks." });
    new Setting(modal.contentEl).addButton(button => button.setButtonText("Migrate").setCta().onClick(async () => {
      try {
        await this.migrate(file, sourceCanvas, content);
        modal.close();
      } catch (error) { new Notice(`Migration stopped: ${(error as Error).message}`, 12000); }
    }));
    modal.open();
  }

  async migrate(mdFile: TFile, canvasFile: TFile, original?: string): Promise<Investigation> {
    if (!this.isLegacyPair(mdFile)) throw new Error("Already migrated or no matching Canvas file.");
    const name = safeName(mdFile.basename);
    const root = this.usersRoot();
    const destination = this.destination(name);
    if (this.plugin.app.vault.getAbstractFileByPath(destination)) throw new Error(`Destination exists: ${destination}`);
    const content = original ?? await this.plugin.app.vault.read(mdFile);
    const backupRoot = root ? `${root}/Backups` : "Comsift/Backups";
    const backup = normalizePath(`${backupRoot}/${name}-${Date.now()}`);
    await this.ensureFolder(backupRoot);
    await this.plugin.app.vault.createFolder(backup);
    await this.plugin.app.vault.copy(mdFile, `${backup}/${mdFile.name}`);
    await this.plugin.app.vault.copy(canvasFile, `${backup}/${canvasFile.name}`);
    await this.plugin.app.vault.createFolder(destination);
    const item = { id: legacyPairId(content) ?? uuid(), folderPath: destination };
    const currentTitle = content.match(/(?:^|\n)# ([^\r\n]+)/)?.[1]?.trim() || name;
    let next = stripLegacyBlocks(content, await this.plugin.app.vault.read(canvasFile));
    const frontmatter = next.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    let metadata = frontmatter?.[1] ?? "";
    if (frontmatter) next = next.slice(frontmatter[0].length);
    metadata = metadata.replace(/^whereami:\s*\r?\n(?:^[ \t]+[^\r\n]*\r?\n?)*/m, "").trim();
    metadata = metadata ? `${metadata}\ncomsift_id: ${item.id}` : `comsift_id: ${item.id}`;
    const body = convertLegacyTitle(next).replace(/^\s*# [^\r\n]+\r?\n?/, "").trimStart();
    next = withTitle(`---\n${metadata}\n---\n\n${body}`, currentTitle);
    next = this.primaryLayout(next, name);
    try {
      await this.plugin.app.fileManager.renameFile(mdFile, `${destination}/${name}.md`);
      await this.plugin.app.fileManager.renameFile(canvasFile, `${destination}/${name}.canvas`);
      await this.plugin.app.vault.process(mdFile, () => next);
      this.plugin.state.investigations[item.id] = item;
      await this.plugin.saveState();
      await this.plugin.graph.refreshInvestigation(item);
      await this.plugin.graphColors?.apply(false);
      return item;
    } catch (error) {
      new Notice(`Migration incomplete. Snapshot: ${backup}. Original files may need manual restoration.`, 12000);
      throw error;
    }
  }

  private async onRename(file: TAbstractFile, oldPath: string) {
    if (this.renameLock) return;
    const item = Object.values(this.plugin.state.investigations).find(entry =>
      oldPath === entry.folderPath || oldPath === this.mdPath(entry) || oldPath === this.canvasPath(entry));
    if (!item) return;
    if (!(file instanceof TFolder) && !(file instanceof TFile)) return;
    const name = safeName(file instanceof TFolder ? file.name : file.basename);
    await this.rename(item, name, file, oldPath);
  }

  private async onTitleChanged(file: TFile) {
    if (this.renameLock) return;
    const item = this.forPrimaryPath(file.path);
    if (!item) return;
    const name = frontmatterTitle(await this.plugin.app.vault.read(file));
    if (name && name !== item.folderPath.split("/").at(-1)) await this.rename(item, safeName(name));
  }

  async rename(item: Investigation, name: string, source?: TAbstractFile, oldPath?: string) {
    const clean = safeName(name);
    const oldFolder = item.folderPath;
    const parent = oldFolder.includes("/") ? oldFolder.slice(0, oldFolder.lastIndexOf("/")) : "";
    const newFolder = normalizePath(parent ? `${parent}/${clean}` : clean);
    const destination = this.plugin.app.vault.getAbstractFileByPath(newFolder);
    if (newFolder !== oldFolder && destination && destination !== source) throw new Error(`Folder already exists: ${newFolder}`);
    const oldBase = oldFolder.split("/").at(-1)!;
    this.renameLock = true;
    try {
      if (source instanceof TFolder) item.folderPath = source.path;
      else if (newFolder !== oldFolder) {
        const folder = this.plugin.app.vault.getFolderByPath(oldFolder);
        if (!folder) throw new Error("Investigation folder missing.");
        await this.plugin.app.vault.rename(folder, newFolder);
        item.folderPath = newFolder;
      }
      const targetMd = this.mdPath(item);
      const targetCanvas = this.canvasPath(item);
      const md = this.plugin.app.vault.getFileByPath(`${item.folderPath}/${oldBase}.md`) ??
        (source instanceof TFile && source.extension === "md" ? source : null);
      const canvas = this.plugin.app.vault.getFileByPath(`${item.folderPath}/${oldBase}.canvas`) ??
        (source instanceof TFile && source.extension === "canvas" ? source : null);
      for (const [file, target] of [[md, targetMd], [canvas, targetCanvas]] as [TFile | null, string][]) {
        if (!file || file.path === target) continue;
        if (this.plugin.app.vault.getAbstractFileByPath(target)) throw new Error(`File already exists: ${target}`);
        await this.plugin.app.fileManager.renameFile(file, target);
      }
      const primary = this.plugin.app.vault.getFileByPath(targetMd);
      if (primary) await this.plugin.app.vault.process(primary, text => withTitle(convertLegacyTitle(text), clean));
      const mainCanvas = this.plugin.app.vault.getFileByPath(targetCanvas);
      if (mainCanvas) await this.plugin.app.vault.process(mainCanvas, text => {
        try {
          const data = JSON.parse(text) as { nodes?: Array<{ id: string; text?: string }> };
          const main = data.nodes?.find(node => node.id === "comsift-main" || node.id === "whereami-main");
          if (!main) return text;
          main.text = clean;
          return JSON.stringify(data, null, 2);
        } catch { return text; }
      });
      await this.plugin.saveState();
    } catch (error) {
      new Notice(`Rename incomplete. Inspect ${oldPath ?? oldFolder} and ${item.folderPath}.`, 10000);
      throw error;
    } finally { this.renameLock = false; }
  }

  private async ensureFolder(path: string) {
    let current = "";
    for (const part of path.split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      if (!this.plugin.app.vault.getAbstractFileByPath(current)) await this.plugin.app.vault.createFolder(current);
      else if (!this.plugin.app.vault.getFolderByPath(current)) throw new Error(`Not a folder: ${current}`);
    }
  }
}
