import { parseEdits } from "./chatEdits";
import { parseCanvasEdits } from "../service/canvasModel";

// Pure helpers: chat transcript <-> readable Markdown note.

export interface ChatTurn { role: "user" | "assistant"; content: string }
export interface ChatLog { folder: string; model: string; created: string; messages: ChatTurn[] }

const MARK = /^<!-- comsift:msg (user|assistant) -->\s*$/;

/** Conversation transfers carry readable text, never executable review cards. */
export function stripExecutableProposals(text: string): string {
  const withoutHandoffs = text.replace(/<canvas-handoff\b[^>]*>[\s\S]*?(?:<\/canvas-handoff>|$)/gi, "");
  return parseEdits(parseCanvasEdits(withoutHandoffs).text).text;
}

export function chatTitle(messages: ChatTurn[]): string {
  const first = messages.find(turn => turn.role === "user")?.content ?? "Chat";
  const title = first.replace(/\s+/g, " ").replace(/[\\/:*?"<>|#^[\]]/g, "").trim().slice(0, 50).trim();
  return title || "Chat";
}

export function serializeChat(log: ChatLog): string {
  const head = ["---", "comsift_chat: true", `folder: "${log.folder.replace(/"/g, '\\"')}"`,
    `model: "${log.model.replace(/"/g, '\\"')}"`, `created: ${log.created}`, "---", "", `# ${chatTitle(log.messages)}`, ""];
  const body = log.messages.map(turn =>
    `<!-- comsift:msg ${turn.role} -->\n### ${turn.role === "user" ? "You" : "Assistant"}\n\n${(turn.role === "assistant" ? stripExecutableProposals(turn.content) || "Proposed changes (review cards are not saved)." : turn.content).trim()}\n`);
  return head.join("\n") + body.join("\n");
}

export function parseChat(text: string): ChatLog | null {
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!front || !/^comsift_chat:\s*true/m.test(front[1])) return null;
  const read = (key: string) => front[1].match(new RegExp(`^${key}:\\s*"?(.*?)"?\\s*$`, "m"))?.[1]?.replace(/\\"/g, '"') ?? "";
  const messages: ChatTurn[] = [];
  let current: { role: "user" | "assistant"; lines: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const lines = current.lines;
    if (/^### (You|Assistant)\s*$/.test(lines[0] ?? "")) lines.shift();
    const content = lines.join("\n").trim();
    if (content) messages.push({ role: current.role, content: current.role === "assistant" ? stripExecutableProposals(content) || "Proposed changes (review cards are not saved)." : content });
  };
  for (const line of text.slice(front[0].length).split(/\r?\n/)) {
    const mark = line.match(MARK);
    if (mark) { flush(); current = { role: mark[1] as "user" | "assistant", lines: [] }; }
    else current?.lines.push(line);
  }
  flush();
  return { folder: read("folder"), model: read("model"), created: read("created"), messages };
}
