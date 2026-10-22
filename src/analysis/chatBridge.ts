import type ComsiftPlugin from "../main";
import { stripExecutableProposals } from "./chatLog";
import type { ChatMessage } from "./ollama";
const ANALYSIS_VIEW_TYPE = "comsift-analysis";
import { openCanvasAssistant } from "./canvasAssistant";

export type ConversationKind = "chat" | "canvas";
export interface ConversationSnapshot { messages: ChatMessage[]; path: string }
const conversations = new WeakMap<ComsiftPlugin, Partial<Record<ConversationKind, ConversationSnapshot>>>();
export function publishConversation(plugin: ComsiftPlugin, kind: ConversationKind, messages: ChatMessage[], path: string) {
  const entries = conversations.get(plugin) ?? {};
  entries[kind] = { messages: messages.map(turn => ({ ...turn, content: turn.role === "assistant" ? stripExecutableProposals(turn.content) : turn.content })), path };
  conversations.set(plugin, entries);
}
export function latestConversation(plugin: ComsiftPlugin, kind: ConversationKind): ConversationSnapshot | undefined {
  const value = conversations.get(plugin)?.[kind];
  return value && { path: value.path, messages: value.messages.map(turn => ({ ...turn, content: turn.role === "assistant" ? stripExecutableProposals(turn.content) : turn.content })) };
}
export function conversationMention(snapshot: ConversationSnapshot): string {
  return `Conversation from ${snapshot.path}:\n\n${snapshot.messages.map(turn => `${turn.role}: ${turn.content}`).join("\n\n")}`;
}
export async function openNormalConversation(plugin: ComsiftPlugin, messages: ChatMessage[], prompt = "", folder = "") {
  const workspace = plugin.app.workspace;
  const leaf = workspace.getLeavesOfType(ANALYSIS_VIEW_TYPE)[0] ?? workspace.getLeaf("tab");
  await leaf.setViewState({ type: ANALYSIS_VIEW_TYPE, active: true });
  const view = leaf.view as unknown as { importConversation?: (messages: ChatMessage[], prompt: string, folder: string) => void };
  if (!view.importConversation) throw new Error("Chat is still loading. Try again.");
  view.importConversation(messages.map(turn => ({ ...turn, content: turn.role === "assistant" ? stripExecutableProposals(turn.content) : turn.content })), prompt, folder);
  await workspace.revealLeaf(leaf);
}
/** Focus the tab that already shows this board; open a new tab only when there is none. */
export async function openCanvasBoard(plugin: ComsiftPlugin, path: string) {
  const file = plugin.app.vault.getFileByPath(path);
  if (!file || file.extension !== "canvas") throw new Error("Choose an existing Canvas board.");
  const workspace = plugin.app.workspace;
  const open = workspace.getLeavesOfType("canvas").find(entry => (entry.view as unknown as { file?: { path: string } }).file?.path === path);
  const leaf = open ?? workspace.getLeaf("tab");
  if (!open) await leaf.openFile(file);
  else workspace.setActiveLeaf(leaf, { focus: true });
  const view = leaf.view as unknown as { canvas?: M.Canvas };
  if (!view.canvas) throw new Error("Canvas is still loading. Try again.");
  return view.canvas;
}
export async function openCanvasConversation(plugin: ComsiftPlugin, path: string, messages: ChatMessage[], prompt = "") {
  const canvas = await openCanvasBoard(plugin, path);
  await openCanvasAssistant(plugin, path, canvas, { messages: messages.map(turn => ({ ...turn, content: turn.role === "assistant" ? stripExecutableProposals(turn.content) : turn.content })), prompt });
}
