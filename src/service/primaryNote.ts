// Pure helpers for the person's primary note: the `title` property and legacy title markers.

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const LEGACY_TITLE = /^<!-- (?:comsift|comshit|whereami):title -->[ \t]*\r?\n(?:# ([^\r\n]*)(?:\r?\n|$))?/m;

function yamlString(value: string): string {
  return /^[\w][\w .,'()&-]*$/.test(value) && !/^(true|false|null|yes|no|~)$/i.test(value) ? value : JSON.stringify(value);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try { return String(JSON.parse(trimmed)); } catch { return trimmed.slice(1, -1); }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'");
  return trimmed;
}

export function frontmatterTitle(content: string): string | null {
  const block = content.match(FRONTMATTER)?.[1];
  const line = block?.match(/^title:[ \t]*(.*)$/m)?.[1];
  const title = line === undefined ? "" : unquote(line);
  return title || null;
}

/** Set (or add) the `title` property, creating frontmatter when the note has none. */
export function withTitle(content: string, title: string): string {
  const match = content.match(FRONTMATTER);
  const line = `title: ${yamlString(title)}`;
  if (!match) return `---\n${line}\n---\n${content}`;
  const block = match[1];
  const next = /^title:.*$/m.test(block) ? block.replace(/^title:.*$/m, line) : `${block}\n${line}`;
  return content.replace(FRONTMATTER, `---\n${next}\n---\n`);
}

/**
 * Old notes used `<!-- comsift:title -->` (or comshit/whereami) followed by a managed H1.
 * Move that heading into the `title` property and drop both lines.
 */
export function convertLegacyTitle(content: string): string {
  const match = content.match(LEGACY_TITLE);
  if (!match) return content;
  const heading = match[1]?.trim();
  let next = content.replace(LEGACY_TITLE, "");
  if (heading && !frontmatterTitle(next)) next = withTitle(next, heading);
  return next;
}

const LINKS_CALLOUT = /^> \[!comsift-links\][^\n]*(?:\r?\n>[^\n]*)*(?:\r?\n)?(?:[ \t]*\r?\n)?/;

/**
 * Embed the person's Canvas right after the frontmatter (and an old relationships callout, if any),
 * followed by a `***` divider when `divider` is set. Existing embeds only get the divider added.
 */
export function withCanvasEmbed(content: string, canvasName: string, divider = true): string {
  const escaped = canvasName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const existing = new RegExp(`^!\\[\\[(?:[^\\]|]*/)?${escaped}(?:[|#][^\\]]*)?\\]\\][ \t]*$`, "m");
  const found = content.match(existing);
  if (found && found.index !== undefined) {
    if (!divider) return content;
    const end = found.index + found[0].length;
    const after = content.slice(end);
    if (/^\s*\r?\n\s*(\*\*\*|---|___)\s*(\r?\n|$)/.test(after) || /^\s*(\*\*\*)\s*(\r?\n|$)/.test(after.replace(/^\r?\n/, ""))) return content;
    return `${content.slice(0, end)}\n\n***\n\n${after.replace(/^(?:[ \t]*\r?\n)+/, "")}`;
  }
  const frontmatter = content.match(FRONTMATTER)?.[0] ?? "";
  const rest = content.slice(frontmatter.length);
  const callout = rest.match(LINKS_CALLOUT)?.[0] ?? "";
  const body = rest.slice(callout.length).replace(/^(?:[ \t]*\r?\n)+/, "");
  const head = frontmatter && !frontmatter.endsWith("\n") ? `${frontmatter}\n` : frontmatter;
  const links = callout ? `${callout.replace(/\s+$/, "")}\n\n` : "";
  return `${head}${links}![[${canvasName}]]\n\n${divider ? "***\n\n" : ""}${body}`;
}
