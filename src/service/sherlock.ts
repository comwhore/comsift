import { Notice, setIcon, normalizePath, TFolder } from "obsidian";
import { spawn } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { promises as fs } from "fs";
import ComsiftPlugin from "../main";
import { uuid } from "../tool";
import { ToolPublicationQueue } from "./toolJobs";
import { validToolQuery } from "./toolQuery";
import { connectionSides, resolveOutputDirection, resultGroupLayout } from "./placement";
import {
  readToolState,
  removeTrackedChildren,
  writeToolState,
} from "./toolNode";

interface SherlockCsvRow {
  username: string;
  name: string;
  url_main: string;
  url_user: string;
  exists: string;
  http_status: string;
  response_time_s: string;
}

interface SherlockJob {
  id: string;
  query: string;
  startedAt: number;
  sourceNodeId: string;
  sourceCanvasPath: string;
  status: "running" | "done" | "failed";
  stopProgressNotice?: () => void;
}

export class SherlockService {
  private publications = new ToolPublicationQueue();
  private plugin: ComsiftPlugin;
  private statusEl: HTMLElement;
  private jobs = new Map<string, SherlockJob>();

  constructor(plugin: ComsiftPlugin) {
    this.plugin = plugin;
    this.statusEl = plugin.addStatusBarItem();
    this.statusEl.hide();
    setIcon(this.statusEl, "search");
  }

  updateStatusBar() {
    const running = [...this.jobs.values()].filter((job) => job.status === "running");
    if (running.length === 0) {
      this.statusEl.hide();
      this.statusEl.textContent = "";
      this.statusEl.title = "";
      return;
    }
    this.statusEl.show();
    this.statusEl.textContent = `Sherlock: ${running.length} running`;
    this.statusEl.title = running.map((job) => `${job.query} (${Math.floor((Date.now() - job.startedAt) / 1000)}s)`).join("\n");
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

    const runDir = join(tmpdir(), `comsift-sherlock-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
    await fs.mkdir(runDir, { recursive: true });

    let commandArgs: { command: string; args: string[] };
    try {
      commandArgs = this.buildSherlockCommand(query, runDir);
    } catch (error) {
      new Notice(`Comsift: ${(error as Error).message}`);
      return;
    }
    const ticket = this.publications.begin(`${canvasFile.path}#${selected.id}`);
    this.ensureSherlockRootNode(canvas, canvasFile.path, selected, query);
    await this.plugin.saveState();
    canvas.requestSave?.();

    const { command, args } = commandArgs;
    const job: SherlockJob = {
      id: uuid(),
      query,
      startedAt: Date.now(),
      sourceNodeId: selected.id,
      sourceCanvasPath: canvasFile.path,
      status: "running",
    };
    this.jobs.set(job.id, job);
    this.updateStatusBar();
    job.stopProgressNotice = this.createProgressNotice(query);

    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      ticket.finish();
      job.status = "failed";
      job.stopProgressNotice?.();
      this.updateStatusBar();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        new Notice(
          "Sherlock command not found. Set its executable path in settings.",
          9000,
        );
      } else {
        new Notice(`Comsift: Sherlock failed to start (${error.message}).`);
      }
    });

    child.on("close", (code) => void (async () => {
      if (code !== 0) {
        ticket.finish();
        job.status = "failed";
        job.stopProgressNotice?.();
        this.updateStatusBar();
        new Notice(`Comsift: Sherlock exited with code ${code}.`);
        if (stderr.trim()) {
          console.error("[Comsift][Sherlock]", stderr);
        }
        return;
      }

      try {
        const rows = await this.readCsvResults(runDir, query);
        await ticket.publish(replace => this.applyResults(canvas, selected, canvasFile.path, rows, query, replace));
        job.status = "done";
        job.stopProgressNotice?.();
        this.updateStatusBar();
        new Notice(`Sherlock found ${rows.length} profiles.`);
      } catch (error) {
        job.status = "failed";
        job.stopProgressNotice?.();
        this.updateStatusBar();
        new Notice("Could not read Sherlock results.");
        console.error("[Comsift][Sherlock]", error);
      } finally { ticket.finish(); }
    })());
  }

  private extractQuery(text: string): string {
    const firstLine = text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return firstLine ?? "";
  }

  private buildSherlockCommand(query: string, runDir: string): { command: string; args: string[] } {
    const configured = this.plugin.setting.sherlockCommand.trim();
    const chunks = this.tokenize(configured);
    if (chunks.length === 0) {
      throw new Error("Sherlock command is empty.");
    }
    const command = chunks[0];
    const args = chunks.slice(1);
    if (this.plugin.setting.sherlockIncludeNsfw) args.push("--nsfw");
    args.push("--csv", "--no-color", "--folderoutput", runDir, "--timeout", String(this.plugin.setting.sherlockTimeout));
    if (this.plugin.setting.sherlockProxy.trim()) {
      args.push("--proxy", this.plugin.setting.sherlockProxy.trim());
    }
    if (this.plugin.setting.sherlockExtraArgs.trim()) {
      args.push(...this.tokenize(this.plugin.setting.sherlockExtraArgs.trim()));
    }
    args.push(query);
    return { command, args };
  }

  private createProgressNotice(query: string): () => void {
    const fragment = createFragment();
    const container = fragment.createDiv({ cls: "comsift-sherlock-progress" });
    container.createSpan({ cls: "loader", attr: { "aria-hidden": "true" } });
    container.createSpan({ text: `Sherlock running for "${query}"` });
    const notice = new Notice(fragment, 0);

    return () => {
      notice.hide();
    };
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

  private async readCsvResults(runDir: string, username: string): Promise<SherlockCsvRow[]> {
    const csvPath = join(runDir, `${username}.csv`);
    const raw = await fs.readFile(csvPath, "utf8");
    const rows = raw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    if (rows.length <= 1) return [];

    const parsed = rows.slice(1).map((line) => this.parseCsvLine(line));
    return parsed
      .map((cols) => ({
        username: cols[0] ?? "",
        name: cols[1] ?? "",
        url_main: cols[2] ?? "",
        url_user: cols[3] ?? "",
        exists: cols[4] ?? "",
        http_status: cols[5] ?? "",
        response_time_s: cols[6] ?? "",
      }))
      .filter((row) => row.exists.toLowerCase().includes("claimed"));
  }

  private parseCsvLine(line: string): string[] {
    const fields: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === "\"") {
        if (inQuotes && line[i + 1] === "\"") {
          current += "\"";
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        fields.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    fields.push(current);
    return fields;
  }

  private async applyResults(canvas: M.Canvas, sourceNode: M.Node, canvasPath: string, rows: SherlockCsvRow[], query: string, replacePrevious = true) {
    const reportPaths = await this.writeMarkdownReports(canvasPath, rows, query);
    await this.plugin.toolProfiles?.importReports(reportPaths).catch((error: unknown) => console.error("[Comsift][Sherlock] Could not create profiles", error));
    const root = canvas.getData().nodes.find(node => node.id === sourceNode.id);
    if (!root) throw new Error("The source node was removed while Sherlock was running. Reports were retained.");
    if (rows.length === 0) {
      if (replacePrevious) this.removePreviousSherlockChildren(canvas, canvasPath, sourceNode.id);
      await this.plugin.saveState();
      canvas.requestSave?.();
      return;
    }

    if (replacePrevious) this.removePreviousSherlockChildren(canvas, canvasPath, sourceNode.id);
    const childHeight = root.height;
    const childWidth = root.width;
    const direction = resolveOutputDirection(canvas.getData(), root.id, this.plugin.setting.sherlockPosition);
    const positions = resultGroupLayout(root, rows.length, { width: childWidth, height: childHeight }, direction,
      this.plugin.setting.COLUMN_GAP, canvas.getData().nodes.filter(node => node.id !== root.id), this.plugin.setting.ROW_GAP);

    const createdNodes: Array<{ id: string; type: string; file: string; x: number; y: number; width: number; height: number }> = [];
    for (let idx = 0; idx < rows.length; idx++) {
      createdNodes.push({ id: uuid(), type: "file", file: reportPaths[idx],
        ...positions[idx], width: childWidth, height: childHeight });
    }

    const data = canvas.getData();
    const newEdges = createdNodes.map(node => ({
      id: uuid(),
      fromNode: root.id,
      ...connectionSides(root, node),
      toNode: node.id,
    }));
    canvas.importData({
      nodes: [...data.nodes, ...createdNodes],
      edges: [...data.edges, ...newEdges],
    });

    // Note: we intentionally do NOT call layout.useSide here. It operates on
    // stale node references after importData (which can recreate node objects),
    // so the moveTo() calls have no effect. Children are already placed
    // centered around the parent above, so the layout is correct from the
    // start and arrows route cleanly without crossing other nodes.

    this.plugin.state.sherlockChildren[canvasPath] ??= {};
    this.plugin.state.sherlockChildren[canvasPath][sourceNode.id] = {
      rootId: root.id,
      childIds: [...(this.plugin.state.sherlockChildren[canvasPath][sourceNode.id]?.childIds ?? []), ...createdNodes.map((node) => node.id)],
    };
    await this.plugin.saveState();
    canvas.requestSave?.();
  }

  private async writeMarkdownReports(canvasPath: string, rows: SherlockCsvRow[], query: string): Promise<string[]> {
    const investigation = this.plugin.investigations.forCanvasPath(canvasPath);
    if (!investigation) throw new Error("Sherlock requires a Canvas in a managed user folder.");
    const folder = normalizePath(`${investigation.folderPath}/Sherlock`);
    if (!this.plugin.app.vault.getAbstractFileByPath(folder)) await this.plugin.app.vault.createFolder(folder);
    else if (!(this.plugin.app.vault.getAbstractFileByPath(folder) instanceof TFolder)) throw new Error(`Not a folder: ${folder}`);
    const paths: string[] = [];
    for (const row of rows) {
      const label = (row.name || row.url_main || "profile").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
      const base = `${query.replace(/[\\/:*?"<>|]/g, "_")} ${label}`;
      let path = normalizePath(`${folder}/${base}.md`);
      let suffix = 2;
      while (this.plugin.app.vault.getAbstractFileByPath(path)) path = normalizePath(`${folder}/${base} (${suffix++}).md`);
      await this.plugin.app.vault.create(path,
        `# ${row.name || row.username}\n\nUsername: ${row.username}\n\nProfile: ${row.url_user}\n\nSite: ${row.url_main}\n\nHTTP status: ${row.http_status}\n`);
      paths.push(path);
    }
    await this.plugin.graph.refreshInvestigation(investigation);
    return paths;
  }

  /** Results hang straight off the source node; there is no separate "Sherlock" group node any more. */
  private ensureSherlockRootNode(_canvas: M.Canvas, canvasPath: string, sourceNode: M.Node, _query: string): M.Node {
    const bucket = this.plugin.state.sherlockChildren as unknown as Record<string, Record<string, unknown>>;
    const state = readToolState(bucket, canvasPath, sourceNode.id);
    writeToolState(bucket, canvasPath, sourceNode.id, { rootId: sourceNode.id, childIds: state.childIds });
    return sourceNode;
  }


  private removePreviousSherlockChildren(canvas: M.Canvas, canvasPath: string, sourceNodeId: string) {
    const bucket = this.plugin.state.sherlockChildren as unknown as Record<string, Record<string, unknown>>;
    const state = readToolState(bucket, canvasPath, sourceNodeId);
    if (!state.childIds.length) return;

    removeTrackedChildren(canvas, state.childIds);
    writeToolState(bucket, canvasPath, sourceNodeId, {
      rootId: state.rootId,
      childIds: [],
    });
  }
}
