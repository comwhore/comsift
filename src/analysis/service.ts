import { createHash } from "crypto";
import { Notice, TFile, TFolder, normalizePath } from "obsidian";
import ComsiftPlugin from "../main";
import type { Investigation } from "../service/investigation";
import { AnalysisRunner, type AnalysisResult, type AnalyzeRequest, type ProfileRecord } from "./runner";
import { CHAT_TOOL_RULES, DEFAULT_CHAT_PROMPT, fillPrompt } from "./prompts";
import { createClient, type Decision, type ChatMessage, type LlmClient } from "./ollama";
import { chatTitle, parseChat, serializeChat, type ChatTurn } from "./chatLog";
import { isSheetPath, parseSheetMd, toCsv } from "./sheets";
import { mergeRun, pairKey, pairSignals, pairEvidenceScore, type PairHistory } from "./history";
import { canvasDigest, parseCanvas, syncReviewArrows, type Digest, type ReviewArrow } from "../service/canvasModel";
import { uuid } from "../tool";
import { applyToText, numberedForModel, sanitizeForModel, type ProposedEdit } from "./chatEdits";

const CHAT_EXTENSIONS = ["md", "csv", "json", "txt"];
export interface PreparedEdit { path: string; before: string | null; after: string; isNew: boolean }

export type ReviewStatus = "confirmed" | "related" | "rejected" | "uncertain" | "later";
export interface Interpretation { id: string; rank: number; score: number }
export interface ReasonedResult { decision: Decision; interpretation?: Interpretation[] }
export interface ContextFile { path: string; content: string; truncated: boolean; role: "folder" | "bridge" | "neighbor" }
export interface CanvasSelection { path: string; ids: string[]; only: boolean }
export interface CanvasContext { path: string; digest: Digest; personName: string }
export interface ChatContext {
  canvases: CanvasContext[];
  files: ContextFile[];
  tree: string[];
  snapshot: Map<string, string>;
  omitted: number;
  bridges: string[];
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? value as T : fallback;
  } catch { return fallback; }
}

function stripSlash(folder: string): string { return folder.replace(/\/+$/, ""); }

export class AnalysisService {
  private columnCache = new Map<string, Promise<Array<{ name: string; columns: string[] }>>>();
  constructor(private plugin: ComsiftPlugin) {}
  private get runner() { return new AnalysisRunner(this.plugin.setting.pythonCommand); }
  private get llm(): LlmClient { return createClient(this.plugin.setting); }

  async checkPython(signal?: AbortSignal): Promise<Record<string, string | null>> {
    const result = await this.runner.run<{ versions: Record<string, string | null> }>({ action: "check" }, signal);
    return result.versions;
  }
  models(signal?: AbortSignal) { return this.llm.models(signal); }
  running(signal?: AbortSignal) { return this.llm.running(signal); }
  get providerLabel(): string { return this.llm.label; }

  chatDir(folder: string) { return normalizePath(`${folder.replace(/\/+$/, "") || "Comsift"}/Chats`); }

  async saveChat(folder: string, existing: string | null, messages: ChatTurn[]): Promise<string> {
    const text = serializeChat({ folder, model: this.plugin.setting.ollamaModel, created: new Date().toISOString(), messages });
    const file = existing ? this.plugin.app.vault.getFileByPath(existing) : null;
    if (file) {
      const previous = parseChat(await this.plugin.app.vault.read(file));
      await this.plugin.app.vault.modify(file, previous?.created ? text.replace(/^created: .*$/m, `created: ${previous.created}`) : text);
      return file.path;
    }
    const dir = this.chatDir(folder);
    await this.ensureRelativeFolder(dir);
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "-");
    let path = normalizePath(`${dir}/${stamp} ${chatTitle(messages)}.md`);
    for (let n = 2; this.plugin.app.vault.getAbstractFileByPath(path); n++) path = normalizePath(`${dir}/${stamp} ${chatTitle(messages)} ${n}.md`);
    await this.plugin.app.vault.create(path, text);
    return path;
  }

  async loadChat(path: string) {
    const file = this.plugin.app.vault.getFileByPath(path);
    if (!file) throw new Error("Chat file not found.");
    const log = parseChat(await this.plugin.app.vault.read(file));
    if (!log) throw new Error("That note is not a Comsift chat.");
    return log;
  }

  listChats(folder?: string) {
    const { vault, metadataCache } = this.plugin.app;
    return vault.getMarkdownFiles()
      .filter(file => metadataCache.getFileCache(file)?.frontmatter?.comsift_chat === true &&
        (!folder || file.path.startsWith(`${this.chatDir(folder)}/`)))
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
  }

  /** All independent tabular sources in the vault, regardless of investigation folders. */
  listDatasets(): TFile[] {
    return this.plugin.app.vault.getFiles().filter(file =>
      !file.path.startsWith(`${this.plugin.app.vault.configDir}/`) &&
      (file.extension.toLowerCase() === "csv" || isSheetPath(file.path)))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  private async loadDatasets(paths: string[], signal?: AbortSignal): Promise<Array<{ name: string; csv: string }>> {
    const datasets: Array<{ name: string; csv: string }> = [];
    const files = this.listDatasets();
    let total = 0;
    for (const file of files) {
      if (!paths.some(path => path === file.path || path.startsWith(file.path + "#"))) continue;
      if (signal?.aborted) throw new Error("Analysis cancelled.");
      const text = await this.plugin.app.vault.cachedRead(file);
      total += text.length;
      if (total > 50_000_000) throw new Error("Dataset input exceeds 50 MB. Select smaller datasets.");
      if (file.extension.toLowerCase() === "csv") datasets.push({ name: file.path, csv: text });
      else for (const table of parseSheetMd(text)) {
        const name = `${file.path}#${table.name}`;
        if (paths.includes(file.path) || paths.includes(name)) datasets.push({ name, csv: toCsv(table.rows) });
      }
    }
    return datasets;
  }

  async discoverColumns(paths: string[]): Promise<Array<{ name: string; columns: string[] }>> {
    const selected = [...new Set(paths)].sort();
    if (!selected.length) return [];
    const files = this.listDatasets().filter(file => selected.some(path => path === file.path || path.startsWith(file.path + "#")));
    const key = JSON.stringify([selected, files.map(file => [file.path, file.stat.mtime, file.stat.size])]);
    let cached = this.columnCache.get(key);
    if (!cached) {
      cached = this.loadDatasets(selected).then(datasets =>
        this.runner.run<Array<{ name: string; columns: string[] }>>({ action: "columns", datasets }));
      this.columnCache.set(key, cached);
      const oldest = [...this.columnCache.keys()][0];
      if (this.columnCache.size > 16 && oldest !== undefined) this.columnCache.delete(oldest);
      void cached.catch(() => { if (this.columnCache.get(key) === cached) this.columnCache.delete(key); });
    }
    return cached;
  }

  /** Each exact source selection has durable results without writing into source folders. */
  comparisonItem(paths: string[]): Investigation {
    const id = createHash("sha256").update(JSON.stringify([...new Set(paths)].sort())).digest("hex");
    return { id: `comparison:${id}`, folderPath: `Comsift/Comparisons/${id}` };
  }

  async analyzeFiles(paths: string[], signal?: AbortSignal, item?: Investigation): Promise<AnalysisResult> {
    const loaded = await this.loadDatasets(paths, signal);
    if (signal?.aborted) throw new Error("Analysis cancelled.");
    if (loaded.length < 2) throw new Error("Select at least two CSV datasets or spreadsheet tabs.");
    const { result } = await this.runDatasets(loaded, signal);
    const scope = item ?? this.comparisonItem(paths);
    await this.remapReviews(scope, result);
    const folder = await this.ensureFolder(scope, "Analysis");
    await this.plugin.app.vault.create(`${folder}/run-${Date.now()}.json`, JSON.stringify({
      createdAt: new Date().toISOString(), datasets: loaded.map(dataset => dataset.name), ...result,
    }, null, 2));
    await this.recordHistory(scope, result);
    await this.autoConfirm(scope, result, signal);
    return result;
  }

  private async runDatasets(loaded: Array<{ name: string; csv: string }>, signal?: AbortSignal) {
    const total = loaded.reduce((sum, dataset) => sum + dataset.csv.length, 0);
    if (total > 50_000_000) throw new Error("Dataset input exceeds 50 MB. Select smaller datasets.");
    let mappings: Record<string, Record<string, string>>;
    try { mappings = JSON.parse(this.plugin.setting.columnMapping || "{}") as Record<string, Record<string, string>>; }
    catch { throw new Error("Column mapping setting must be valid JSON."); }
    const request: AnalyzeRequest = {
      action: "analyze",
      datasets: loaded,
      mappings, mode: this.plugin.setting.analysisMode, threshold: this.plugin.setting.splinkThreshold,
      low_threshold: Math.min(this.plugin.setting.analysisLowThreshold, this.plugin.setting.splinkThreshold),
      model_path: this.plugin.setting.jinaModelPath, device: this.plugin.setting.jinaDevice,
    };
    const result = await this.runner.run<AnalysisResult>(request, signal);
    return { request, result };
  }

  async analyze(item: Investigation, signal?: AbortSignal, extraFolders: string[] = []): Promise<AnalysisResult> {
    const roots = [item.folderPath, ...extraFolders].map(stripSlash);
    const paths = this.listDatasets().filter(file => roots.some(root => !root || file.path.startsWith(root + "/")))
      .map(file => file.path);
    const loaded = await this.loadDatasets(paths, signal);
    if (signal?.aborted) throw new Error("Analysis cancelled.");
    if (loaded.length < 2) throw new Error("Add at least two CSV datasets or spreadsheet tabs to the selected folders.");
    const { request, result } = await this.runDatasets(loaded, signal);
    await this.remapReviews(item, result);
    const folder = await this.ensureFolder(item, "Analysis");
    const path = normalizePath(`${folder}/run-${Date.now()}.json`);
    await this.plugin.app.vault.create(path, JSON.stringify({
      createdAt: new Date().toISOString(), mode: request.mode, datasets: loaded.map(dataset => dataset.name), ...result,
    }, null, 2));
    await this.recordHistory(item, result);
    await this.autoConfirm(item, result, signal);
    return result;
  }

  /** Automatic confirmation uses the same persisted, reversible path as manual review. */
  async autoConfirm(item: Investigation, result: AnalysisResult, signal?: AbortSignal): Promise<number> {
    const threshold = this.plugin.setting.autoConfirmHighThreshold ?? 0.98;
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) return 0;
    const records = new Map(result.records.map(record => [record.id, record]));
    const reviews = await this.reviews(item);
    let count = 0;
    for (const pair of result.pairs) {
      if (signal?.aborted) throw new Error("Analysis cancelled.");
      const source = records.get(pair.left_id), candidate = records.get(pair.right_id);
      const key = `${pair.left_id} → ${pair.right_id}`;
      const reverse = `${pair.right_id} → ${pair.left_id}`;
      const score = pairEvidenceScore(pair);
      if (!source || !candidate || source === candidate || reviews[key] || reviews[reverse] || !Number.isFinite(score) || score > 1 || score < threshold) continue;
      await this.review(item, source, candidate, "confirmed");
      reviews[key] = { status: "confirmed" };
      count++;
    }
    return count;
  }

  /** Preserve reviews when row IDs shift; persisted keys always refer to the latest run. */
  private async remapReviews(item: Investigation, result: AnalysisResult) {
    const previous = await this.latestRun(item);
    const file = this.plugin.app.vault.getFileByPath(`${item.folderPath}/Analysis/reviews.json`);
    if (!previous || !file) return;
    const before = new Map(previous.records.map(record => [record.id, record]));
    const after = new Map(result.records.map(record => [record.id, record]));
    await this.plugin.app.vault.process(file, content => {
      const saved = parseJson<Record<string, Record<string, unknown>>>(content, {});
      const identities = new Map<string, Record<string, unknown>>();
      for (const pair of previous.pairs) {
        const left = before.get(pair.left_id), right = before.get(pair.right_id);
        const review = saved[`${pair.left_id} → ${pair.right_id}`];
        if (left && right && review) identities.set(pairKey(left, right), { ...review,
          graph_id: typeof review.graph_id === "string" ? review.graph_id : this.graphReviewKey(item, `${pair.left_id} → ${pair.right_id}`) });
      }
      // Keep reviews absent from this run for later scans, but clear old row IDs that
      // are now assigned to a different pair before restoring matching identities.
      const next = { ...saved };
      for (const pair of result.pairs) {
        const key = `${pair.left_id} → ${pair.right_id}`;
        delete next[key];
        const left = after.get(pair.left_id), right = after.get(pair.right_id);
        const review = left && right ? identities.get(pairKey(left, right)) : undefined;
        if (review) next[key] = { ...review, source_id: pair.left_id, candidate_id: pair.right_id };
      }
      return JSON.stringify(next, null, 2);
    });
  }

  async history(item: Investigation): Promise<PairHistory> {
    const file = this.plugin.app.vault.getFileByPath(`${item.folderPath}/Analysis/history.json`);
    if (!file) return {};
    return parseJson<PairHistory>(await this.plugin.app.vault.cachedRead(file), {});
  }

  private async recordHistory(item: Investigation, result: AnalysisResult) {
    const folder = await this.ensureFolder(item, "Analysis");
    const path = `${folder}/history.json`;
    let file = this.plugin.app.vault.getFileByPath(path);
    if (!file) file = await this.plugin.app.vault.create(path, "{}");
    await this.plugin.app.vault.process(file, content => {
      const previous = parseJson<PairHistory>(content, {});
      return JSON.stringify(mergeRun(previous, result, new Date().toISOString()), null, 2);
    });
  }

  /**
   * Jina decision: re-run the reranker on a dossier built from the results (scores, evidence signals,
   * earlier assessment) and the folder's context note, with an explicit NO_MATCH option.
   */
  async jinaDecide(item: Investigation | null, source: ProfileRecord, candidates: ProfileRecord[], result: AnalysisResult,
    threshold: number, signal?: AbortSignal): Promise<ReasonedResult> {
    if (!this.plugin.setting.jinaModelPath) throw new Error("Configure the Jina model directory in settings.");
    const profile = (record: ProfileRecord) => Object.entries(record.fields).filter(([, value]) => value)
      .map(([key, value]) => `${key}: ${value}`).join("; ");
    const note = item ? this.plugin.app.vault.getFileByPath(this.plugin.investigations.mdPath(item)) : null;
    const context = note ? sanitizeForModel(note.path, await this.plugin.app.vault.cachedRead(note)).slice(0, 1200) : "";
    const earlier = item ? (await this.previousDecisions(item))[source.id]?.decision : undefined;
    const query = [
      `Which candidate is the same person or account as the source? Source (${source.dataset}${source.section ? `, ${source.section}` : ""}): ${profile(source)}`,
      context ? `Investigation context: ${context.replace(/\s+/g, " ")}` : "",
      earlier ? `Earlier assessment: ${earlier.candidate_id} — ${earlier.explanation}` : "",
    ].filter(Boolean).join("\n");
    const options = candidates.map(candidate => {
      const pair = result.pairs.find(item => item.left_id === source.id && item.right_id === candidate.id);
      const facts: string[] = [];
      if (pair?.match_probability !== undefined) facts.push(`Splink probability ${pair.match_probability.toFixed(2)}`);
      if (pair?.evidence_score !== undefined) facts.push(`combined evidence ${pair.evidence_score.toFixed(2)}`);
      const signals = (pair?.evidence as { signals?: Record<string, number> } | undefined)?.signals;
      if (signals) facts.push(`matching signals: ${Object.entries(signals).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(", ")}`);
      return { id: candidate.id, text: `Candidate ${candidate.id}: ${profile(candidate)}. ${facts.join("; ")}` };
    });
    options.push({ id: "NO_MATCH", text: "NO_MATCH: none of the candidates is the same person; evidence is insufficient or conflicting." });
    const response = await this.runner.run<{ rankings: Array<{ id: string; score: number; rank: number }> }>({
      action: "rerank", query, candidates: options,
      model_path: this.plugin.setting.jinaModelPath, device: this.plugin.setting.jinaDevice,
    }, signal);
    const ranked = [...response.rankings].sort((x, y) => y.score - x.score);
    const [top, next] = ranked;
    const lead = next ? top.score - next.score : top.score;
    const table = ranked.map(entry => `${entry.id}: ${entry.score.toFixed(2)}`).join(", ");
    const pair = result.pairs.find(entry => entry.left_id === source.id && entry.right_id === top.id);
    const support = pair ? pairSignals(pair).map(name => `${name} matches`) : [];
    let decision: ReasonedResult["decision"];
    if (top.id === "NO_MATCH") {
      decision = { candidate_id: "NO_MATCH", explanation: `Jina ranked “no match” first. Scores — ${table}.`,
        supporting_evidence: [], conflicting_evidence: [], uncertain: false };
    } else {
      const strong = top.score >= threshold && lead >= 0.03;
      const weak = top.score < threshold * 0.85;
      decision = weak
        ? { candidate_id: "NO_MATCH", explanation: `Jina's best candidate scored only ${top.score.toFixed(2)} (threshold ${threshold.toFixed(2)}). Scores — ${table}.`,
          supporting_evidence: [], conflicting_evidence: [], uncertain: false }
        : { candidate_id: top.id, explanation: `Jina ${strong ? "picked" : "leans towards"} ${top.id}, ${lead.toFixed(2)} ahead. Scores — ${table}.`,
          supporting_evidence: support, conflicting_evidence: [], uncertain: !strong };
    }
    return { decision, interpretation: ranked };
  }

  async latestRun(item: Investigation): Promise<AnalysisResult | null> {
    const files = this.plugin.app.vault.getFiles()
      .filter(file => file.path.startsWith(`${item.folderPath}/Analysis/run-`) && file.extension === "json")
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
    if (!files.length) return null;
    const data = parseJson<Partial<AnalysisResult>>(await this.plugin.app.vault.cachedRead(files[0]), {});
    return Array.isArray(data.records) && Array.isArray(data.pairs) && Array.isArray(data.jina) ? data as AnalysisResult : null;
  }

  async reason(item: Investigation | null, source: ProfileRecord, candidates: ProfileRecord[], result: AnalysisResult,
    interpretWithJina: boolean, signal?: AbortSignal): Promise<ReasonedResult> {
    const decision = await this.llm.decide(source, candidates, result.pairs, result.jina, signal);
    let interpretation: Interpretation[] | undefined;
    if (interpretWithJina && this.plugin.setting.jinaModelPath) {
      const options = [...candidates.map(candidate => ({ id: candidate.id,
        text: `Selected ${candidate.id}: ${JSON.stringify(candidate.fields)}` })),
        { id: "NO_MATCH", text: "NO_MATCH: no candidate selected; insufficient or conflicting evidence." }];
      const response = await this.runner.run<{ rankings: Array<{ id: string; score: number; rank: number }> }>({
        action: "rerank", query: JSON.stringify(decision),
        candidates: options, model_path: this.plugin.setting.jinaModelPath, device: this.plugin.setting.jinaDevice,
      }, signal);
      interpretation = response.rankings;
    }
    const reasoned = { decision, interpretation };
    if (!item) return reasoned;
    const folder = await this.ensureFolder(item, "Analysis");
    const path = `${folder}/decisions.json`;
    let file = this.plugin.app.vault.getFileByPath(path);
    if (!file) file = await this.plugin.app.vault.create(path, "{}");
    await this.plugin.app.vault.process(file, content => {
      const data = parseJson<Record<string, unknown>>(content, {});
      data[source.id] = { ...reasoned, updatedAt: new Date().toISOString() };
      return JSON.stringify(data, null, 2);
    });
    return reasoned;
  }

  async previousDecisions(item: Investigation): Promise<Record<string, ReasonedResult>> {
    const file = this.plugin.app.vault.getFileByPath(`${item.folderPath}/Analysis/decisions.json`);
    if (!file) return {};
    return parseJson<Record<string, ReasonedResult>>(await this.plugin.app.vault.cachedRead(file), {});
  }

  /** Normalized, de-duplicated folders; "" means the vault root. */
  private roots(folders: string[]): string[] {
    const clean = [...new Set(folders.map(stripSlash))];
    return clean.includes("") ? [""] : clean;
  }

  private rootOf(path: string, roots: string[]): number {
    return roots.findIndex(root => !root || path.startsWith(root + "/"));
  }

  private chatReadable(path: string, extension: string, roots: string[]): boolean {
    const config = `${this.plugin.app.vault.configDir}/`;
    if (path.startsWith(config) || !CHAT_EXTENSIONS.includes(extension)) return false;
    return !roots.some(root => {
      const prefix = root ? root + "/" : "";
      return path.startsWith(`${prefix}Analysis/`) || path.startsWith(`${prefix}Chats/`);
    });
  }

  /**
   * Files linking the selected folders to each other (directly, or through one shared
   * note outside them), plus every note one link away from such a bridge.
   */
  private connections(roots: string[]): { bridges: Set<string>; neighbors: Set<string> } {
    const bridges = new Set<string>();
    const neighbors = new Set<string>();
    if (roots.length < 2) return { bridges, neighbors };
    const links = this.plugin.app.metadataCache.resolvedLinks;
    const adjacency = new Map<string, Set<string>>();
    const connect = (a: string, b: string) => {
      if (a === b) return;
      if (!adjacency.has(a)) adjacency.set(a, new Set());
      if (!adjacency.has(b)) adjacency.set(b, new Set());
      adjacency.get(a)!.add(b);
      adjacency.get(b)!.add(a);
    };
    for (const [source, targets] of Object.entries(links)) for (const target of Object.keys(targets)) connect(source, target);
    for (const [path, near] of adjacency) {
      const own = this.rootOf(path, roots);
      const reached = new Map<number, string[]>();
      for (const other of near) {
        const index = this.rootOf(other, roots);
        if (index < 0) continue;
        reached.set(index, [...(reached.get(index) ?? []), other]);
      }
      if (own >= 0) {
        for (const [index, others] of reached) {
          if (index === own) continue;
          bridges.add(path);
          others.forEach(other => bridges.add(other));
        }
      } else if (reached.size >= 2) {
        bridges.add(path);
        for (const others of reached.values()) others.forEach(other => bridges.add(other));
      }
    }
    for (const bridge of bridges) for (const other of adjacency.get(bridge) ?? []) if (!bridges.has(other)) neighbors.add(other);
    return { bridges, neighbors };
  }

  async chatContext(folders: string[], question: string, activePath: string | null, _selection: CanvasSelection | null = null): Promise<ChatContext> {
    const roots = this.roots(folders);
    const lower = question.toLowerCase();
    const primaryNotes = new Set(roots.map(root => this.plugin.investigations.forPath((root ? root + "/" : "") + "x"))
      .filter((item): item is Investigation => !!item).map(item => this.plugin.investigations.mdPath(item)));
    const { bridges, neighbors } = this.connections(roots);
    const { vault } = this.plugin.app;
    const canvases: CanvasContext[] = [];
    const canvasFiles = vault.getFiles().filter(file => file.extension === "canvas" && this.rootOf(file.path, roots) >= 0)
      .sort((a, b) => Number(b.path === activePath) - Number(a.path === activePath) || b.stat.mtime - a.stat.mtime);
    const canvasNotes = new Set<string>();
    let canvasChars = 0;
    const canvasBudget = Math.min(20000, Math.max(2000, Math.floor(this.plugin.setting.ollamaContext * 0.4)));
    for (const file of canvasFiles) {
      if (canvasChars >= canvasBudget) break;
      const data = parseCanvas(await vault.cachedRead(file));
      const personName = this.plugin.investigations.forPath(file.path)?.folderPath.split("/").at(-1) ?? file.basename;
      const digest = canvasDigest(data, { personName, maxText: 350 });
      digest.text = digest.text.slice(0, canvasBudget - canvasChars);
      canvasChars += digest.text.length;
      canvases.push({ path: file.path, personName, digest });
      for (const node of data.nodes) if (typeof node.file === "string") canvasNotes.add(node.file);
    }
    const inside = vault.getFiles().filter(file => this.rootOf(file.path, roots) >= 0 && this.chatReadable(file.path, file.extension, roots));
    const insidePaths = new Set(inside.map(file => file.path));
    const outside = [...new Set([...bridges, ...neighbors, ...canvasNotes])].filter(path => !insidePaths.has(path))
      .map(path => vault.getFileByPath(path))
      .filter((file): file is TFile => !!file && (this.chatReadable(file.path, file.extension, roots) ||
        (canvasNotes.has(file.path) && file.extension === "md" && !file.path.startsWith(`${vault.configDir}/`) && !/(?:^|\/)Chats\//.test(file.path))));
    const candidates = [...inside, ...new Set(outside)];
    const weight = (file: TFile) =>
      (primaryNotes.has(file.path) ? 1e15 : 0) + (file.path === activePath ? 9e14 : 0) +
      (bridges.has(file.path) ? 8.5e14 : 0) + (canvasNotes.has(file.path) ? 8.4e14 : 0) + (lower.includes(file.basename.toLowerCase()) ? 8e14 : 0) +
      (neighbors.has(file.path) ? 7e14 : 0) + file.stat.mtime;
    candidates.sort((x, y) => weight(y) - weight(x));
    // Roughly 3 characters per token, leaving a quarter of the window for the prompt and the answer.
    const budget = Math.max(4000, Math.floor(this.plugin.setting.ollamaContext * 2.25) - canvasChars);
    const perFile = Math.max(1500, Math.floor(budget / 3));
    let used = 0;
    const files: ContextFile[] = [];
    const snapshot = new Map<string, string>();
    for (const file of candidates) {
      if (used >= budget) break;
      const raw = await vault.cachedRead(file);
      const clean = isSheetPath(file.path)
        ? parseSheetMd(raw).map(table => `## sheet: ${table.name}\n${toCsv(table.rows)}`).join("\n")
        : this.plugin.setting.chatLineNumbers ? numberedForModel(file.path, raw) : sanitizeForModel(file.path, raw);
      const limit = Math.min(perFile, budget - used);
      const content = clean.slice(0, limit);
      const role = bridges.has(file.path) ? "bridge" : insidePaths.has(file.path) ? "folder" : "neighbor";
      files.push({ path: file.path, content, truncated: clean.length > limit, role });
      snapshot.set(file.path, raw);
      used += content.length;
    }
    return { canvases, files, tree: candidates.map(file => file.path), snapshot, omitted: candidates.length - files.length,
      bridges: [...bridges] };
  }

  async chat(folders: string[], question: string, history: ChatMessage[], onText: (text: string) => void,
    activePath: string | null, signal?: AbortSignal, onThinking?: (text: string) => void, selection: CanvasSelection | null = null) {
    const context = await this.chatContext(folders, question, activePath, selection);
    const fileBlocks = context.files.map(file =>
      `<file path="${file.path}"${file.role !== "folder" ? ` role="${file.role}"` : ""}${file.truncated ? ' truncated="true"' : ""}>\n${file.content}\n</file>`).join("\n");
    const label = this.roots(folders).map(root => root || "/").join(", ");
    const system = [fillPrompt(this.plugin.setting.chatPrompt ?? "", DEFAULT_CHAT_PROMPT, { folder: label }), CHAT_TOOL_RULES].filter(Boolean).join("\n\n");
    const canvasBlocks = context.canvases.map(canvas => `<canvas path="${canvas.path}">\n${canvas.digest.text}\n</canvas>`).join("\n");
    const user = `${canvasBlocks}\n<files_in_folder>\n${context.tree.join("\n") || "(no text files)"}\n</files_in_folder>\n${fileBlocks}\n\n${question}`;
    const answer = await this.llm.chatStream(
      [{ role: "system", content: system }, ...history.slice(-8), { role: "user", content: user }], onText, signal,
      this.plugin.setting.ollamaThink, onThinking);
    return { answer, context };
  }

  /** Validate an edit and compute what the file would look like; nothing is written. */
  async prepareEdit(folders: string[], edit: ProposedEdit): Promise<PreparedEdit> {
    const rawPath = edit.path.replace(/\\/g, "/").trim();
    const extension = rawPath.split(".").at(-1)?.toLowerCase();
    if (rawPath.split("/").includes("..") || rawPath.startsWith("/") || !extension || !CHAT_EXTENSIONS.includes(extension)) {
      throw new Error("Edit path must be a supported text file inside the selected folder.");
    }
    const roots = this.roots(folders);
    const root = roots.find(candidate => !candidate || rawPath.startsWith(candidate + "/")) ?? roots[0] ?? "";
    const path = normalizePath(!root || rawPath.startsWith(root + "/") ? rawPath : `${root}/${rawPath}`);
    if (root && !path.startsWith(root + "/")) throw new Error("Edit path escapes the selected folder.");
    if (isSheetPath(path)) throw new Error("Spreadsheets (.sheet.md) are edited in the spreadsheet view; the assistant can only read them.");
    if (path.startsWith(`${this.plugin.app.vault.configDir}/`)) throw new Error("Plugin configuration cannot be edited through chat.");
    if (path.startsWith(`${root ? root + "/" : ""}Chats/`)) throw new Error("Saved chats cannot be edited through chat.");
    if (path.startsWith(`${root ? root + "/" : ""}Analysis/`)) throw new Error("Generated analysis data cannot be edited through chat.");
    const existing = this.plugin.app.vault.getAbstractFileByPath(path);
    let before: string | null = null;
    if (edit.action === "create") {
      if (existing) throw new Error("A file already exists at that path.");
    } else {
      if (!(existing instanceof TFile)) throw new Error("The file to change does not exist.");
      before = await this.plugin.app.vault.read(existing);
    }
    const after = applyToText(edit, path, before);
    if (extension === "json") {
      try { JSON.parse(after); } catch { throw new Error("Resulting JSON would be invalid."); }
    }
    return { path, before, after, isNew: before === null };
  }

  async commitEdit(prepared: PreparedEdit): Promise<void> {
    const { vault } = this.plugin.app;
    if (prepared.isNew) {
      if (vault.getAbstractFileByPath(prepared.path)) throw new Error("A file already exists at that path.");
      await this.ensureRelativeFolder(prepared.path.slice(0, Math.max(0, prepared.path.lastIndexOf("/"))));
      await vault.create(prepared.path, prepared.after);
      return;
    }
    const file = vault.getAbstractFileByPath(prepared.path);
    if (!(file instanceof TFile)) throw new Error("The file no longer exists.");
    await vault.process(file, text => {
      if (text !== prepared.before) throw new Error("File changed since the proposal; ask the model again.");
      return prepared.after;
    });
  }

  async undoEdit(prepared: PreparedEdit): Promise<void> {
    const { vault, fileManager } = this.plugin.app;
    const file = vault.getAbstractFileByPath(prepared.path);
    if (!(file instanceof TFile)) throw new Error("The file no longer exists.");
    const current = await vault.read(file);
    if (current !== prepared.after) throw new Error("File was modified after the edit; undo would lose those changes.");
    if (prepared.isNew) await fileManager.trashFile(file);
    else await vault.modify(file, prepared.before!);
  }

  private graphReviewKey(item: Investigation, key: string): string {
    return item.id.startsWith("comparison:") ? `${item.id}:${key}` : key;
  }

  async reviews(item: Investigation): Promise<Record<string, { status: ReviewStatus }>> {
    const file = this.plugin.app.vault.getFileByPath(`${item.folderPath}/Analysis/reviews.json`);
    if (!file) return {};
    return parseJson<Record<string, { status: ReviewStatus }>>(await this.plugin.app.vault.cachedRead(file), {});
  }

  async review(item: Investigation, source: ProfileRecord, candidate: ProfileRecord, status: ReviewStatus,
    reasoned?: ReasonedResult): Promise<void> {
    const folder = await this.ensureFolder(item, "Analysis");
    const path = `${folder}/reviews.json`;
    let file = this.plugin.app.vault.getFileByPath(path);
    if (!file) file = await this.plugin.app.vault.create(path, "{}");
    const key = `${source.id} → ${candidate.id}`;
    let graphId = `${item.id}:pair:${createHash("sha256").update(pairKey(source, candidate)).digest("hex")}`;
    await this.plugin.app.vault.process(file, content => {
      const data = parseJson<Record<string, { graph_id?: string }>>(content, {});
      const previous = data[key];
      if (previous) graphId = typeof previous.graph_id === "string" ? previous.graph_id : this.graphReviewKey(item, key);
      const next: Record<string, unknown> = { ...data };
      next[key] = { status, updatedAt: new Date().toISOString(), source_id: source.id,
        candidate_id: candidate.id, graph_id: graphId, reasoned };
      return JSON.stringify(next, null, 2);
    });
    if (status === "confirmed" || status === "related") {
      const left = await this.profileNote(item, source);
      const right = await this.profileNote(item, candidate);
      await this.plugin.graph.addConfirmedLink(left.path, right.path, graphId);
      if (!item.id.startsWith("comparison:")) await this.plugin.graph.refreshInvestigation(item);
    } else await this.plugin.graph.removeConfirmedLink(graphId);
  }

  /** Turn a model decision into reviews: chosen → confirmed (or uncertain), the rest → rejected. */
  async applyDecision(item: Investigation, source: ProfileRecord, candidates: ProfileRecord[],
    reasoned: ReasonedResult): Promise<ReviewStatus> {
    const chosen = reasoned.decision.candidate_id;
    const status: ReviewStatus = chosen === "NO_MATCH" ? "rejected" : reasoned.decision.uncertain ? "uncertain" : "confirmed";
    return this.applyChoice(item, source, candidates, chosen, status, reasoned);
  }

  /**
   * Apply a reviewed choice: `chosen` gets `status`, every other candidate is rejected.
   * `later` leaves the others untouched so the source stays open.
   */
  async applyChoice(item: Investigation, source: ProfileRecord, candidates: ProfileRecord[], chosen: string,
    status: ReviewStatus, reasoned?: ReasonedResult): Promise<ReviewStatus> {
    if (chosen === "NO_MATCH") {
      for (const candidate of candidates) await this.review(item, source, candidate, status === "later" ? "later" : "rejected", reasoned);
      return status === "later" ? "later" : "rejected";
    }
    for (const candidate of candidates) {
      if (candidate.id === chosen) await this.review(item, source, candidate, status, reasoned);
      else if (status !== "later") await this.review(item, source, candidate, "rejected", reasoned);
    }
    return status;
  }

  /** Draw confirmed (same person) and related reviews as typed arrows between profile nodes on the person's Canvas. */
  async syncCanvasArrows(item: Investigation): Promise<{ added: number; removed: number }> {
    const result = await this.latestRun(item);
    const reviews = await this.reviews(item);
    const records = new Map((result?.records ?? []).map(record => [record.id, record]));
    const arrows: ReviewArrow[] = [];
    for (const [key, entry] of Object.entries(reviews)) {
      if (entry.status !== "confirmed" && entry.status !== "related") continue;
      const detail = entry as { source_id?: string; candidate_id?: string };
      const left = detail.source_id ? records.get(detail.source_id) : undefined;
      const right = detail.candidate_id ? records.get(detail.candidate_id) : undefined;
      if (!left || !right) continue;
      const [leftNote, rightNote] = [await this.profileNote(item, left), await this.profileNote(item, right)];
      if (leftNote === rightNote) continue;
      arrows.push({ key, type: entry.status === "confirmed" ? "same" : "related",
        left: { path: leftNote.path, dataset: left.dataset.split("#")[0] },
        right: { path: rightNote.path, dataset: right.dataset.split("#")[0] } });
    }
    const path = this.plugin.investigations.canvasPath(item);
    const name = item.folderPath.split("/").at(-1) ?? "same person";
    let outcome = { added: 0, removed: 0 };
    await this.plugin.canvasTools.mutate(path, data => {
      const synced = syncReviewArrows(data, arrows, { personName: name, colors: this.plugin.canvasTools.colorsFor(item), newId: uuid });
      outcome = { added: synced.added, removed: synced.removed };
      return synced.data;
    });
    this.plugin.graphColors?.schedule(800);
    return outcome;
  }

  /** Return a decided pair to the open queue and remove the Graph link it generated. */
  async unreview(item: Investigation, sourceId: string, candidateId: string): Promise<void> {
    const file = this.plugin.app.vault.getFileByPath(`${item.folderPath}/Analysis/reviews.json`);
    if (!file) return;
    const key = `${sourceId} → ${candidateId}`;
    const saved = parseJson<Record<string, { graph_id?: string }>>(await this.plugin.app.vault.read(file), {});
    const graphId = typeof saved[key]?.graph_id === "string" ? saved[key].graph_id : this.graphReviewKey(item, key);
    // Keep the persisted decision available if graph removal fails, so reopening can be retried.
    await this.plugin.graph.removeConfirmedLink(graphId);
    await this.plugin.app.vault.process(file, content => {
      const data = parseJson<Record<string, unknown> | null>(content, null);
      if (!data) return content;
      delete data[key];
      return JSON.stringify(data, null, 2);
    });
    if (!item.id.startsWith("comparison:")) await this.plugin.graph.refreshInvestigation(item);
  }

  /** File name for a profile note: the handle and platform, not the internal record id. */
  private profileName(fields: Record<string, string>, fallback: string): string {
    const handle = fields.username || fields.display_name || fields.name || fields.full_name || Object.entries(fields).filter(([key, value]) => key !== "platform" && value.trim()).sort(([a], [b]) => a.localeCompare(b))[0]?.[1] || fallback;
    const label = fields.platform ? `${handle} (${fields.platform})` : handle;
    return label.replace(/[\\/:*?"<>|#^[\]]/g, "_").replace(/\s+/g, " ").trim().slice(0, 100) || "profile";
  }

  private uniqueProfilePath(folder: string, name: string, self?: TFile): string {
    let path = normalizePath(`${folder}/${name}.md`);
    for (let n = 2; ; n++) {
      const existing = this.plugin.app.vault.getAbstractFileByPath(path);
      if (!existing || existing === self) return path;
      path = normalizePath(`${folder}/${name} ${n}.md`);
    }
  }

  /** Same account → same profile note, whichever dataset row it came from. */
  private accountKey(fields: Record<string, string>, fallback: string): string {
    const custom = Object.entries(fields).filter(([key, value]) => key !== "platform" && value.trim())
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, value.trim().toLowerCase()]);
    const handle = (fields.username || fields.profile_url || fields.display_name || fields.name || fields.full_name ||
      (custom.length ? JSON.stringify(custom) : fallback)).trim().toLowerCase().replace(/^@/, "");
    return `${(fields.platform ?? "").trim().toLowerCase()}|${handle}`;
  }

  private profileBody(records: Array<{ id: string; dataset: string; row: number; fields: Record<string, string> }>, name: string): string {
    const clean = (value: string) => value.replace(/[[\]<>]/g, "");
    const fields: Record<string, string> = {};
    for (const record of records) for (const [key, value] of Object.entries(record.fields)) if (value && !fields[key]) fields[key] = value;
    const sources = [...new Map(records.map(record => {
      const dataset = record.dataset.split("#")[0];
      return [`${dataset}:${record.row}`, `- [[${dataset.endsWith(".md") ? dataset.slice(0, -3) : dataset}]], row ${record.row}`];
    })).values()];
    const lines = Object.entries(fields).map(([key, value]) => `- ${key}: ${clean(value)}`).join("\n");
    return `---\ncomsift_account: ${JSON.stringify(this.accountKey(fields, records[0]?.id ?? name))}\n` +
      `comsift_records:\n${records.map(record => `  - ${JSON.stringify(record.id)}`).join("\n")}\n---\n` +
      `# ${clean(name)}\n\nSources:\n${sources.join("\n")}\n\n${lines}\n`;
  }

  private recordIds(file: TFile): string[] {
    const frontmatter = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
    const many: unknown = frontmatter?.comsift_records;
    const one: unknown = frontmatter?.comsift_record;
    const list: unknown[] = Array.isArray(many) ? many as unknown[] : [];
    return [...list, ...(typeof one === "string" ? [one] : [])].filter((value): value is string => typeof value === "string");
  }

  private async profileNote(item: Investigation, record: ProfileRecord): Promise<TFile> {
    const folder = await this.ensureFolder(item, "Analysis/Profiles");
    const { vault, metadataCache, fileManager } = this.plugin.app;
    const inFolder = vault.getMarkdownFiles().filter(file => file.path.startsWith(folder + "/"));
    const key = this.accountKey(record.fields, record.id);
    const known = inFolder.find(file => this.recordIds(file).includes(record.id) &&
      metadataCache.getFileCache(file)?.frontmatter?.comsift_account === key);
    if (known) return known;
    const sameAccount = inFolder.find(file => metadataCache.getFileCache(file)?.frontmatter?.comsift_account === key);
    if (sameAccount) {
      await fileManager.processFrontMatter(sameAccount, (frontmatter: Record<string, unknown>) => {
        const list: unknown = frontmatter.comsift_records;
        frontmatter.comsift_records = [...(Array.isArray(list) ? list as unknown[] : []), record.id];
      });
      return sameAccount;
    }
    const name = this.profileName(record.fields, record.id.split(":").at(-1) ?? "profile");
    return vault.create(this.uniqueProfilePath(folder, name), this.profileBody([record], name));
  }

  /** Read the records an older profile note describes (id-named 1.0.8 notes and 1.0.9 notes). */
  private recordsFromNote(file: TFile, text: string): Array<{ id: string; dataset: string; row: number; fields: Record<string, string> }> {
    const ids = this.recordIds(file);
    const heading = text.match(/^# (.+)$/m)?.[1]?.trim();
    if (!ids.length && heading?.includes(":")) ids.push(heading);
    const dataset = text.match(/^Source dataset: (?:\[\[)?([^\]\r\n]+?)(?:\]\])?\s*$/m)?.[1]?.trim()
      ?? text.match(/^- \[\[([^\]]+)\]\], row/m)?.[1]?.trim();
    if (!ids.length || !dataset) return [];
    const fields: Record<string, string> = {};
    for (const match of text.matchAll(/^- ([\w ]+): (.*)$/gm)) fields[match[1].trim()] = match[2].trim();
    const row = Number(text.match(/^Row: (\d+)/m)?.[1] ?? text.match(/row (\d+)/)?.[1] ?? 0);
    const datasetPath = /\.(md|csv)$/i.test(dataset) ? dataset : `${dataset}.md`;
    return ids.map(id => ({ id, dataset: datasetPath, row, fields }));
  }

  /**
   * On load: one profile note per account. Old id-named notes and duplicates of the same account
   * are merged into one readable note; links and Graph relationships move to the surviving note.
   */
  async migrateProfiles() {
    const { vault, metadataCache, fileManager } = this.plugin.app;
    let merged = 0;
    for (const item of Object.values(this.plugin.state.investigations)) {
      const folder = normalizePath(`${item.folderPath}/Analysis/Profiles`);
      const files = vault.getMarkdownFiles().filter(file => file.path.startsWith(folder + "/"));
      const groups = new Map<string, Array<{ file: TFile; records: ReturnType<AnalysisService["recordsFromNote"]> }>>();
      let stale = false;
      for (const file of files) {
        const frontmatter = metadataCache.getFileCache(file)?.frontmatter;
        const records = this.recordsFromNote(file, await vault.read(file));
        if (!records.length) continue;
        if (frontmatter?.comsift_account === undefined) stale = true;
        const key = typeof frontmatter?.comsift_account === "string" ? frontmatter.comsift_account
          : this.accountKey(records[0].fields, records[0].id);
        groups.set(key, [...(groups.get(key) ?? []), { file, records }]);
      }
      if (!stale && [...groups.values()].every(group => group.length === 1)) continue;
      for (const group of groups.values()) {
        const [survivor, ...duplicates] = group.sort((a, b) => a.file.path.length - b.file.path.length || a.file.path.localeCompare(b.file.path));
        const records = [...new Map(group.flatMap(entry => entry.records).map(record => [record.id, record])).values()];
        const name = this.profileName(records[0].fields, records[0].id.split(":").at(-1) ?? "profile");
        try {
          await vault.process(survivor.file, () => this.profileBody(records, name));
          for (const duplicate of duplicates) {
            this.plugin.graph.remap(duplicate.file.path, survivor.file.path);
            await fileManager.trashFile(duplicate.file);
            merged++;
          }
          const target = this.uniqueProfilePath(folder, name, survivor.file);
          if (target !== survivor.file.path) await fileManager.renameFile(survivor.file, target);
        } catch (error) { console.error("[comsift] profile migration failed", survivor.file.path, error); }
      }
      await this.plugin.saveState();
      if (!item.id.startsWith("comparison:")) await this.plugin.graph.refreshInvestigation(item);
    }
    if (merged) new Notice(`Comsift: merged ${merged} duplicate profile note${merged === 1 ? "" : "s"} (one note per account now).`);
  }

  private async ensureFolder(item: Investigation, relative: string): Promise<string> {
    const path = normalizePath(`${item.folderPath}/${relative}`);
    await this.ensureRelativeFolder(path);
    return path;
  }
  private async ensureRelativeFolder(path: string) {
    let current = "";
    for (const part of path.split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      const found = this.plugin.app.vault.getAbstractFileByPath(current);
      if (!found) await this.plugin.app.vault.createFolder(current);
      else if (!(found instanceof TFolder)) throw new Error(`Not a folder: ${current}`);
    }
  }
}
