import { request as httpRequest, type IncomingMessage } from "http";
import { request as httpsRequest } from "https";
import type { ComsiftSettings } from "../module";
import { DEFAULT_DECISION_PROMPT, fillPrompt } from "./prompts";
import type { ProfileRecord, CandidatePair, JinaRanking } from "./runner";

export type Verdict = "same" | "related" | "uncertain" | "different";
export const VERDICTS: Verdict[] = ["same", "related", "uncertain", "different"];
export interface CandidateVerdict { candidate_id: string; verdict: Verdict; reason: string }
export interface PreviousDecisionContext { source: ProfileRecord; candidate: ProfileRecord; status: string; reason?: string }
export interface DecisionOptions { /** Include Splink and Jina scores. Off for the first, human-style pass. */ scores?: boolean; earlier?: Decision; previous?: PreviousDecisionContext[] }
export interface Decision {
  /** Best candidate, or NO_MATCH. Kept for older saved decisions; `verdicts` is the full answer. */
  verdicts?: CandidateVerdict[];
  candidate_id: string;
  explanation: string;
  supporting_evidence: string[];
  conflicting_evidence: string[];
  uncertain: boolean;
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export interface ModelTool { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface ModelToolCall { id: string; name: string; arguments: unknown }
export interface ToolMessage { role: "system" | "user" | "assistant" | "tool"; content: string; calls?: ModelToolCall[]; callId?: string; name?: string; thinking?: string }
export interface ToolReply { content: string; calls: ModelToolCall[]; thinking?: string }

/** Settings the clients read; a subset so tests can pass plain objects. */
export type LlmSettings = Pick<ComsiftSettings, "ollamaUrl" | "ollamaModel" | "ollamaContext" | "ollamaTimeout"> &
  Partial<Pick<ComsiftSettings, "ollamaDevice" | "ollamaMaxTokens" | "ollamaKeepAlive" | "decisionPrompt" |
    "aiProvider" | "apiBaseUrl" | "apiKey" | "apiExtraParams" | "ollamaThink" | "decisionIgnoredFields">>;

export interface LlmClient {
  readonly label: string;
  models(signal?: AbortSignal): Promise<string[]>;
  running(signal?: AbortSignal): Promise<Array<{ name: string; size: number; vram: number }>>;
  decide(source: ProfileRecord, candidates: ProfileRecord[], pairs: CandidatePair[],
    rankings: JinaRanking[], signal?: AbortSignal, options?: DecisionOptions): Promise<Decision>;
  chatStream(messages: ChatMessage[], onText: (accumulated: string) => void, signal?: AbortSignal,
    think?: boolean, onThinking?: (accumulated: string) => void): Promise<string>;
  toolChat?(messages: ToolMessage[], tools: ModelTool[], signal?: AbortSignal, think?: boolean, onText?: (text: string) => void, onThinking?: (text: string) => void): Promise<ToolReply>;
}


const OPEN_TAGS = ["<think>", "<thinking>", "<reasoning>"];
const CLOSE_TAGS = ["</think>", "</thinking>", "</reasoning>"];
/** Length of a trailing fragment that could still turn into one of the tags. */
function tagTail(data: string, tags: string[]): number {
  for (let size = Math.min(data.length, 12); size > 0; size--) {
    const tail = data.slice(-size).toLowerCase();
    if (tags.some(tag => tag.startsWith(tail))) return size;
  }
  return 0;
}

/**
 * Some models write their reasoning into the reply inside think tags even when thinking is off.
 * Incremental: each chunk is scanned once, so long reasoning cannot stall the UI.
 */
export class ReasoningSplitter {
  text = "";
  thinking = "";
  private pending = "";
  private inside = false;
  push(chunk: string) {
    let data = this.pending + chunk;
    this.pending = "";
    while (data) {
      if (this.inside) {
        const end = data.search(/<\/(?:think|thinking|reasoning)>/i);
        if (end < 0) {
          const keep = tagTail(data, CLOSE_TAGS);
          this.thinking += data.slice(0, data.length - keep); this.pending = data.slice(data.length - keep);
          return;
        }
        this.thinking += data.slice(0, end);
        data = data.slice(end).replace(/^<\/[a-z]+>\s*/i, "");
        this.inside = false;
      } else {
        const start = data.search(/<(?:think|thinking|reasoning)>/i);
        if (start < 0) {
          const keep = tagTail(data, OPEN_TAGS);
          this.text += data.slice(0, data.length - keep); this.pending = data.slice(data.length - keep);
          return;
        }
        this.text += data.slice(0, start);
        data = data.slice(start).replace(/^<[a-z]+>/i, "");
        this.inside = true;
      }
    }
  }
  /** Call once the stream ends: a held back fragment outside a tag was ordinary text. */
  finish() {
    if (!this.inside) this.text += this.pending;
    this.pending = "";
    this.thinking = this.thinking.trim();
    return this;
  }
}

export function splitReasoning(raw: string): { text: string; thinking: string } {
  const splitter = new ReasoningSplitter();
  splitter.push(raw);
  return { text: splitter.text, thinking: splitter.thinking.trim() };
}

function parseToolReply(message: Record<string, unknown>): ToolReply {
  const calls = message.tool_calls === undefined ? [] : responseArray(message.tool_calls).map((call, index) => {
    const fn = responseObject(call.function);
    return { id: typeof call.id === "string" ? call.id : `call_${index}`, name: responseText(fn.name), arguments: fn.arguments };
  });
  if (calls.length > 12) throw new Error("The model returned too many tool calls.");
  return { content: responseText(message.content), calls, thinking: responseText(message.thinking ?? message.reasoning_content) };
}

function toolMessages(messages: ToolMessage[], api: boolean): Record<string, unknown>[] {
  return messages.map(message => ({ role: message.role, content: message.content,
    ...(message.thinking && !api ? { thinking: message.thinking } : {}),
    ...(message.role === "tool" ? api ? { tool_call_id: message.callId } : { tool_name: message.name } : {}),
    ...(message.calls?.length ? { tool_calls: message.calls.map(call => api ? { id: call.id, type: "function", function: { name: call.name, arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments) } } : { function: { name: call.name, arguments: typeof call.arguments === "string" ? parseJsonContent(call.arguments) : call.arguments } }) } : {}),
  }));
}

const decisionSchema = {
  type: "object", required: ["verdicts", "candidate_id", "explanation", "supporting_evidence", "conflicting_evidence", "uncertain"],
  additionalProperties: false,
  properties: {
    verdicts: { type: "array", items: { type: "object", required: ["candidate_id", "verdict", "reason"], additionalProperties: false,
      properties: { candidate_id: { type: "string" }, verdict: { type: "string", enum: VERDICTS }, reason: { type: "string" } } } },
    candidate_id: { type: "string" }, explanation: { type: "string" },
    supporting_evidence: { type: "array", items: { type: "string" } },
    conflicting_evidence: { type: "array", items: { type: "string" } },
    uncertain: { type: "boolean" },
  },
};

function decisionSchemaFor(candidates: ProfileRecord[]) {
  const ids = candidates.map((_, index) => candidateAlias(index));
  return { ...decisionSchema, properties: { ...decisionSchema.properties,
    verdicts: { ...decisionSchema.properties.verdicts, items: { ...decisionSchema.properties.verdicts.items,
      properties: { ...decisionSchema.properties.verdicts.items.properties, candidate_id: { type: "string", enum: ids } } } },
    candidate_id: { type: "string", enum: [...ids, "NO_MATCH"] },
  } };
}

/** Best candidate and overall doubt, derived from per-candidate verdicts. */
export function summarizeVerdicts(verdicts: CandidateVerdict[]): { candidate_id: string; uncertain: boolean } {
  for (const verdict of ["same", "related", "uncertain"] as Verdict[]) {
    const found = verdicts.find(entry => entry.verdict === verdict);
    if (found) return { candidate_id: found.candidate_id, uncertain: verdict === "uncertain" };
  }
  return { candidate_id: "NO_MATCH", uncertain: false };
}

export function validateDecision(value: unknown, ids: string[]): Decision {
  if (!isPlainObject(value)) throw new Error("The model returned no structured decision.");
  const data = value as Partial<Decision>;
  if (typeof data.candidate_id !== "string" || ![...ids, "NO_MATCH"].includes(data.candidate_id)) {
    throw new Error("The model selected an unknown candidate.");
  }
  if (typeof data.explanation !== "string" || typeof data.uncertain !== "boolean" ||
      !Array.isArray(data.supporting_evidence) || !data.supporting_evidence.every(item => typeof item === "string") ||
      !Array.isArray(data.conflicting_evidence) || !data.conflicting_evidence.every(item => typeof item === "string")) {
    throw new Error("The model decision did not match the required schema.");
  }
  if (data.verdicts !== undefined) {
    if (!Array.isArray(data.verdicts) || !data.verdicts.every(entry => isPlainObject(entry) && typeof entry.candidate_id === "string" && ids.includes(entry.candidate_id) &&
        VERDICTS.includes(entry.verdict) && typeof entry.reason === "string")) throw new Error("The model verdicts did not match the required schema.");
    const seen = new Set(data.verdicts.map(entry => entry.candidate_id));
    // A model that skips a candidate gets "uncertain" for it, so every candidate still shows up for review.
    data.verdicts = [...data.verdicts, ...ids.filter(id => !seen.has(id)).map(id => ({ candidate_id: id, verdict: "uncertain" as const, reason: "The model did not assess this candidate." }))];
  }
  return data as Decision;
}

export interface ExtraParams {
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function assertSafeKeys(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      throw new Error(`Invalid extra request parameter: "${key}"`);
    }
    assertSafeKeys(nested);
  }
}

/**
 * Parse line separated `key=value` request customizations.
 * Dotted keys nest (`options.temperature=0.2`), values are JSON when they parse
 * (`stop=["\n\n"]`, `top_k=40`, `stream=false`), otherwise plain strings.
 * `header.Name=value` lines become HTTP headers. `#` starts a comment line.
 */
export function parseExtraParams(text: string | undefined): ExtraParams {
  const body: Record<string, unknown> = {};
  const headers: Record<string, string> = {};
  for (const rawLine of (text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const split = line.indexOf("=");
    if (split <= 0) throw new Error(`Extra request parameter needs key=value: "${line}"`);
    const key = line.slice(0, split).trim();
    const rawValue = line.slice(split + 1).trim();
    if (/^headers?\./i.test(key)) {
      const name = key.replace(/^headers?\./i, "");
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
          /^(host|content-length|content-type|__proto__|prototype|constructor)$/i.test(name)) {
        throw new Error(`Invalid or reserved extra HTTP header: "${name}"`);
      }
      headers[name] = rawValue;
      continue;
    }
    let value: unknown = rawValue;
    try { value = JSON.parse(rawValue) as unknown; } catch { /* plain string */ }
    assertSafeKeys(value);
    const parts = key.split(".").filter(Boolean);
    if (!parts.length || parts.some(part => ["__proto__", "prototype", "constructor"].includes(part))) {
      throw new Error(`Invalid extra request parameter: "${key}"`);
    }
    let target = body;
    parts.slice(0, -1).forEach(part => {
      const next = target[part];
      if (!next || typeof next !== "object" || Array.isArray(next)) target[part] = {};
      target = target[part] as Record<string, unknown>;
    });
    const last = parts.at(-1);
    if (last) target[last] = value;
  }
  return { body, headers };
}

/** Deep merge `extra` into `base`; plain objects merge, everything else is replaced. */
export function mergeBody(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  assertSafeKeys(extra);
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const current = result[key];
    result[key] = isPlainObject(current) && isPlainObject(value) ? mergeBody(current, value) : value;
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function responseObject(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error("The service returned an invalid response object.");
  return value;
}

function responseArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isPlainObject)) {
    throw new Error("The service returned an invalid response array.");
  }
  return value;
}

function responseText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error("The service returned invalid message text.");
  return value;
}

function responseSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("The service returned an invalid model size.");
  }
  return value;
}

function errorText(parsed: unknown, fallback: string): string {
  if (!isPlainObject(parsed)) return fallback;
  const error = parsed.error;
  if (typeof error === "string") return error;
  if (isPlainObject(error) && typeof error.message === "string") return error.message;
  return fallback;
}

/** A failed model request with enough detail to diagnose it: HTTP status, request summary and response body. */
export class ModelError extends Error {
  constructor(message: string, readonly status: number | undefined, readonly request: string, readonly body?: string) { super(message); this.name = "ModelError"; }
}

function describeRequest(options: { url: URL; body?: Record<string, unknown> }): string {
  const body = options.body ?? {};
  const messages = Array.isArray(body.messages) ? body.messages as Array<{ content?: unknown }> : [];
  const tools = Array.isArray(body.tools) ? (body.tools as Array<{ function?: { name?: string } }>).map(tool => tool.function?.name).filter(Boolean) : [];
  return [`${options.body ? "POST" : "GET"} ${options.url.origin}${options.url.pathname}`,
    typeof body.model === "string" ? `model: ${body.model}` : "",
    messages.length ? `messages: ${messages.length} (${messages.reduce((sum, message) => sum + (typeof message.content === "string" ? message.content.length : 0), 0)} characters)` : "",
    tools.length ? `tools: ${tools.join(", ")}` : "",
    "think" in body ? `think: ${String(body.think)}` : "",
    isPlainObject(body.options) ? `options: ${JSON.stringify(body.options)}` : ""].filter(Boolean).join("\n");
}

interface HttpOptions {
  url: URL;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutSeconds: number;
  service: string;
}

function openRequest(options: HttpOptions, onResponse: (response: IncomingMessage) => void,
  reject: (error: Error) => void) {
  const { url, body, signal, service } = options;
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`${service} URL must use HTTP or HTTPS.`);
  if (url.username || url.password) throw new Error(`${service} URL must not contain credentials.`);
  if (options.headers && Object.keys(options.headers).some(name => name.toLowerCase() === "authorization") &&
      url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error(`${service} API credentials require HTTPS outside localhost.`);
  }
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string | number> = { ...(options.headers ?? {}) };
  if (serialized) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(serialized);
  }
  const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
    method: serialized ? "POST" : "GET", headers, signal,
    timeout: Math.max(1, options.timeoutSeconds) * 1000,
  }, onResponse);
  request.on("timeout", () => request.destroy(new Error(`${service} timed out.`)));
  request.on("error", error => {
    if (signal?.aborted) reject(new DOMException("Cancelled", "AbortError"));
    else reject(new ModelError(`${service} unavailable at ${url.origin}: ${error.message}`, undefined, describeRequest(options)));
  });
  request.end(serialized);
  return request;
}

function requestJson(options: HttpOptions): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const request = openRequest(options, response => {
      let content = "";
      response.on("error", error => reject(error));
      response.on("aborted", () => reject(new Error(`${options.service} response was interrupted.`)));
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        content += chunk;
        if (content.length > 5_000_000) request.destroy(new Error(`${options.service} response too large.`));
      });
      response.on("end", () => {
        try {
          if (!content.trim()) throw new Error(`${options.service} returned an empty response (HTTP ${response.statusCode ?? "?"}).`);
          const parsed = JSON.parse(content) as unknown;
          const status = response.statusCode ?? 500;
          if (status >= 400) throw new ModelError(errorText(parsed, `HTTP ${status}`), status, describeRequest(options), content.slice(0, 2000));
          resolve(responseObject(parsed));
        } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
      });
    }, reject);
  });
}

/** POST and feed each complete response line to `consume`; resolves when the stream ends. */
function requestLines(options: HttpOptions, consume: (line: string) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    openRequest(options, response => {
      response.on("error", error => reject(error));
      response.on("aborted", () => reject(new Error(`${options.service} response was interrupted.`)));
      response.setEncoding("utf8");
      const status = response.statusCode ?? 500;
      let buffer = "";
      let errorBody = "";
      let received = 0;
      response.on("data", (chunk: string) => {
        received += Buffer.byteLength(chunk);
        if (received > 20_000_000) {
          response.destroy(new Error(`${options.service} response too large.`));
          return;
        }
        if (status >= 400) { errorBody += chunk; return; }
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        try { lines.forEach(consume); } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          reject(failure);
          response.destroy(failure);
        }
      });
      response.on("end", () => {
        if (status >= 400) {
          let message = `HTTP ${status}`;
          try { message = errorText(JSON.parse(errorBody) as unknown, message); } catch { /* keep status */ }
          reject(new ModelError(message, status, describeRequest(options), errorBody.slice(0, 2000)));
          return;
        }
        try { consume(buffer); resolve(); } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
      });
    }, reject);
  });
}

/** Only the fields explicitly allowed for AI leave the profile boundary. */
export function decisionProfile(settings: Pick<LlmSettings, "decisionIgnoredFields">, record: ProfileRecord) {
  const ignored = new Set((settings.decisionIgnoredFields ?? "").split(",").map(field => field.trim().toLowerCase()).filter(Boolean));
  return Object.fromEntries(Object.entries(record.fields).filter(([key, value]) => {
    const field = key.toLowerCase();
    return value && !field.startsWith("_comsift") && !field.startsWith("comsift_") && !ignored.has(field) && !ignored.has(field.replace(/^(?:column|id|note):/, ""));
  }));
}

function candidateAlias(index: number): string { return `candidate_${index + 1}`; }

function parseDecision(content: string, candidates: ProfileRecord[]): Decision {
  const aliases = candidates.map((_, index) => candidateAlias(index));
  const decision = validateDecision(parseJsonContent(content), aliases);
  if (!decision.verdicts || decision.verdicts.length !== candidates.length ||
      new Set(decision.verdicts.map(entry => entry.candidate_id)).size !== candidates.length ||
      decision.verdicts.some(entry => !entry.reason.trim() || entry.reason === "The model did not assess this candidate.") || !decision.explanation.trim()) {
    throw new Error("The model must assess every candidate exactly once with a reason.");
  }
  const realId = (id: string) => id === "NO_MATCH" ? id : candidates[aliases.indexOf(id)].id;
  const verdicts = decision.verdicts.map(entry => ({ ...entry, candidate_id: realId(entry.candidate_id) }));
  return { ...decision, verdicts, ...summarizeVerdicts(verdicts) };
}

function decisionMessages(settings: LlmSettings, source: ProfileRecord, candidates: ProfileRecord[],
  pairs: CandidatePair[], rankings: JinaRanking[], options: DecisionOptions = {}): ChatMessage[] {
  const profile = (record: ProfileRecord) => decisionProfile(settings, record);
  const entries = candidates.map((candidate, index) => ({
    id: candidateAlias(index), profile: profile(candidate),
    ...(options.scores ? { analysis_scores: { splink: pairs.find(pair => pair.left_id === source.id && pair.right_id === candidate.id)?.match_probability,
      jina: rankings.find(rank => rank.source_id === source.id && rank.id === candidate.id)?.score } } : {}),
  }));
  return [
    { role: "system", content: fillPrompt(settings.decisionPrompt ?? "", DEFAULT_DECISION_PROMPT, {}) },
    { role: "user", content: JSON.stringify({ source: { id: "source", profile: profile(source) }, candidates: entries,
      ...(options.previous?.length ? { previous_decisions: options.previous.map(entry => ({ source: profile(entry.source), candidate: profile(entry.candidate), verdict: entry.status === "confirmed" ? "same" : entry.status === "rejected" ? "different" : entry.status })),
        previous_decisions_instruction: "These earlier judgments are fallible context, not proof or new profile facts. Compare relevant surname and biography patterns consistently, while evaluating each candidate independently. Current visible profile evidence takes priority; do not propagate an unsupported judgment." } : {}),
      ...(options.earlier ? { your_first_answer: options.earlier.verdicts?.map(entry => ({ ...entry, candidate_id: candidateAlias(candidates.findIndex(candidate => candidate.id === entry.candidate_id)) })) } : {}),
      instruction: options.scores
        ? "Second look. Some candidates were uncertain. Analysis scores are attached as extra hints, not as the answer. Reconsider every candidate and give a verdict for each."
        : "Give one verdict for every candidate, using the candidate ids exactly as supplied. Also fill candidate_id with the best same, related or uncertain candidate id, or NO_MATCH if all are different. The ids are opaque response labels, never identity evidence." }) },
  ];
}

function parseJsonContent(content: string | undefined | null): unknown {
  if (!content) throw new Error("The model returned an empty message.");
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  try { return JSON.parse(fenced ? fenced[1] : content) as unknown; }
  catch { throw new Error("The model returned invalid JSON."); }
}

export class OllamaClient implements LlmClient {
  readonly label = "Ollama";
  constructor(private settings: LlmSettings) {}

  private base(): URL { return new URL(this.settings.ollamaUrl); }
  private extra(): ExtraParams { return parseExtraParams(this.settings.apiExtraParams); }
  private keepAlive(): string | number {
    const raw = (this.settings.ollamaKeepAlive ?? "30m").trim() || "30m";
    return /^-?\d+$/.test(raw) ? Number(raw) : raw;
  }

  private options(): Record<string, unknown> {
    return { num_ctx: this.settings.ollamaContext, num_predict: this.settings.ollamaMaxTokens ?? -1,
      ...(this.settings.ollamaDevice === "cpu" ? { num_gpu: 0 } : {}) };
  }

  private http(endpoint: string, body?: Record<string, unknown>, signal?: AbortSignal): HttpOptions {
    const base = this.base();
    return { url: new URL(endpoint, base.origin), body, signal, headers: this.extra().headers,
      timeoutSeconds: this.settings.ollamaTimeout, service: "Ollama" };
  }

  async models(signal?: AbortSignal): Promise<string[]> {
    const response = await requestJson(this.http("/api/tags", undefined, signal));
    return responseArray(response.models).map(model => responseText(model.name)).filter(Boolean);
  }
  async toolChat(messages: ToolMessage[], tools: ModelTool[], signal?: AbortSignal, think = false, onText?: (text: string) => void, onThinking?: (text: string) => void): Promise<ToolReply> {
    if (!this.settings.ollamaModel.trim()) throw new Error("Select an installed Ollama model.");
    const body = { ...mergeBody({ model: this.settings.ollamaModel, options: this.options(), keep_alive: this.keepAlive(), think }, this.extra().body), think };
    const reply: ToolReply = { content: "", calls: [], thinking: "" };
    const splitter = new ReasoningSplitter();
    await requestLines(this.http("/api/chat", { ...body, messages: toolMessages(messages, false), tools, stream: true }, signal), line => {
      if (!line.trim()) return;
      const response = responseObject(JSON.parse(line) as unknown);
      if (response.error) throw new Error(errorText(response, "Ollama tool request failed."));
      const part = parseToolReply(response.message === undefined ? {} : responseObject(response.message));
      splitter.push(part.content); reply.thinking += part.thinking ?? "";
      for (const call of part.calls) reply.calls.push({ ...call, id: `call_${reply.calls.length}` });
      if (reply.calls.length > 12) throw new Error("The model returned too many tool calls.");
      if (part.content) { reply.content = splitter.text; onText?.(reply.content); }
      if (part.thinking) onThinking?.(reply.thinking ?? "");
    });
    splitter.finish();
    reply.content = splitter.text;
    if (splitter.thinking) { reply.thinking = [reply.thinking, splitter.thinking].filter(Boolean).join("\n\n"); onThinking?.(reply.thinking); }
    return reply;
  }

  /** Models currently loaded in Ollama with how much of each sits in GPU memory. */
  async running(signal?: AbortSignal): Promise<Array<{ name: string; size: number; vram: number }>> {
    const response = await requestJson(
      this.http("/api/ps", undefined, signal));
    return responseArray(response.models).map(model => ({ name: responseText(model.name),
      size: responseSize(model.size), vram: responseSize(model.size_vram ?? 0) }));
  }

  async decide(source: ProfileRecord, candidates: ProfileRecord[], pairs: CandidatePair[],
    rankings: JinaRanking[], signal?: AbortSignal, options?: DecisionOptions): Promise<Decision> {
    if (!this.settings.ollamaModel.trim()) throw new Error("Select an installed Ollama model.");
    const body = mergeBody({
      model: this.settings.ollamaModel, messages: decisionMessages(this.settings, source, candidates, pairs, rankings, options),
      format: decisionSchemaFor(candidates), stream: false, think: this.settings.ollamaThink ?? false, options: this.options(), keep_alive: this.keepAlive(),
    }, this.extra().body);
    const response = await requestJson(this.http("/api/chat", { ...body, stream: false, think: this.settings.ollamaThink ?? false }, signal));
    return parseDecision(responseText(responseObject(response.message).content), candidates);
  }

  /** Streams a plain-text/markdown chat reply; `onText` receives the accumulated text. */
  async chatStream(messages: ChatMessage[], onText: (accumulated: string) => void, signal?: AbortSignal,
    think = false, onThinking?: (accumulated: string) => void): Promise<string> {
    if (!this.settings.ollamaModel.trim()) throw new Error("Select an installed Ollama model.");
    const body = { ...mergeBody({
      model: this.settings.ollamaModel, messages, stream: true, keep_alive: this.keepAlive(), think, options: this.options(),
    }, this.extra().body), think };
    const splitter = new ReasoningSplitter();
    let reasoning = "";
    let failure: string | null = null;
    await requestLines(this.http("/api/chat", body, signal), line => {
      if (!line.trim()) return;
      const parsed = responseObject(JSON.parse(line) as unknown);
      if (parsed.error) failure = errorText(parsed, "Ollama stream error");
      const message = parsed.message === undefined ? {} : responseObject(parsed.message);
      const thought = responseText(message.thinking);
      if (thought) { reasoning += thought; onThinking?.(reasoning); }
      const piece = responseText(message.content);
      if (piece) { splitter.push(piece); onText(splitter.text); }
    });
    if (failure !== null) throw new Error(failure);
    splitter.finish();
    if (splitter.thinking) onThinking?.([reasoning, splitter.thinking].filter(Boolean).join("\n\n"));
    return splitter.text;
  }
}

/** Any OpenAI compatible endpoint: OpenAI, OpenRouter, Groq, Mistral, LM Studio, vLLM, llama.cpp server… */
export class OpenAiClient implements LlmClient {
  readonly label = "API";
  constructor(private settings: LlmSettings) {}

  private extra(): ExtraParams { return parseExtraParams(this.settings.apiExtraParams); }

  private http(endpoint: string, body?: Record<string, unknown>, signal?: AbortSignal): HttpOptions {
    const raw = (this.settings.apiBaseUrl ?? "").trim();
    if (!raw) throw new Error("Set the API base URL in settings.");
    const base = raw.endsWith("/") ? raw : `${raw}/`;
    const headers: Record<string, string> = {};
    const key = (this.settings.apiKey ?? "").trim();
    if (key) headers.authorization = `Bearer ${key}`;
    return { url: new URL(endpoint.replace(/^\//, ""), base), body, signal,
      headers: { ...headers, ...this.extra().headers }, timeoutSeconds: this.settings.ollamaTimeout, service: "API" };
  }

  private limits(): Record<string, unknown> {
    const max = this.settings.ollamaMaxTokens ?? -1;
    return max > 0 ? { max_tokens: max } : {};
  }

  async models(signal?: AbortSignal): Promise<string[]> {
    const response = await requestJson(this.http("models", undefined, signal));
    return responseArray(response.data).map(model => responseText(model.id)).filter(Boolean).sort();
  }

  running(): Promise<Array<{ name: string; size: number; vram: number }>> { return Promise.resolve([]); }
  async toolChat(messages: ToolMessage[], tools: ModelTool[], signal?: AbortSignal, think = false, onText?: (text: string) => void, onThinking?: (text: string) => void): Promise<ToolReply> {
    if (!this.settings.ollamaModel.trim()) throw new Error("Choose a model for the API.");
    const body = mergeBody({ model: this.settings.ollamaModel, ...this.limits(), ...(think ? { reasoning_effort: "medium" } : {}) }, this.extra().body);
    const reply: ToolReply = { content: "", calls: [], thinking: "" };
    const calls = new Map<number, ModelToolCall>();
    const splitter = new ReasoningSplitter();
    await requestLines(this.http("chat/completions", { ...body, messages: toolMessages(messages, true), tools, stream: true }, signal), raw => {
      const line = raw.trim();
      if (!line.startsWith("data:")) return;
      const content = line.slice(5).trim(); if (!content || content === "[DONE]") return;
      const response = responseObject(JSON.parse(content) as unknown);
      if (response.error) throw new Error(errorText(response, "API tool request failed."));
      const choice = responseArray(response.choices)[0];
      const delta = choice?.delta === undefined ? {} : responseObject(choice.delta);
      const piece = responseText(delta.content), thought = responseText(delta.reasoning_content ?? delta.reasoning);
      splitter.push(piece); reply.thinking += thought;
      if (piece) { reply.content = splitter.text; onText?.(reply.content); }
      if (thought) onThinking?.(reply.thinking ?? "");
      if (delta.tool_calls !== undefined) for (const fragment of responseArray(delta.tool_calls)) {
        if (typeof fragment.index !== "number" || !Number.isInteger(fragment.index) || fragment.index < 0 || fragment.index > 11) throw new Error("Invalid tool call index.");
        const call = calls.get(fragment.index) ?? { id: "", name: "", arguments: "" };
        const fn = fragment.function === undefined ? {} : responseObject(fragment.function);
        call.id += responseText(fragment.id); call.name += responseText(fn.name);
        call.arguments = String(call.arguments) + responseText(fn.arguments);
        if (String(call.arguments).length > 200000) throw new Error("Tool arguments are too large.");
        calls.set(fragment.index, call);
      }
    });
    reply.calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    splitter.finish();
    reply.content = splitter.text;
    if (splitter.thinking) reply.thinking = [reply.thinking, splitter.thinking].filter(Boolean).join("\n\n");
    return reply;
  }

  async decide(source: ProfileRecord, candidates: ProfileRecord[], pairs: CandidatePair[],
    rankings: JinaRanking[], signal?: AbortSignal, options?: DecisionOptions): Promise<Decision> {
    if (!this.settings.ollamaModel.trim()) throw new Error("Choose a model for the API.");
    const body = mergeBody({
      model: this.settings.ollamaModel, messages: decisionMessages(this.settings, source, candidates, pairs, rankings, options),
      response_format: { type: "json_schema", json_schema: { name: "decision", strict: true, schema: decisionSchemaFor(candidates) } },
      ...this.limits(),
    }, this.extra().body);
    const response = await requestJson(
      this.http("chat/completions", { ...body, stream: false }, signal));
    return parseDecision(responseText(responseObject(responseArray(response.choices)[0]?.message).content), candidates);
  }

  async chatStream(messages: ChatMessage[], onText: (accumulated: string) => void, signal?: AbortSignal,
    think = false, onThinking?: (accumulated: string) => void): Promise<string> {
    if (!this.settings.ollamaModel.trim()) throw new Error("Choose a model for the API.");
    const body = mergeBody({
      model: this.settings.ollamaModel, messages, stream: true, ...this.limits(),
      ...(think ? { reasoning_effort: "medium" } : {}),
    }, this.extra().body);
    const splitter = new ReasoningSplitter();
    let reasoning = "";
    await requestLines(this.http("chat/completions", body, signal), rawLine => {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") return;
      const parsed = responseObject(JSON.parse(data) as unknown);
      if (parsed.error) throw new Error(errorText(parsed, "API stream error"));
      const choice = responseArray(parsed.choices)[0];
      const delta = choice?.delta === undefined ? {} : responseObject(choice.delta);
      const thought = responseText(delta.reasoning_content ?? delta.reasoning);
      if (thought) { reasoning += thought; onThinking?.(reasoning); }
      const piece = responseText(delta.content);
      if (piece) { splitter.push(piece); onText(splitter.text); }
    });
    return splitter.finish().text;
  }
}

export interface TraceSink { call: (label: string, request: unknown) => { output: (text: string) => void; thinking: (text: string) => void } }

/** Record every request and its streamed output on a trace sink. Without a sink the client is returned unchanged. */
export function traceClient(client: LlmClient, sink: TraceSink | undefined, label: string): LlmClient {
  if (!sink) return client;
  const traced: LlmClient = {
    label: client.label,
    models: signal => client.models(signal),
    running: signal => client.running(signal),
    decide: (source, candidates, pairs, rankings, signal, options) => client.decide(source, candidates, pairs, rankings, signal, options),
    chatStream: (messages, onText, signal, think, onThinking) => {
      const call = sink.call(label, { messages, think });
      return client.chatStream(messages, text => { call.output(text); onText(text); }, signal, think, thought => { call.thinking(thought); onThinking?.(thought); });
    },
  };
  if (client.toolChat) {
    const toolChat = client.toolChat.bind(client);
    traced.toolChat = (messages, tools, signal, think, onText, onThinking) => {
      const call = sink.call(label, { messages, tools, think });
      return toolChat(messages, tools, signal, think, text => { call.output(text); onText?.(text); }, thought => { call.thinking(thought); onThinking?.(thought); })
        .then(reply => { call.output(reply.calls.length ? `${reply.content}\n\nTool calls:\n${JSON.stringify(reply.calls, null, 2)}` : reply.content); return reply; });
    };
  }
  return traced;
}

export function createClient(settings: LlmSettings): LlmClient {
  return settings.aiProvider === "openai" ? new OpenAiClient(settings) : new OllamaClient(settings);
}
