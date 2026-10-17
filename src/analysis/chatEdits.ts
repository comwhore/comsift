import { hasManagedLinks, managedBlock, stripManagedLinks } from "../service/graphLogic";
import { parseCanvasEdits } from "../service/canvasModel";

// Pure helpers for the chat: hide plugin metadata from the model, parse proposed edits, build diffs.

export interface ProposedEdit {
  action: "create" | "replace" | "patch";
  path: string;
  /** create/replace: full content. patch: replacement text. */
  content: string;
  /** patch only: exact text to find in the file. */
  find?: string;
}

const TITLE_MARKER = /<!-- (?:comsift|comshit|whereami):[a-z:]+ -->\r?\n?/g;
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/** Strip frontmatter, plugin markers and the managed Graph links block before sending to a model. */
export function sanitizeForModel(path: string, text: string): string {
  if (!path.toLowerCase().endsWith(".md")) return text;
  return stripManagedLinks(text.replace(FRONTMATTER, "")).replace(TITLE_MARKER, "").trim();
}

/** Re-attach frontmatter / markers / managed block the model never saw, when a full replace dropped them. */
export function restoreMetadata(path: string, original: string, replacement: string): string {
  if (!path.toLowerCase().endsWith(".md")) return replacement;
  let result = replacement;
  const frontmatter = original.match(FRONTMATTER)?.[0];
  if (frontmatter && !FRONTMATTER.test(result)) result = frontmatter.replace(/\s*$/, "\n") + result;
  const links = managedBlock(original);
  if (links && !hasManagedLinks(result)) {
    const head = result.match(FRONTMATTER)?.[0] ?? "";
    result = `${head}${links}\n\n${result.slice(head.length).replace(/^\s+/, "")}`;
  }
  return result;
}

const TAG = /<(edit|patch)\s+([^>]*?)>([\s\S]*?)<\/\1>/gi;

function attr(source: string, name: string): string | undefined {
  return source.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"))?.[1]
    ?? source.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, "i"))?.[1];
}

function stripFence(value: string): string {
  const fenced = value.match(/^\s*```[^\n]*\n([\s\S]*?)\n```\s*$/);
  return (fenced ? fenced[1] : value).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

/**
 * Parse `<edit action="create|replace" path="…">content</edit>` and
 * `<patch path="…"><find>old</find><replace>new</replace></patch>` out of a model answer.
 * Returns the prose with the tags removed.
 */
export function parseEdits(answer: string): { text: string; edits: ProposedEdit[] } {
  const edits: ProposedEdit[] = [];
  const text = answer.replace(TAG, (_all, kind: string, attrs: string, body: string) => {
    const path = attr(attrs, "path");
    if (!path) return "";
    if (kind.toLowerCase() === "edit") {
      const action = attr(attrs, "action")?.toLowerCase() === "create" ? "create" : "replace";
      edits.push({ action, path, content: stripLineNumbers(stripFence(body)) });
    } else {
      const find = body.match(/<find>([\s\S]*?)<\/find>/i)?.[1];
      const replace = body.match(/<replace>([\s\S]*?)<\/replace>/i)?.[1];
      if (find !== undefined && replace !== undefined) {
        edits.push({ action: "patch", path, find: stripLineNumbers(stripFence(find)), content: stripLineNumbers(stripFence(replace)) });
      }
    }
    return "";
  });
  return { text: text.replace(/\n{3,}/g, "\n\n").trim(), edits };
}

/** Hide not-yet-closed edit tags while a response is still streaming. */
export function visibleWhileStreaming(partial: string): { text: string; pendingEdit: boolean } {
  const { text } = parseEdits(parseCanvasEdits(partial).text);
  const open = text.search(/<(edit|patch|canvas)\b/i);
  if (open === -1) return { text, pendingEdit: false };
  return { text: text.slice(0, open).trim(), pendingEdit: true };
}

export type DiffLine = { kind: "same" | "add" | "del"; text: string };

/** Line diff (LCS). Inputs beyond ~4000 lines fall back to a whole-file replace to stay cheap. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 16_000_000) {
    return [...a.map(text => ({ kind: "del" as const, text })), ...b.map(text => ({ kind: "add" as const, text }))];
  }
  const table: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ kind: "same", text: a[i] }); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) out.push({ kind: "del", text: a[i++] });
    else out.push({ kind: "add", text: b[j++] });
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++] });
  while (j < b.length) out.push({ kind: "add", text: b[j++] });
  return out;
}

/** Compute the file text an edit would produce, or throw a user-readable error. */
export function applyToText(edit: ProposedEdit, path: string, original: string | null): string {
  if (edit.action === "create") return edit.content;
  if (original === null) throw new Error("The file to change does not exist.");
  if (edit.action === "replace") return restoreMetadata(path, original, edit.content);
  const find = edit.find ?? "";
  if (!find) throw new Error("Patch has an empty search text.");
  const first = original.indexOf(find);
  if (first === -1) throw new Error("Patch text was not found in the file (it may have changed).");
  if (original.indexOf(find, first + 1) !== -1) throw new Error("Patch text matches more than once; ask for a more specific patch.");
  return original.slice(0, first) + edit.content + original.slice(first + find.length);
}

const NUMBERED_EXTENSIONS = ["md", "txt", "csv"];
const MARKER_LINE = /^<!-- (?:comsift|comshit|whereami):[a-z:]+ -->\s*$/;

/**
 * Like sanitizeForModel, but prefixes every kept line with `L<n>: ` where n is the
 * line number in the real file, so the assistant can link to `[[path#L12]]`.
 */
export function numberedForModel(path: string, text: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  if (!NUMBERED_EXTENSIONS.includes(extension)) return sanitizeForModel(path, text);
  const lines = text.split(/\r?\n/);
  const skip = new Set<number>();
  if (extension === "md") {
    if (lines[0]?.trim() === "---") {
      const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
      if (end > 0) for (let index = 0; index <= end; index++) skip.add(index);
    }
    let inLinks = false;
    let inCallout = false;
    lines.forEach((line, index) => {
      if (line.includes("<!-- comsift:links:start -->")) inLinks = true;
      if (line.startsWith("> [!comsift-links]")) inCallout = true;
      else if (inCallout && !line.startsWith(">")) inCallout = false;
      if (inLinks || inCallout || MARKER_LINE.test(line)) skip.add(index);
      if (line.includes("<!-- comsift:links:end -->")) inLinks = false;
    });
  }
  const kept = lines.map((line, index) => skip.has(index) ? null : `L${index + 1}: ${line}`)
    .filter((line): line is string => line !== null);
  while (kept.length && /^L\d+: \s*$/.test(kept[kept.length - 1])) kept.pop();
  return kept.join("\n");
}

/** Remove `L12: ` prefixes a model copied from numbered context into an edit. */
export function stripLineNumbers(value: string): string {
  const lines = value.split("\n");
  const numbered = lines.filter(line => line.trim()).every(line => /^L\d+: ?/.test(line));
  return numbered && lines.some(line => line.trim()) ? lines.map(line => line.replace(/^L\d+: ?/, "")).join("\n") : value;
}

export interface LineTarget { path: string; from: number; to: number }

/** `note#L12` or `note#L12-L20` / `note#L12-20` → link path and 1-based line range. */
export function parseLineLink(href: string): LineTarget | null {
  const match = href.match(/^(.*?)#L(\d+)(?:-L?(\d+))?$/i);
  if (!match) return null;
  const from = Number(match[2]);
  const to = match[3] ? Math.max(from, Number(match[3])) : from;
  return from > 0 ? { path: match[1], from, to } : null;
}
