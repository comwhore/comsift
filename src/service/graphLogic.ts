export type LinkMap = Record<string, string[]>;
const LEGACY_START = "<!-- comsift:links:start -->";
const LEGACY_END = "<!-- comsift:links:end -->";
/** The managed callout: its header line plus every following quoted line, and one blank line after it. */
const CALLOUT_BLOCK = /^> \[!comsift-links\][^\n]*(?:\r?\n>[^\n]*)*(?:\r?\n)?(?:[ \t]*\r?\n)?/m;
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

export function hasManagedLinks(content: string): boolean {
  return content.includes(LEGACY_START) || CALLOUT_BLOCK.test(content) || keyPattern(LINKS_PROPERTY).test(content);
}

/** Remove the managed relationships block (current callout or the old comment-wrapped one). */
export function stripManagedLinks(content: string): string {
  let outside = content;
  const start = outside.indexOf(LEGACY_START);
  const end = outside.indexOf(LEGACY_END, start + LEGACY_START.length);
  if (start >= 0 && end >= 0) {
    const before = outside.slice(0, start);
    const after = outside.slice(end + LEGACY_END.length);
    outside = (before.endsWith("\n\n") ? before.slice(0, -2) : before) +
      (after.startsWith("\n") ? after.slice(1) : after);
    if (content.endsWith("\n") && !outside.endsWith("\n")) outside += "\n";
  }
  return outside.replace(CALLOUT_BLOCK, "");
}

/** The managed block exactly as written in `content`, or null. */
export function managedBlock(content: string): string | null {
  const legacy = content.match(/<!-- comsift:links:start -->[\s\S]*?<!-- comsift:links:end -->/)?.[0];
  return legacy ?? content.match(CALLOUT_BLOCK)?.[0]?.replace(/\s+$/, "") ?? null;
}

export const LINKS_PROPERTY = "comsift_links";
export const MANUAL_PROPERTY = "relationships";

function splitFrontmatter(content: string): { block: string | null; body: string } {
  const match = content.match(FRONTMATTER);
  if (!match) return { block: null, body: content };
  return { block: match[0].replace(/^---\r?\n/, "").replace(/\r?\n---(?:\r?\n|$)$/, ""), body: content.slice(match[0].length) };
}

/** A top-level YAML key with its value lines (inline value, indented lines or `- item` lines). */
function keyPattern(key: string): RegExp {
  return new RegExp(`^${key}:[^\\n]*(?:\\r?\\n(?:[ \\t]+[^\\n]*|-[ \\t][^\\n]*))*`, "m");
}

/** Values of a list (or single value) property, unquoted. */
export function readListProperty(content: string, key: string): string[] {
  const { block } = splitFrontmatter(content);
  const found = block?.match(keyPattern(key))?.[0];
  if (!found) return [];
  const inline = found.slice(key.length + 1).split(/\r?\n/)[0].trim();
  const items = inline && inline !== "[]" ? (inline.startsWith("[") ? inline.slice(1, -1).split(",") : [inline])
    : [...found.matchAll(/^[ \t]*-[ \t]+(.*)$/gm)].map(match => match[1]);
  return items.map(item => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

/** Replace (or remove, when `values` is empty) a list property, keeping everything else. */
export function writeListProperty(content: string, key: string, values: string[]): string {
  const { block, body } = splitFrontmatter(content);
  let next = (block ?? "").replace(keyPattern(key), "").replace(/\n{2,}/g, "\n").replace(/^\n|\n$/g, "");
  if (values.length) next = `${next ? `${next}\n` : ""}${key}:\n${values.map(value => `  - ${JSON.stringify(value)}`).join("\n")}`;
  if (!next) return body;
  return `---\n${next}\n---\n${body}`;
}

/** Wiki link targets written in the note itself or in its `relationships` property. */
function manualTargets(content: string): Set<string> {
  const { body } = splitFrontmatter(content);
  const fromBody = [...body.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)].map(match => match[1]);
  const fromProperty = readListProperty(content, MANUAL_PROPERTY).map(value => value.replace(/^\[\[|\]\]$/g, "").split("|")[0].split("#")[0]);
  return new Set([...fromBody, ...fromProperty]);
}

/**
 * Store generated relationships in the `comsift_links` property (indexed by Graph View, out of the way
 * in the editor). Old callout/comment blocks are removed; links already written by hand are skipped.
 */
export function managedLinks(content: string, targets: string[]): string {
  const sorted = [...new Set(targets)].sort();
  const cleaned = stripManagedLinks(content);
  const { block, body } = splitFrontmatter(cleaned);
  const tidy = block === null ? cleaned : `---\n${block}\n---\n${body.replace(/^(?:[ \t]*\r?\n)+/, "")}`;
  const manual = manualTargets(tidy);
  const links = sorted.filter(target => !manual.has(target)).map(target => `[[${target}]]`);
  return writeListProperty(tidy, LINKS_PROPERTY, links);
}

export function hasManagedProperty(content: string): boolean {
  return readListProperty(content, LINKS_PROPERTY).length > 0;
}

interface CanvasFileNode { id: string; type: string; file?: string }

/** Every file placed on a Canvas as a file node. */
export function filesOnCanvas(raw: string): string[] {
  let payload: { nodes?: CanvasFileNode[] };
  try { payload = JSON.parse(raw) as typeof payload; } catch { return []; }
  return [...new Set((Array.isArray(payload.nodes) ? payload.nodes : [])
    .filter(node => node?.type === "file" && typeof node.file === "string")
    .map(node => node.file!))];
}
interface CanvasEdge { fromNode: string; toNode: string }

export function relationshipsFromCanvas(raw: string, exists: (path: string) => boolean): LinkMap {
  let payload: { nodes?: CanvasFileNode[]; edges?: CanvasEdge[] };
  try { payload = JSON.parse(raw) as typeof payload; } catch { return {}; }
  const nodes = new Map((Array.isArray(payload.nodes) ? payload.nodes : [])
    .filter(node => node?.type === "file" && typeof node.file === "string" && node.file.endsWith(".md"))
    .map(node => [node.id, node.file!] as const));
  const result: LinkMap = {};
  for (const edge of Array.isArray(payload.edges) ? payload.edges : []) {
    const from = nodes.get(edge.fromNode);
    const to = nodes.get(edge.toNode);
    if (!from || !to || from === to || !exists(from) || !exists(to)) continue;
    (result[from] ??= []).push(to);
  }
  return result;
}
