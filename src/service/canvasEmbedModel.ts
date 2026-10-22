import type { CanvasData } from "./canvasModel";
export interface CanvasEmbedSpec { path: string; nodes: string[]; edges?: string[] }
export function parseEmbedSpec(raw: string): CanvasEmbedSpec {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("Expected a Canvas selection object.");
  const entry = value as Record<string, unknown>;
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
  if (typeof entry.path !== "string" || !entry.path.endsWith(".canvas") || !entry.path || entry.path.split(/[\\/]/).some(part => part === "..") || entry.path.startsWith("/") || !strings(entry.nodes) || (entry.edges !== undefined && !strings(entry.edges))) throw new Error("Invalid Canvas path or selection IDs.");
  return { path: entry.path, nodes: entry.nodes, ...(entry.edges !== undefined ? { edges: entry.edges } : {}) };
}
export function embedSelection(data: CanvasData, spec: CanvasEmbedSpec): CanvasData {
  const ids = new Set(spec.nodes), edgeIds = spec.edges === undefined ? undefined : new Set(spec.edges);
  const edges = data.edges.filter(edge => edgeIds ? edgeIds.has(edge.id) : ids.has(edge.fromNode) && ids.has(edge.toNode));
  for (const edge of edges) { ids.add(edge.fromNode); ids.add(edge.toNode); }
  return { nodes: data.nodes.filter(node => ids.has(node.id)), edges };
}
/** Native Better Embedded Canvas syntax; each selected card/group keeps its stable ID. */
export function embedMarkdown(spec: CanvasEmbedSpec): string {
  parseEmbedSpec(JSON.stringify(spec));
  if (/[\][|#\r\n]/.test(spec.path) || spec.nodes.some(id => /[\][|#\r\n]/.test(id))) throw new Error("Canvas path or IDs cannot be represented as an embed wikilink.");
  if (spec.edges?.length) throw new Error("Embed a group containing the arrow endpoints; Better Embedded Canvas does not support arrow IDs.");
  const links = spec.nodes.length ? [...new Set(spec.nodes)].map(id => `![[${spec.path}#${id}]]`) : [`![[${spec.path}]]`];
  return `\n\n${links.join("\n\n")}\n`;
}
