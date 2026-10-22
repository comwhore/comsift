import type { ChatMessage } from "./ollama";

/** A structure summary must retain IDs, directions and relationship types. */
export interface ContextBlock { id: string; title: string; content: string; required?: boolean }
export type ContextDensity = "title" | "full";
export interface ContextPlan { ids: string[]; density: Map<string, ContextDensity> }

export function contextOverflow(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /context.{0,35}(length|window|limit|exceed|large)|maximum.{0,20}tokens|too many tokens|token.{0,20}(limit|exceed)|request.{0,20}too large/i.test(text);
}

/** Selectors choose only known IDs and title/full density; they cannot inject context. */
export function parseContextPlan(answer: string, allowed: Set<string>): ContextPlan {
  const value: unknown = JSON.parse(answer.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, ""));
  if (!value || typeof value !== "object" || !("items" in value) || !Array.isArray(value.items)) throw new Error("Invalid context plan.");
  const ids: string[] = [], density = new Map<string, ContextDensity>();
  for (const entry of value.items as unknown[]) {
    if (!entry || typeof entry !== "object" || !("id" in entry) || typeof entry.id !== "string" || !allowed.has(entry.id) || !("density" in entry) || (entry.density !== "title" && entry.density !== "full")) throw new Error("Unknown context item or density.");
    if (!density.has(entry.id)) ids.push(entry.id);
    density.set(entry.id, entry.density);
  }
  if (!ids.length) throw new Error("Empty context plan.");
  return { ids, density };
}

/** Bound the entire request; never cut a graph summary in the middle of an edge. */
export function adaptiveMessages(system: string, history: ChatMessage[], question: string, blocks: ContextBlock[], contextTokens: number, attempt = 0, plan?: ContextPlan): ChatMessage[] {
  // Two characters/token is deliberately conservative for mixed JSON, Unicode and prose.
  const capacity = Math.max(512, Math.floor(contextTokens * 2 * Math.pow(0.55, attempt)));
  const base = system.length + question.length + 512;
  if (base > capacity) throw new Error("Your prompt and system instructions exceed the context budget. Shorten the prompt or increase context size.");
  let remaining = capacity - base;
  const forced = blocks.filter(block => block.required).map(block => `\n<context id=${JSON.stringify(block.id)} density="full" required="true">\n${block.content}\n</context>`);
  const forcedSize = forced.reduce((total, value) => total + value.length, 0);
  if (forcedSize > remaining) throw new Error("Mentioned files exceed the context budget. Remove a file mention or increase context size; mentioned files are never shortened.");
  remaining -= forcedSize;
  const prior: ChatMessage[] = [];
  let historyUsed = 0;
  for (const turn of [...history].reverse()) {
    if (turn.content.length + 80 > Math.min(remaining, capacity * 0.25 - historyUsed)) break;
    prior.unshift(turn); remaining -= turn.content.length + 80; historyUsed += turn.content.length + 80;
  }
  const byId = new Map(blocks.map(block => [block.id, block]));
  const ordered = plan ? plan.ids.map(id => byId.get(id)).filter((block): block is ContextBlock => !!block) : blocks;
  const summaries: string[] = [...forced];
  for (const block of ordered) {
    if (block.required) continue;
    const title = `\n<context id=${JSON.stringify(block.id)} density="title">\n${block.title}\n</context>`;
    const full = `\n<context id=${JSON.stringify(block.id)} density="full">\n${block.content}\n</context>`;
    const value = plan?.density.get(block.id) !== "title" && attempt === 0 && full.length <= remaining ? full : title;
    if (value.length > remaining) continue;
    summaries.push(value); remaining -= value.length;
  }
  return [{ role: "system", content: system }, ...prior, { role: "user", content: `${summaries.join("\n")}\nContext coverage: ${summaries.length}/${blocks.length} sources included. Omitted sources have unknown contents.\n\nRequest: ${question}${attempt ? "\nContext was reduced after a context overflow. State any missing evidence; do not invent omitted contents." : ""}` }];
}
