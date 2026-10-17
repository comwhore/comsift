import { Modal, Notice, Setting, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";
import ComsiftPlugin from "../main";
import { uuid } from "../tool";
import { safeName, legacyPairId, stripLegacyBlocks } from "./legacy";
import { randomColor } from "./colors";
import { convertLegacyTitle, frontmatterTitle, withCanvasEmbed, withTitle } from "./primaryNote";

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

  /** Move old `<!-- …:title -->` headings into the `title` property; add a title where missing. */
  async normalizePrimaries() {
    for (const item of Object.values(this.plugin.state.investigations)) {
      const file = this.plugin.app.vault.getFileByPath(this.mdPath(item));
      if (!file) continue;
      const name = item.folderPath.split("/").at(-1) ?? item.folderPath;
      const current = await this.plugin.app.vault.read(file);
      const upgrade = (text: string) => {
        const converted = convertLegacyTitle(text);
        const titled = frontmatterTitle(converted) ? converted : withTitle(converted, name);
        return this.plugin.setting.embedCanvas ? withCanvasEmbed(titled, `${name}.canvas`, this.plugin.setting.embedDivider) : titled;
      };
      if (upgrade(current) === current) continue;
      this.renameLock = true;
      try { await this.plugin.app.vault.process(file, upgrade); }
      finally { this.renameLock = false; }
    }
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
    if (profile) modal.contentEl.createEl("p", { text: `Source profile: ${profile.path}. The original note stays where it is and appears on the new person's Canvas.` });
    new Setting(modal.contentEl).setName("Graph color").setDesc("Color of this person in Graph View. A random one is picked for you.")
      .addColorPicker(picker => picker.setValue(color).onChange(value => { color = value; }))
      .addExtraButton(button => button.setIcon("dices").setTooltip("Another random color").onClick(() => {
        color = randomColor();
        const input = modal.contentEl.querySelector<HTMLInputElement>("input[type=color]");
        if (input) input.value = color;
      }));
    new Setting(modal.contentEl).addButton(button => button.setButtonText("Create").setCta().onClick(async () => {
      try {
        const item = await this.create(name, color, profile);
        modal.close();
        const canvas = this.plugin.app.vault.getFileByPath(this.canvasPath(item));
        if (canvas) await this.plugin.app.workspace.getLeaf(true).openFile(canvas);
        new Notice(`Created person ${name.trim()}.`);
      } catch (error) { new Notice((error as Error).message, 8000); }
    }));
    modal.open();
  }

  async create(name: string, color = randomColor(), profile?: TFile): Promise<Investigation> {
    const clean = safeName(name);
    const root = this.usersRoot();
    const folderPath = this.destination(clean);
    if (this.plugin.app.vault.getAbstractFileByPath(folderPath)) throw new Error(`Folder already exists: ${folderPath}`);
    if (root) await this.ensureFolder(root);
    await this.plugin.app.vault.createFolder(folderPath);
    const item: Investigation = { id: uuid(), folderPath, color };
    const titled = withTitle(`---\ncomsift_id: ${item.id}\n---\n\n`, clean);
    const linked = profile ? `${titled}\nSource profile: [[${profile.path.replace(/\.md$/i, "")}]]\n` : titled;
    const md = this.plugin.setting?.embedCanvas === false ? linked : withCanvasEmbed(linked, `${clean}.canvas`, this.plugin.setting?.embedDivider !== false);
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
    modal.contentEl.createEl("p", { text: "A snapshot is created first. Canvas data is preserved. Recognized generated JSON blocks are removed; handwritten and unrecognized text remains." });
    new Setting(modal.contentEl).addButton(button => button.setButtonText("Migrate").setCta().onClick(async () => {
      try {
        const item = await this.migrate(file, sourceCanvas, content);
        modal.close();
        new Notice(`Migrated to ${item.folderPath}. Backup retained.`, 10000);
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
    if (this.plugin.setting?.embedCanvas !== false) next = withCanvasEmbed(next, `${name}.canvas`, this.plugin.setting?.embedDivider !== false);
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
