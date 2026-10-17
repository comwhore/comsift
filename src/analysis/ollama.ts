import { request as httpRequest, type IncomingMessage } from "http";
import { request as httpsRequest } from "https";
import type { ComsiftSettings } from "../module";
import { DEFAULT_DECISION_PROMPT, fillPrompt } from "./prompts";
import type { ProfileRecord, CandidatePair, JinaRanking } from "./runner";

export interface Decision {
  candidate_id: string;
  explanation: string;
  supporting_evidence: string[];
  conflicting_evidence: string[];
  uncertain: boolean;
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** Settings the clients read; a subset so tests can pass plain objects. */
export type LlmSettings = Pick<ComsiftSettings, "ollamaUrl" | "ollamaModel" | "ollamaContext" | "ollamaTimeout"> &
  Partial<Pick<ComsiftSettings, "ollamaDevice" | "ollamaMaxTokens" | "ollamaKeepAlive" | "decisionPrompt" |
    "aiProvider" | "apiBaseUrl" | "apiKey" | "apiExtraParams">>;

export interface LlmClient {
  readonly label: string;
  models(signal?: AbortSignal): Promise<string[]>;
  running(signal?: AbortSignal): Promise<Array<{ name: string; size: number; vram: number }>>;
  decide(source: ProfileRecord, candidates: ProfileRecord[], pairs: CandidatePair[],
    rankings: JinaRanking[], signal?: AbortSignal): Promise<Decision>;
  chatStream(messages: ChatMessage[], onText: (accumulated: string) => void, signal?: AbortSignal,
    think?: boolean, onThinking?: (accumulated: string) => void): Promise<string>;
}

const decisionSchema = {
  type: "object", required: ["candidate_id", "explanation", "supporting_evidence", "conflicting_evidence", "uncertain"],
  additionalProperties: false,
  properties: {
    candidate_id: { type: "string" }, explanation: { type: "string" },
    supporting_evidence: { type: "array", items: { type: "string" } },
    conflicting_evidence: { type: "array", items: { type: "string" } },
    uncertain: { type: "boolean" },
  },
};

export function validateDecision(value: unknown, ids: string[]): Decision {
  if (!value || typeof value !== "object") throw new Error("The model returned no structured decision.");
  const data = value as Partial<Decision>;
  if (typeof data.candidate_id !== "string" || ![...ids, "NO_MATCH"].includes(data.candidate_id)) {
    throw new Error("The model selected an unknown candidate.");
  }
  if (typeof data.explanation !== "string" || typeof data.uncertain !== "boolean" ||
      !Array.isArray(data.supporting_evidence) || !data.supporting_evidence.every(item => typeof item === "string") ||
      !Array.isArray(data.conflicting_evidence) || !data.conflicting_evidence.every(item => typeof item === "string")) {
    throw new Error("The model decision did not match the required schema.");
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

function errorText(parsed: unknown, fallback: string): string {
  if (!isPlainObject(parsed)) return fallback;
  const error = parsed.error;
  if (typeof error === "string") return error;
  if (isPlainObject(error) && typeof error.message === "string") return error.message;
  return fallback;
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
    else reject(new Error(`${service} unavailable at ${url.origin}: ${error.message}`));
  });
  request.end(serialized);
  return request;
}

function requestJson<T>(options: HttpOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request = openRequest(options, response => {
      let content = "";
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
          if (status >= 400) throw new Error(errorText(parsed, `HTTP ${status}`));
          resolve(parsed as T);
        } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
      });
    }, reject);
  });
}

/** POST and feed each complete response line to `consume`; resolves when the stream ends. */
function requestLines(options: HttpOptions, consume: (line: string) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    openRequest(options, response => {
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
        try { lines.forEach(consume); } catch (error) { response.destroy(error instanceof Error ? error : new Error(String(error))); }
      });
      response.on("error", error => reject(error));
      response.on("end", () => {
        if (status >= 400) {
          let message = `HTTP ${status}`;
          try { message = errorText(JSON.parse(errorBody) as unknown, message); } catch { /* keep status */ }
          reject(new Error(message));
          return;
        }
        try { consume(buffer); resolve(); } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
      });
    }, reject);
  });
}

function decisionMessages(settings: LlmSettings, source: ProfileRecord, candidates: ProfileRecord[],
  pairs: CandidatePair[], rankings: JinaRanking[]): ChatMessage[] {
  const options = candidates.map(candidate => ({
    id: candidate.id, profile: candidate.fields,
    splink: pairs.find(pair => pair.left_id === source.id && pair.right_id === candidate.id),
    jina: rankings.find(rank => rank.source_id === source.id && rank.id === candidate.id),
  }));
  return [
    { role: "system", content: fillPrompt(settings.decisionPrompt ?? "", DEFAULT_DECISION_PROMPT, {}) },
    { role: "user", content: JSON.stringify({ source: { id: source.id, profile: source.fields }, candidates: options,
      no_match: { id: "NO_MATCH", meaning: "No candidate is sufficiently supported" } }) },
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
    const response = await requestJson<{ models?: Array<{ name: string }> }>(this.http("/api/tags", undefined, signal));
    return (response.models ?? []).map(model => model.name).filter(Boolean);
  }

  /** Models currently loaded in Ollama with how much of each sits in GPU memory. */
  async running(signal?: AbortSignal): Promise<Array<{ name: string; size: number; vram: number }>> {
    const response = await requestJson<{ models?: Array<{ name: string; size: number; size_vram?: number }> }>(
      this.http("/api/ps", undefined, signal));
    return (response.models ?? []).map(model => ({ name: model.name, size: model.size, vram: model.size_vram ?? 0 }));
  }

  async decide(source: ProfileRecord, candidates: ProfileRecord[], pairs: CandidatePair[],
    rankings: JinaRanking[], signal?: AbortSignal): Promise<Decision> {
    if (!this.settings.ollamaModel.trim()) throw new Error("Select an installed Ollama model.");
    const body = mergeBody({
      model: this.settings.ollamaModel, messages: decisionMessages(this.settings, source, candidates, pairs, rankings),
      format: decisionSchema, stream: false, think: false, options: this.options(), keep_alive: this.keepAlive(),
    }, this.extra().body);
    const response = await requestJson<{ message?: { content?: string } }>(this.http("/api/chat", { ...body, stream: false }, signal));
    return validateDecision(parseJsonContent(response.message?.content), candidates.map(candidate => candidate.id));
  }

  /** Streams a plain-text/markdown chat reply; `onText` receives the accumulated text. */
  async chatStream(messages: ChatMessage[], onText: (accumulated: string) => void, signal?: AbortSignal,
    think = false, onThinking?: (accumulated: string) => void): Promise<string> {
    if (!this.settings.ollamaModel.trim()) throw new Error("Select an installed Ollama model.");
    const body = mergeBody({
      model: this.settings.ollamaModel, messages, stream: true, keep_alive: this.keepAlive(), think, options: this.options(),
    }, this.extra().body);
    let accumulated = "";
    let reasoning = "";
    let failure: string | null = null;
    await requestLines(this.http("/api/chat", body, signal), line => {
      if (!line.trim()) return;
      let parsed: { message?: { content?: string; thinking?: string }; error?: string };
      try { parsed = JSON.parse(line) as typeof parsed; } catch { return; }
      if (parsed.error) failure = parsed.error;
      const thought = parsed.message?.thinking;
      if (thought) { reasoning += thought; onThinking?.(reasoning); }
      const piece = parsed.message?.content;
      if (piece) { accumulated += piece; onText(accumulated); }
    });
    if (failure !== null) throw new Error(failure);
    return accumulated;
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
    const response = await requestJson<{ data?: Array<{ id?: string }> }>(this.http("models", undefined, signal));
    return (response.data ?? []).map(model => model.id ?? "").filter(Boolean).sort();
  }

  running(): Promise<Array<{ name: string; size: number; vram: number }>> { return Promise.resolve([]); }

  async decide(source: ProfileRecord, candidates: ProfileRecord[], pairs: CandidatePair[],
    rankings: JinaRanking[], signal?: AbortSignal): Promise<Decision> {
    if (!this.settings.ollamaModel.trim()) throw new Error("Choose a model for the API.");
    const body = mergeBody({
      model: this.settings.ollamaModel, messages: decisionMessages(this.settings, source, candidates, pairs, rankings),
      response_format: { type: "json_schema", json_schema: { name: "decision", strict: true, schema: decisionSchema } },
      ...this.limits(),
    }, this.extra().body);
    const response = await requestJson<{ choices?: Array<{ message?: { content?: string | null } }> }>(
      this.http("chat/completions", { ...body, stream: false }, signal));
    return validateDecision(parseJsonContent(response.choices?.[0]?.message?.content), candidates.map(candidate => candidate.id));
  }

  async chatStream(messages: ChatMessage[], onText: (accumulated: string) => void, signal?: AbortSignal,
    think = false, onThinking?: (accumulated: string) => void): Promise<string> {
    if (!this.settings.ollamaModel.trim()) throw new Error("Choose a model for the API.");
    const body = mergeBody({
      model: this.settings.ollamaModel, messages, stream: true, ...this.limits(),
      ...(think ? { reasoning_effort: "medium" } : {}),
    }, this.extra().body);
    let accumulated = "";
    let reasoning = "";
    await requestLines(this.http("chat/completions", body, signal), rawLine => {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") return;
      let parsed: { choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null } }>; error?: unknown };
      try { parsed = JSON.parse(data) as typeof parsed; } catch { return; }
      if (parsed.error) throw new Error(errorText(parsed, "API stream error"));
      const delta = parsed.choices?.[0]?.delta;
      const thought = delta?.reasoning_content ?? delta?.reasoning;
      if (thought) { reasoning += thought; onThinking?.(reasoning); }
      if (delta?.content) { accumulated += delta.content; onText(accumulated); }
    });
    return accumulated;
  }
}

export function createClient(settings: LlmSettings): LlmClient {
  return settings.aiProvider === "openai" ? new OpenAiClient(settings) : new OllamaClient(settings);
}
