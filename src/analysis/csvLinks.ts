import { createHash } from "crypto";
import { Modal, Notice, TFile, normalizePath, type App, type Plugin } from "obsidian";
import { isSheetPath, parseSheetMd } from "./sheets";

const SOURCE = "comsift_csv_source";
const FRONT = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
export function csvSource(text: string): string | null {
  const raw = text.match(FRONT)?.[1].match(/^comsift_csv_source:\s*(.+)$/m)?.[1]?.trim();
  if (!raw) return null;
  let path = raw;
  try { const value: unknown = JSON.parse(raw); if (typeof value !== "string") return null; path = value; } catch { path = raw.replace(/^'|'$/g, ""); }
  path = path.replace(/^\[\[|\]\]$/g, "");
  if (!path.toLowerCase().endsWith(".csv") || path.startsWith("/") || path.includes("\\") || path.split("/").some(part => !part || part.startsWith("."))) return null;
  return normalizePath(path);
}
export function linkCsv(text: string, source: string): string {
  const front = text.match(FRONT);
  const metadata = (front?.[1] ?? "").replace(/^comsift_csv_source:[^\n]*(?:\n|$)/m, "").trimEnd();
  return `---\n${metadata ? metadata + "\n" : ""}${SOURCE}: ${JSON.stringify(`[[${source}]]`)}\n---\n${front ? text.slice(front[0].length) : text}`;
}
export function csvWithOriginalFormat(rows: string[][], original: string): string {
  const line = original.replace(/^\uFEFF/, "").split(/\r?\n/)[0] ?? "";
  const counts = new Map([[",", 0], [";", 0], ["\t", 0]]);
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"') { if (quoted && line[index + 1] === '"') index++; else quoted = !quoted; }
    else if (!quoted && counts.has(char)) counts.set(char, counts.get(char)! + 1);
  }
  const delimiter = [...counts].sort((a,b) => b[1] - a[1])[0][0];
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const cell = (value: string) => value.includes(delimiter) || /["\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return (original.startsWith("\uFEFF") ? "\uFEFF" : "") + rows.map(row => row.map(cell).join(delimiter)).join(newline) + (rows.length && /\r?\n$/.test(original) ? newline : "");
}
/** Update values in the linked first tab while retaining its layout and other tabs. */
export function mergeCsvSheet(prior: string, imported: string): string {
  const sheets = (text: string): Record<string, unknown>[] => {
    const start = text.search(/^\[/m);
    if (start < 0) return [];
    const value: unknown = JSON.parse(text.slice(start));
    if (!Array.isArray(value) || value.some((item: unknown) => !item || typeof item !== "object" || Array.isArray(item))) throw new Error("Invalid sheet data.");
    return value as Record<string, unknown>[];
  };
  const old = sheets(prior), fresh = sheets(imported);
  const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const oldRows = record(old[0]?.rows), freshRows = record(fresh[0]?.rows);
  const rows = Object.fromEntries(Object.entries(freshRows).map(([key, value]) => {
    if (typeof value !== "object" || !value) return [key, value];
    const oldRow = record(oldRows[key]), row = record(value);
    const previousCells = record(oldRow.cells);
    const cells = Object.fromEntries(Object.entries(record(row.cells)).map(([column, cell]) => [column, { ...record(previousCells[column]), ...record(cell) }]));
    return [key, { ...oldRow, ...row, cells }];
  }));
  const data = old.length && fresh.length ? [{ ...old[0], rows }, ...old.slice(1)] : fresh;
  const header = prior.match(FRONT)?.[0] ?? imported.match(FRONT)?.[0] ?? "";
  return `${header}# Excel\n${JSON.stringify(data)}`;
}
function fingerprint(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function firstRows(text: string): string[][] {
  const start = text.search(/^\[/m);
  if (start < 0) throw new Error("Invalid sheet data.");
  const value: unknown = JSON.parse(text.slice(start));
  if (!Array.isArray(value)) throw new Error("Invalid sheet data.");
  return parseSheetMd(`# Excel\n${JSON.stringify(value.slice(0,1))}`)[0]?.rows ?? [];
}
function revision(text: string, key: string): string | null { return text.match(FRONT)?.[1].match(new RegExp(`^${key}: ([a-f0-9]{64})$`, "m"))?.[1] ?? null; }
function stamp(text: string, source: string, csv: string): string {
  let linked = linkCsv(text, source);
  for (const [key, value] of [["comsift_csv_revision", fingerprint(csv)], ["comsift_sheet_revision", fingerprint(JSON.stringify(firstRows(text)))]]) {
    linked = linked.replace(new RegExp(`^${key}:[^\n]*(?:\n|$)`, "m"), "");
    linked = linked.replace(/^---\n/, `---\n${key}: ${value}\n`);
  }
  return linked;
}
interface ExcelCsvHooks extends Plugin {
  shouldSyncCsv(path: string): boolean;
  buildSheetMdBodyFromCsvText(text: string): string;
  refreshOpenExcelViewsForSheet(path: string): Promise<void>;
  registerCsvSyncService(): void;
  syncPairedCsvFromSheetSave(file: TFile, json: string): Promise<void>;
  importLinkedCsv(file: TFile, source: File): Promise<void>;
}
/** Keep the CSV as a real source file; the sheet is its explicitly linked editing view. */
export class CsvSheetLinks {
  private pairs = new Map<string, string>();
  private written = new Map<string, string>();
  private headers = new Map<string, string>();
  private queues = new Map<string, Promise<unknown>>();
  private timers = new Map<string, number>();
  private failures = new Map<string, string>();
  private finishStartup: () => void = () => {};
  private ready = new Promise<void>(resolve => { this.finishStartup = resolve; });
  constructor(private app: App, private host: ExcelCsvHooks) {}
  private enqueue<T>(key: string, action: () => Promise<T>): Promise<T> {
    const work = (this.queues.get(key) ?? Promise.resolve()).then(action);
    const settled = work.catch(() => {});
    this.queues.set(key, settled);
    void settled.then(() => { if (this.queues.get(key) === settled) this.queues.delete(key); });
    return work;
  }
  private async write(file: TFile, text: string) {
    if (await this.app.vault.read(file) === text) return;
    this.written.set(file.path, text);
    await this.app.vault.modify(file, text);
  }
  report(error: unknown, path = "CSV links") {
    const message = error instanceof Error ? error.message : String(error);
    this.failures.set(path, message);
    console.error("[comsift] CSV link sync", path, error);
    new Notice(`${path}: ${message}\nOpen “CSV links: status and repair” from the command palette for details.`, 15000);
  }
  openStatus() {
    class Status extends Modal {
      constructor(app: App, private links: CsvSheetLinks) { super(app); }
      onOpen() {
        const links = this.links;
        this.setTitle("CSV links: status and repair");
        this.contentEl.createEl("p", { text: "Choose which version to keep. Repair backs up both files first." });
        const rows = this.contentEl.createDiv();
        const render = async () => {
          rows.empty();
          if (!links.pairs.size) rows.createEl("p", { text: "No linked CSV files found. Import a CSV from a spreadsheet to create a link." });
          for (const [path, source] of links.pairs) {
            const row = rows.createDiv(); row.createEl("strong", { text: path }); row.createEl("p", { text: `CSV: ${source}` });
            const sheet = links.app.vault.getFileByPath(path), csv = links.app.vault.getFileByPath(source);
            const error = links.failures.get(path) ?? links.failures.get(source);
            row.createEl("p", { text: !sheet ? "Spreadsheet is missing." : !csv ? "CSV is missing; restore it or import a replacement." : error ?? "Both files exist." });
            if (!sheet || !csv) continue;
            for (const [direction, label] of [["csv", "Use CSV data"], ["sheet", "Use sheet data"]] as const) {
              const button = row.createEl("button", { text: label });
              button.onclick = () => { button.disabled = true; void links.repair(sheet, direction).then(render).catch(error => { button.disabled = false; links.report(error, path); }); };
            }
          }
          for (const [path, error] of links.failures) if (!links.pairs.has(path) && ![...links.pairs.values()].includes(path)) rows.createEl("p", { text: `${path}: ${error}` });
        };
        void render().catch(error => links.report(error));
      }
      onClose() { this.contentEl.empty(); }
    }
    new Status(this.app, this).open();
  }
  private async backup(sheet: TFile, csv: TFile) {
    const adapter = this.app.vault.adapter;
    const dir = `${this.app.vault.configDir}/plugins/${this.host.manifest.id}/csv-link-backups/${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let path = "";
    for (const part of dir.split("/")) { path = path ? `${path}/${part}` : part; if (!await adapter.exists(path)) await adapter.mkdir(path); }
    await adapter.write(`${dir}/versions.json`, JSON.stringify({ sheet: { path: sheet.path, text: await this.app.vault.read(sheet) }, csv: { path: csv.path, text: await this.app.vault.read(csv) } }, null, 2));
  }
  async repair(sheet: TFile, direction: "csv" | "sheet") {
    const current = await this.app.vault.read(sheet);
    const source = csvSource(current) ?? this.pairs.get(sheet.path);
    const csv = source ? this.app.vault.getFileByPath(source) : null;
    if (!csv || !source) throw new Error("CSV is missing. Restore it or import a replacement before repairing.");
    return this.enqueue(source, async () => {
      await this.backup(sheet, csv);
      const sheetText = await this.app.vault.read(sheet), csvText = await this.app.vault.read(csv);
      if (direction === "sheet") await this.write(csv, csvWithOriginalFormat(firstRows(sheetText), csvText));
      const csvAfter = await this.app.vault.read(csv);
      const result = direction === "csv" ? mergeCsvSheet(sheetText, this.host.buildSheetMdBodyFromCsvText(csvAfter)) : sheetText;
      const linked = stamp(result, source, csvAfter);
      await this.write(sheet, linked); this.headers.set(sheet.path, linked.match(FRONT)?.[0] ?? ""); this.pairs.set(sheet.path, source);
      this.failures.delete(sheet.path); this.failures.delete(source);
      await this.host.refreshOpenExcelViewsForSheet(sheet.path);
      new Notice("CSV link repaired. Both previous versions were backed up.");
    });
  }
  async startupScan() {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await this.scan(); return; }
        catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (attempt === 2 || /Both linked CSV and sheet changed|unsynchronized edits/i.test(reason)) throw error;
          await new Promise<void>(resolve => window.setTimeout(resolve, 200 * (attempt + 1)));
        }
      }
    } finally { this.finishStartup(); }
  }
  afterStartup<T>(action: () => Promise<T>): Promise<T> { return this.ready.then(action); }
  start() {
    this.host.addCommand({ id: "csv-link-status", name: "CSV links: status and repair", callback: () => this.openStatus() });
    this.host.registerEvent(this.app.vault.on("create", file => { if (file instanceof TFile && file.extension.toLowerCase() === "csv" && this.host.shouldSyncCsv(file.path)) void this.afterStartup(async () => { await this.ensure(file); await this.changed(file); }).catch(error => this.report(error, file.path)); }));
    this.host.registerEvent(this.app.vault.on("modify", file => {
      if (!(file instanceof TFile) || (file.extension.toLowerCase() !== "csv" && !isSheetPath(file.path))) return;
      window.clearTimeout(this.timers.get(file.path));
      const path = file.path;
      this.timers.set(path, window.setTimeout(() => {
        this.timers.delete(path);
        void this.afterStartup(() => this.changed(file)).catch(error => this.report(error, file.path));
      }, 200));
    }));
    this.host.registerEvent(this.app.vault.on("rename", (file, oldPath) => { if (file instanceof TFile) void this.afterStartup(() => this.renamed(file, oldPath)).catch(error => this.report(error, file.path)); }));
    this.host.registerEvent(this.app.vault.on("delete", file => { if (isSheetPath(file.path)) this.pairs.delete(file.path); this.written.delete(file.path); }));
    this.host.register(() => { for (const timer of this.timers.values()) window.clearTimeout(timer); this.timers.clear(); });
    this.app.workspace.onLayoutReady(() => { void this.startupScan().catch(error => this.report(error)); });
  }
  async scan() {
    const errors: string[] = [];
    for (const file of this.app.vault.getFiles().filter(file => isSheetPath(file.path))) {
      try {
        const text = await this.app.vault.read(file), source = csvSource(text);
        if (source) { this.pairs.set(file.path, source); this.headers.set(file.path, text.match(FRONT)?.[0] ?? ""); }
      } catch (error) { errors.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    for (const file of this.app.vault.getFiles().filter(file => file.extension.toLowerCase() === "csv" && this.host.shouldSyncCsv(file.path) && !file.path.split("/").some(part => part.startsWith(".")))) {
      try { await this.ensure(file); } catch (error) { errors.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    for (const [sheetPath, source] of this.pairs) {
      try {
        const sheet = this.app.vault.getFileByPath(sheetPath), csv = this.app.vault.getFileByPath(source);
        if (!sheet || !csv) { errors.push(`${sheetPath}: ${!sheet ? "Spreadsheet" : "Linked CSV"} is missing.`); continue; }
        const sheetText = await this.app.vault.read(sheet), csvText = await this.app.vault.read(csv);
        const priorCsv = revision(sheetText, "comsift_csv_revision"), priorSheet = revision(sheetText, "comsift_sheet_revision");
        if (!priorCsv || !priorSheet) continue;
        const csvChanged = priorCsv !== fingerprint(csvText), sheetChanged = priorSheet !== fingerprint(JSON.stringify(firstRows(sheetText)));
        const csvRows = firstRows(this.host.buildSheetMdBodyFromCsvText(csvText));
        if (csvChanged && sheetChanged && priorSheet !== fingerprint(JSON.stringify(csvRows)) && JSON.stringify(csvRows) !== JSON.stringify(firstRows(sheetText))) throw new Error("Both linked CSV and sheet changed while closed. Use CSV links: status and repair to choose a version.");
        if (csvChanged) await this.changed(csv);
        else if (sheetChanged) await this.saveSheet(sheet, sheetText);
      } catch (error) { errors.push(`${sheetPath}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (errors.length) throw new Error(errors.join("\n"));
  }
  async importFile(sheet: TFile, input: Pick<File, "name" | "text">): Promise<void> {
    if (!isSheetPath(sheet.path)) throw new Error("CSV import requires a saved spreadsheet.");
    const name = input.name.replace(/[\\/:*?"<>|]/g, "_");
    if (!name.toLowerCase().endsWith(".csv") || name.startsWith(".")) throw new Error("Choose a CSV source file.");
    const text = await input.text();
    const folder = sheet.path.includes("/") ? sheet.path.slice(0, sheet.path.lastIndexOf("/")) : "";
    await this.enqueue(`import:${folder}`, async () => {
      const stem = name.slice(0,-4);
      let path = normalizePath(`${folder ? folder + "/" : ""}${name}`);
      for (let suffix = 2; ; suffix++) {
        const existing = this.app.vault.getFileByPath(path);
        if (!existing || await this.app.vault.read(existing) === text) break;
        path = normalizePath(`${folder ? folder + "/" : ""}${stem} ${suffix}.csv`);
      }
      const previous = this.pairs.get(sheet.path);
      this.pairs.set(sheet.path, path); // Register before the CSV create event can create a second companion.
      try {
        if (!this.app.vault.getFileByPath(path)) {
          this.written.set(path, text);
          await this.app.vault.create(path, text);
        }
        const current = await this.app.vault.read(sheet);
        const linked = stamp(mergeCsvSheet(current, this.host.buildSheetMdBodyFromCsvText(text)), path, text);
        await this.write(sheet, linked);
        this.headers.set(sheet.path, linked.match(FRONT)?.[0] ?? "");
        await this.host.refreshOpenExcelViewsForSheet(sheet.path);
      } catch (error) {
        if (previous) this.pairs.set(sheet.path, previous); else this.pairs.delete(sheet.path);
        throw error;
      }
    });
  }
  async ensure(csv: TFile): Promise<void> {
    return this.enqueue(csv.path, async () => {
      if ([...this.pairs.values()].includes(csv.path)) return;
      const path = csv.path.replace(/\.csv$/i, ".sheet.md");
      const existing = this.app.vault.getFileByPath(path);
      if (existing) {
        const text = await this.app.vault.read(existing), source = csvSource(text);
        if (source && source !== csv.path) throw new Error("The companion sheet already belongs to another CSV.");
        if (!parseSheetMd(text).length && !/^# Excel\s*$/m.test(text)) throw new Error("The companion path is occupied by an unrelated note.");
        this.pairs.set(path, csv.path);
        const original = await this.app.vault.read(csv);
        const matches = JSON.stringify(firstRows(text)) === JSON.stringify(firstRows(this.host.buildSheetMdBodyFromCsvText(original)));
        const linked = matches ? stamp(text, csv.path, original) : linkCsv(text, csv.path);
        this.headers.set(path, linked.match(FRONT)?.[0] ?? "");
        await this.write(existing, linked);
      } else {
        const original = await this.app.vault.read(csv);
        const text = stamp(this.host.buildSheetMdBodyFromCsvText(original), csv.path, original);
        this.written.set(path, text);
        await this.app.vault.create(path, text);
        this.pairs.set(path, csv.path);
        this.headers.set(path, text.match(FRONT)?.[0] ?? "");
      }
    });
  }
  async changed(file: TFile) {
    const text = await this.app.vault.read(file);
    if (this.written.get(file.path) === text) return;
    if (file.extension.toLowerCase() === "csv") {
      if (!this.host.shouldSyncCsv(file.path) && ![...this.pairs.values()].includes(file.path)) return;
      await this.ensure(file);
      await this.enqueue(file.path, async () => {
        const fresh = await this.app.vault.read(file);
        for (const [sheetPath, source] of this.pairs) if (source === file.path) {
          const sheet = this.app.vault.getFileByPath(sheetPath);
          if (!sheet) continue;
          const prior = await this.app.vault.read(sheet);
          const imported = this.host.buildSheetMdBodyFromCsvText(fresh);
          const priorCsv = revision(prior, "comsift_csv_revision"), priorSheet = revision(prior, "comsift_sheet_revision");
          const sheetRows = firstRows(prior), csvRows = firstRows(imported);
          const sheetEdited = !!priorSheet && priorSheet !== fingerprint(JSON.stringify(sheetRows));
          const csvEdited = !!priorSheet && priorSheet !== fingerprint(JSON.stringify(csvRows));
          if (priorCsv && priorSheet && priorCsv !== fingerprint(fresh) && sheetEdited && csvEdited && JSON.stringify(sheetRows) !== JSON.stringify(csvRows)) throw new Error("Both CSV and sheet contain unsynchronized edits. Choose a version in CSV links: status and repair.");
          // Formatting-only CSV edits must not discard a pending spreadsheet value change.
          if (sheetEdited && !csvEdited) await this.write(file, csvWithOriginalFormat(sheetRows, fresh));
          const linked = sheetEdited && !csvEdited ? stamp(prior, file.path, await this.app.vault.read(file)) : stamp(mergeCsvSheet(prior, imported), file.path, fresh);
          this.headers.set(sheet.path, linked.match(FRONT)?.[0] ?? "");
          await this.write(sheet, linked);
          await this.host.refreshOpenExcelViewsForSheet(sheet.path);
        }
      });
    } else await this.saveSheet(file, text);
  }
  async saveSheet(sheet: TFile, text: string) {
    const source = csvSource(text) ?? this.pairs.get(sheet.path);
    if (!source) return; // Standalone spreadsheets are not converted into CSV files.
    return this.enqueue(source, async () => {
      const csv = this.app.vault.getFileByPath(source);
      if (!csv) throw new Error("Linked CSV is missing. Restore or relink it; no replacement file was created.");
      const current = await this.app.vault.read(sheet);
      const start = current.search(/^\[/m);
      if (start < 0) throw new Error("Invalid sheet data.");
      const data: unknown = JSON.parse(current.slice(start));
      if (!Array.isArray(data)) throw new Error("Invalid sheet data.");
      const first = parseSheetMd(`# Excel\n${JSON.stringify(data.slice(0,1))}`)[0]?.rows ?? [];
      const before = await this.app.vault.read(csv);
      const savedHeader = this.headers.get(sheet.path) ?? current;
      const priorCsv = revision(savedHeader, "comsift_csv_revision"), priorSheet = revision(savedHeader, "comsift_sheet_revision");
      const imported = this.host.buildSheetMdBodyFromCsvText(before);
      const previous = firstRows(imported);
      if (priorCsv && priorSheet && priorCsv !== fingerprint(before) && priorSheet !== fingerprint(JSON.stringify(previous)) && JSON.stringify(first) !== JSON.stringify(previous)) {
        if (priorSheet !== fingerprint(JSON.stringify(first))) throw new Error("Both CSV and sheet contain unsynchronized edits. Choose which version to use in CSV links: status and repair.");
        // A view can autosave its unchanged old grid before the CSV modify event is handled.
        // The newer source wins here; this is a normal synchronization race, not a failed link.
        const restored = this.headers.has(sheet.path) ? this.headers.get(sheet.path)! + current.replace(FRONT, "") : current;
        const linked = stamp(mergeCsvSheet(restored, imported), source, before);
        this.headers.set(sheet.path, linked.match(FRONT)?.[0] ?? "");
        await this.write(sheet, linked); this.failures.delete(sheet.path); this.failures.delete(source); await this.host.refreshOpenExcelViewsForSheet(sheet.path); return;
      }
      if (JSON.stringify(first) !== JSON.stringify(previous)) await this.write(csv, csvWithOriginalFormat(first, before));
      this.pairs.set(sheet.path, source);
      const restored = !csvSource(current) && this.headers.has(sheet.path) ? this.headers.get(sheet.path)! + current.replace(FRONT, "") : current;
      const linked = stamp(restored, source, await this.app.vault.read(csv));
      this.headers.set(sheet.path, linked.match(FRONT)?.[0] ?? "");
      await this.write(sheet, linked);
      this.failures.delete(sheet.path); this.failures.delete(source);
    });
  }
  async renamed(file: TFile, oldPath: string) {
    this.written.delete(oldPath);
    if (isSheetPath(oldPath)) {
      const source = this.pairs.get(oldPath); this.pairs.delete(oldPath);
      const header = this.headers.get(oldPath); this.headers.delete(oldPath);
      if (header) this.headers.set(file.path, header);
      if (source && isSheetPath(file.path)) { this.pairs.set(file.path, source); await this.write(file, linkCsv(await this.app.vault.read(file), source)); }
    }
    if (oldPath.toLowerCase().endsWith(".csv") && file.path.toLowerCase().endsWith(".csv")) {
      await this.enqueue(oldPath, async () => {
        for (const [sheetPath, source] of this.pairs) if (source === oldPath) {
          const sheet = this.app.vault.getFileByPath(sheetPath); if (!sheet) continue;
          this.pairs.set(sheetPath, file.path); await this.write(sheet, linkCsv(await this.app.vault.read(sheet), file.path));
        }
      });
    }
  }
}
export function installCsvLinks(excel: Plugin) {
  const host = excel as ExcelCsvHooks;
  const links = new CsvSheetLinks(host.app, host);
  host.registerCsvSyncService = () => links.start();
  host.importLinkedCsv = (file, source) => links.afterStartup(() => links.importFile(file, source));
  host.syncPairedCsvFromSheetSave = (file, json) => links.afterStartup(() => links.saveSheet(file, json)).catch(error => links.report(error, file.path));
}
