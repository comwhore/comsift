// Pure helpers for the person's primary note: the `title` property, legacy title markers and the layout.
import { personNoteLayout } from "./personCardFormat";

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

export interface PrimaryLayoutOptions {
  /** Person name; the Canvas is `<name>.canvas`. */
  name: string;
  /** Add the person card block when missing. */
  card: boolean;
  /** Add the Canvas embed when missing. */
  embedCanvas: boolean;
  /** `***` line right before `## Notes`. */
  divider: boolean;
}

/** Primary note layout: frontmatter, person card, Canvas embed, `***`, `## Notes`, user text. */
export function primaryNoteLayout(content: string, options: PrimaryLayoutOptions): string {
  return personNoteLayout(content, { card: options.card, canvas: `${options.name}.canvas`, addCanvas: options.embedCanvas, divider: options.divider });
}

/** Embed the person's Canvas at the top (under the card when there is one); see `primaryNoteLayout`. */
export function withCanvasEmbed(content: string, canvasName: string, divider = true): string {
  return personNoteLayout(content, { card: false, canvas: canvasName, addCanvas: true, divider });
}
