import { Notice, setIcon } from "obsidian";
import { spawn } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { promises as fs } from "fs";
import { normalizePath, TFolder } from "obsidian";
import ComsiftPlugin from "../main";
import { uuid } from "../tool";
import { ToolPublicationQueue, type ToolJobTicket } from "./toolJobs";
import { validToolQuery } from "./toolQuery";
import { connectionSides, resolveOutputDirection, resultGroupLayout } from "./placement";
import {
  readToolState,
  removeTrackedChildren,
  writeToolState,
} from "./toolNode";

interface MaigretHit {
  site: string;
  url: string;
  meta: Record<string, string>;
}

interface MaigretReport {
  hit: MaigretHit;
  path: string;
}

interface MaigretCommand {
  command: string;
  args: string[];
  reportDir: string;
}

export class MaigretService {
  private publications = new ToolPublicationQueue();
  private plugin: ComsiftPlugin;
  private statusEl: HTMLElement;
  private running = 0;
  private updateStatus() {
    this.statusEl.toggle(this.running > 0);
    this.statusEl.textContent = this.running ? `Maigret: ${this.running} running` : "";
  }

  constructor(plugin: ComsiftPlugin) {
    this.plugin = plugin;
    this.statusEl = plugin.addStatusBarItem();
    this.statusEl.hide();
    setIcon(this.statusEl, "scan-search");
  }

  async runFromSelection() {
    const canvas = this.plugin.canvas;
    const selected = this.plugin.node.getSingleSelection();
    const canvasFile = this.plugin.getActiveCanvasFile();
    if (!canvas || !selected || !canvasFile) {
      new Notice("Comsift: select one Canvas text node first.");
      return;
    }

    const query = this.extractQuery(selected.text);
    if (!validToolQuery(query)) {
      new Notice("Comsift: enter a username without spaces, path separators or command options.");
      return;
    }

    let command = "";
    let args: string[] = [];
    let reportDir = "";
    try {
      ({ command, args, reportDir } = await this.buildCommand(query));
    } catch (error) {
      new Notice(`Comsift: ${(error as Error).message}`);
      return;
    }
    const ticket = this.publications.begin(`${canvasFile.path}#${selected.id}`);
    this.ensureRoot(canvas, canvasFile.path, selected, query);
    await this.plugin.saveState();
    canvas.requestSave?.();

    this.running++; this.updateStatus();
    let finished = false;
    const finish = () => { if (!finished) { finished = true; this.running--; this.updateStatus(); } };
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      env: this.buildProcessEnv(),
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      finish(); ticket.finish();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        new Notice("Comsift: Maigret command not found. Configure it in settings.", 9000);
      } else {
        new Notice(`Comsift: Maigret failed to start (${error.message}).`);
      }
    });

    child.on("close", (code) => void (async () => {
      finish();
      const hits = await this.readJsonReport(reportDir, query);
      if (code !== 0 && hits.length === 0) {
        const fallbackHits = this.parseHits(stdout);
        if (fallbackHits.length === 0) {
          new Notice(`Comsift: Maigret exited with code ${code}. ${this.formatProcessError(stderr || stdout)}`, 12000);
          if (stderr.trim()) console.error("[Comsift][Maigret]", stderr);
          return;
        }
        const written = await this.publishResults(ticket, canvas, canvasFile.path, selected, query, fallbackHits);
        new Notice(`Maigret exited with code ${code}. Saved ${fallbackHits.length} profiles and ${written} reports.`);
        if (stderr.trim()) console.error("[Comsift][Maigret]", stderr);
        return;
      }
      const written = await this.publishResults(ticket, canvas, canvasFile.path, selected, query, hits);
      const prefix = code === 0 ? "found" : `returned code ${code}, kept`;
      new Notice(`Maigret ${prefix} ${hits.length} profiles. Saved ${written} reports.`);
      if (code !== 0) {
        if (stderr.trim()) console.error("[Comsift][Maigret]", stderr);
      }
    })().catch((error: unknown) => { finish(); console.error("[Comsift][Maigret]", error); new Notice(error instanceof Error ? error.message : "Could not publish Maigret results."); }).finally(() => ticket.finish()));
  }

  private publishResults(ticket: ToolJobTicket, canvas: M.Canvas, path: string, source: M.Node, query: string, hits: MaigretHit[]): Promise<number> {
    return ticket.publish(async replacePrevious => {
      const { reports, written } = await this.writeMarkdownReports(path, query, hits);
      await this.applyResults(canvas, path, source, query, reports, replacePrevious);
      // Every found account becomes a connection profile (marked uncertain: a candidate, not verified).
      await this.plugin.toolProfiles?.importReports(reports.map(report => report.path))
        .catch((error: unknown) => console.error("[Comsift][Maigret] Could not create profiles", error));
      return written;
    });
  }

  private extractQuery(text: string): string {
    return (
      text
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? ""
    );
  }

  private async buildCommand(query: string): Promise<MaigretCommand> {
    const configured = this.plugin.setting.maigretCommand.trim();
    const chunks = this.tokenize(configured);
    if (!chunks.length) throw new Error("Maigret command is empty.");
    const command = chunks[0];
    const args = chunks.slice(1);
    const reportDir = await this.prepareReportDir();
    args.push(
      query,
      "-n",
      String(this.plugin.setting.maigretThreads),
      "--retries",
      String(this.plugin.setting.maigretRetries),
      "--timeout",
      String(this.plugin.setting.maigretTimeout),
      "--no-autoupdate",
      "--no-color",
      "--no-progressbar",
      "--folderoutput",
      reportDir,
      "--json",
      "ndjson",
    );
    if (this.plugin.setting.maigretProxy.trim()) {
      args.push("--proxy", this.plugin.setting.maigretProxy.trim());
    }
    const dbCopy = await this.prepareWritableDatabaseCopy();
    if (dbCopy) {
      args.push("--db", dbCopy);
    }
    if (this.plugin.setting.maigretExtraArgs.trim()) {
      args.push(...this.tokenize(this.plugin.setting.maigretExtraArgs.trim()));
    }
    return { command, args, reportDir };
  }

  private async prepareReportDir(): Promise<string> {
    const reportDir = join(tmpdir(), `comsift-maigret-report-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
    await fs.mkdir(reportDir, { recursive: true });
    return reportDir;
  }

  private async prepareWritableDatabaseCopy(): Promise<string | null> {
    const userProfile = process.env.USERPROFILE || process.env.HOME;
    if (!userProfile) return null;

    const source = join(userProfile, ".maigret", "data.json");
    const targetDir = join(tmpdir(), "comsift-maigret");
    const target = join(targetDir, `data-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.json`);
    try {
      await fs.mkdir(targetDir, { recursive: true });
      await fs.copyFile(source, target);
      return target;
    } catch (error) {
      console.warn("[Comsift][Maigret] Could not prepare writable database copy.", error);
      return null;
    }
  }

  private buildProcessEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    };
  }

  private formatProcessError(output: string): string {
    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const message = lines.at(-1) ?? lines[0] ?? "";
    return message ? message.slice(0, 220) : "Check developer console for details.";
  }

  private tokenize(value: string): string[] {
    const tokens: string[] = [];
    const regex = /[^\s"]+|"([^"]*)"/g;
    let match = regex.exec(value);
    while (match) {
      tokens.push(match[1] ?? match[0]);
      match = regex.exec(value);
    }
    return tokens;
  }

  private parseHits(stdout: string): MaigretHit[] {
    const out: MaigretHit[] = [];
    const lines = stdout.split(/\r?\n/);
    let current: MaigretHit | null = null;
    for (const line of lines) {
      const match = line.match(/^\[\+\]\s+([^:]+):\s+(https?:\/\/\S+)/);
      if (match) {
        current = {
          site: match[1].trim(),
          url: match[2].trim(),
          meta: {},
        };
        out.push(current);
        continue;
      }
      if (!current) continue;
      const metaMatch = line.match(/^\s*[├└]─\s*([^:]+):\s*(.+)\s*$/);
      if (!metaMatch) continue;
      current.meta[metaMatch[1].trim()] = metaMatch[2].trim();
    }
    return out;
  }

  private async readJsonReport(reportDir: string, query: string): Promise<MaigretHit[]> {
    if (!reportDir) return [];
    const filePath = join(reportDir, `report_${query.replace(/\//g, "_")}_ndjson.json`);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => this.parseJsonHit(line))
        .filter((hit): hit is MaigretHit => hit !== null);
    } catch (error) {
      console.warn("[Comsift][Maigret] Could not read JSON report.", error);
      return [];
    }
  }

  private parseJsonHit(line: string): MaigretHit | null {
    try {
      const parsed = asRecord(JSON.parse(line));
      const status = asRecord(parsed.status);
      const ids = status.ids ?? parsed.ids_data ?? parsed.ids ?? {};
      const url = text(status.url ?? parsed.url_user ?? parsed.url).trim();
      if (!url) return null;
      return {
        site: (text(parsed.sitename ?? status.site_name ?? asRecord(parsed.site).name) || "Unknown").trim(),
        url,
        meta: this.flattenMetadata(ids),
      };
    } catch (error) {
      console.warn("[Comsift][Maigret] Could not parse JSON report line.", error);
      return null;
    }
  }

  private flattenMetadata(value: unknown, prefix = ""): Record<string, string> {
    const out: Record<string, string> = {};
    if (!value || typeof value !== "object") return out;

    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (raw === null || raw === undefined || raw === "") continue;
      if (Array.isArray(raw)) {
        out[path] = raw.map((item) => this.stringifyMetadataValue(item)).join(", ");
      } else if (typeof raw === "object") {
        Object.assign(out, this.flattenMetadata(raw, path));
      } else {
        out[path] = text(raw);
      }
    }
    return out;
  }

  private stringifyMetadataValue(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return text(value);
  }

  private async applyResults(
    canvas: M.Canvas,
    canvasPath: string,
    sourceNode: M.Node,
    query: string,
    reports: MaigretReport[],
    replacePrevious = true,
  ) {
    const root = canvas.getData().nodes.find(node => node.id === sourceNode.id);
    if (!root) throw new Error("The source node was removed while Maigret was running. Reports were retained.");
    if (replacePrevious) this.removeOldChildren(canvas, canvasPath, sourceNode.id);
    const childWidth = 400;
    const childHeight = 400;
    const direction = resolveOutputDirection(canvas.getData(), root.id, this.plugin.setting.maigretPosition);
    const positions = resultGroupLayout(root, reports.length, { width: childWidth, height: childHeight }, direction,
      this.plugin.setting.COLUMN_GAP, canvas.getData().nodes.filter(node => node.id !== root.id), this.plugin.setting.ROW_GAP);

    const data = canvas.getData();
    const created = reports.map((report, i) => ({
      id: uuid(),
      ...positions[i],
      width: childWidth,
      height: childHeight,
      type: "file",
      file: report.path,
    }));
    canvas.importData({
      nodes: [...data.nodes, ...created],
      edges: [
        ...data.edges,
        ...created.map((node) => ({
          id: uuid(),
          fromNode: root.id,
          ...connectionSides(root, node),
          toNode: node.id,
        })),
      ],
    });

    this.plugin.state.maigretChildren[canvasPath] ??= {};
    this.plugin.state.maigretChildren[canvasPath][sourceNode.id] = {
      rootId: root.id,
      childIds: [...(this.plugin.state.maigretChildren[canvasPath][sourceNode.id]?.childIds ?? []), ...created.map((node) => node.id)],
    };
    await this.plugin.saveState();
    canvas.requestSave?.();
  }

  /** Results hang straight off the source node; there is no separate "Maigret" group node any more. */
  private ensureRoot(_canvas: M.Canvas, canvasPath: string, sourceNode: M.Node, _query: string): M.Node {
    const bucket = this.plugin.state.maigretChildren as unknown as Record<string, Record<string, unknown>>;
    const state = readToolState(bucket, canvasPath, sourceNode.id);
    writeToolState(bucket, canvasPath, sourceNode.id, { rootId: sourceNode.id, childIds: state.childIds });
    return sourceNode;
  }


  private removeOldChildren(canvas: M.Canvas, canvasPath: string, sourceNodeId: string) {
    const bucket = this.plugin.state.maigretChildren as unknown as Record<string, Record<string, unknown>>;
    const state = readToolState(bucket, canvasPath, sourceNodeId);
    if (!state.childIds.length) return;
    removeTrackedChildren(canvas, state.childIds);
    writeToolState(bucket, canvasPath, sourceNodeId, {
      rootId: state.rootId,
      childIds: [],
    });
  }

  private async writeMarkdownReports(canvasPath: string, query: string, hits: MaigretHit[]): Promise<{ reports: MaigretReport[]; written: number }> {
    if (!hits.length) return { reports: [], written: 0 };
    const investigation = this.plugin.investigations?.forCanvasPath(canvasPath);
    if (!investigation) throw new Error("Maigret requires a Canvas in a managed user folder.");
    const folderPath = normalizePath(`${investigation.folderPath}/Maigret`);
    await this.ensureFolder(folderPath);
    const date = this.getLocalDateDotted();
    const reports: MaigretReport[] = [];

    for (const hit of hits) {
      const domain = this.getDomain(hit.url);
      const baseName = `${query} ${domain} ${date}`;
      const filePath = await this.uniqueFilePath(folderPath, this.sanitizeFileName(baseName));
      const content = this.buildSiteMarkdown(query, hit);
      await this.plugin.app.vault.create(filePath, content);
      reports.push({ hit, path: filePath });
    }
    await this.plugin.graph.refreshInvestigation(investigation);
    return { reports, written: reports.length };
  }

  private buildSiteMarkdown(query: string, hit: MaigretHit): string {
    const preferredHeader = this.getPreferredHeader(query, hit);
    const rows: string[] = [`username: ${query}`, `site: ${hit.site}`];
    for (const [key, value] of Object.entries(hit.meta)) {
      rows.push(`${key}: ${value}`);
    }

    const image = this.getImageUrl(hit);
    const imageBlock = image ? `\n\n![image](${image})` : "";
    return `# ${preferredHeader}\n\n<small>${hit.url}</small>\n\n${rows.join("\n")}${imageBlock}\n`;
  }

  private getPreferredHeader(query: string, hit: MaigretHit): string {
    const siteKey = hit.site.toLowerCase().replace(/\s+/g, "_");
    const handle =
      hit.meta.username ||
      hit.meta.handle ||
      hit.meta.screen_name ||
      hit.meta[`${siteKey}_username`] ||
      hit.meta[`${siteKey}_handle`] ||
      "";
    if (handle && handle.toLowerCase() !== query.toLowerCase()) {
      return `${query} / ${handle}`;
    }
    return handle || query;
  }

  private getImageUrl(hit: MaigretHit): string {
    return hit.meta.image || hit.meta.img || hit.meta.avatar || hit.meta.avatar_url || hit.meta.profile_image_url || "";
  }

  private getLocalDateDotted(): string {
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, "0");
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const yyyy = String(now.getFullYear());
    return `${dd}.${mm}.${yyyy}`;
  }

  private getDomain(url: string): string {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return hostname.replace(/^www\./, "");
    } catch {
      return "unknown.site";
    }
  }

  private sanitizeFileName(name: string): string {
    return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "maigret-report";
  }

  private async uniqueFilePath(folderPath: string, baseName: string): Promise<string> {
    let candidate = normalizePath(`${folderPath}/${baseName}.md`);
    let i = 2;
    while (this.plugin.app.vault.getAbstractFileByPath(candidate)) {
      candidate = normalizePath(`${folderPath}/${baseName} (${i}).md`);
      i++;
    }
    return candidate;
  }

  private async ensureFolder(path: string): Promise<void> {
    const existing = this.plugin.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) return;
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const node = this.plugin.app.vault.getAbstractFileByPath(current);
      if (!node) {
        await this.plugin.app.vault.createFolder(current);
      }
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}
