// Pure helpers for the person card: the fenced block that marks where the card renders, and
// migration of older note bodies (the `<!-- comsift:profile:start -->` block) to that layout.

/** Code block language rendered as a person card in reading view and Live Preview. */
export const PERSON_CARD_LANGUAGE = "comsift-person";
/** The managed part of a person or profile note. Everything the card shows comes from frontmatter. */
export const PERSON_CARD_BLOCK = "```comsift-person\n```";

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const CARD = /^```comsift-person[^\r\n]*\r?\n[\s\S]*?^```[ \t]*(?:\r?\n|$)/m;
const OLD_START = "<!-- comsift:profile:start -->";
const OLD_END = "<!-- comsift:profile:end -->";
/** Profiles written before the start/end markers: a heading, a Sources list and `- field: value` rows. */
const LEGACY_GENERATED = /^# [^\n]+\n\nSources:\n(?:- \[\[[^\n]+\n)+\n(?:- [\w :]+: [^\n]*\n)*/m;
const NOTES_HEADING = /^##[ \t]+Notes[ \t]*\r?$/m;
const ANY_HEADING = /^#{1,6}[ \t]/m;

export interface PersonCardOptions {
  /** A person's primary note: card, Canvas embed, `***`, then `## Notes` (see `personNoteLayout`). */
  primary?: boolean;
  /** Primary notes: put a `***` line before `## Notes` (default true). */
  divider?: boolean;
}

export interface PersonNoteLayout {
  /** Add the card block when missing. An existing card block is always kept (and moved to the top). */
  card: boolean;
  /** File name of the person's Canvas (`Name.canvas`); an existing embed of it is moved under the card. */
  canvas?: string;
  /** Add the Canvas embed when missing (needs `canvas`). */
  addCanvas?: boolean;
  /** A `***` line between the card/Canvas and `## Notes`. */
  divider: boolean;
}

/** True when the note already has a card block and no old generated block. */
export function hasPersonCard(content: string): boolean {
  return CARD.test(content) && !content.includes(OLD_START);
}

/** Canvas embed, its divider and an old relationships callout stay above the card. */
function splitLead(body: string): [string, string] {
  let rest = body, lead = "";
  const take = (pattern: RegExp): boolean => {
    const match = rest.match(pattern);
    if (!match) return false;
    lead += match[0]; rest = rest.slice(match[0].length);
    return true;
  };
  take(/^(?:[ \t]*\r?\n)*> \[!comsift-links\][^\n]*(?:\r?\n>[^\n]*)*/);
  if (take(/^(?:[ \t]*\r?\n)*!\[\[[^\]\n]+\.canvas(?:[|#][^\]\n]*)?\]\][ \t]*/)) take(/^(?:[ \t]*\r?\n)+(?:\*\*\*|---|___)[ \t]*(?=\r?\n|$)/);
  return [lead.replace(/^(?:[ \t]*\r?\n)+/, ""), rest];
}

/** Remove every old generated block; the text around each one is kept, joined by a blank line. */
function withoutOldBlocks(text: string): { text: string; found: boolean } {
  let rest = text, found = false;
  for (;;) {
    const start = rest.indexOf(OLD_START);
    if (start < 0) break;
    const end = rest.indexOf(OLD_END, start);
    if (end < 0) break;
    found = true;
    const before = rest.slice(0, start).trimEnd(), after = rest.slice(end + OLD_END.length).trimStart();
    rest = before && after ? `${before}\n\n${after}` : before || after;
  }
  return { text: rest, found };
}

/**
 * The user's own text in a note: everything except frontmatter, the canvas embed lead, the card block,
 * old generated blocks and the `## Notes` heading itself.
 */
export function personNotes(content: string): string {
  const body = content.replace(FRONTMATTER, "");
  const [, rest] = splitLead(body);
  const { text, found } = withoutOldBlocks(rest);
  const cleaned = (found ? text : text.replace(LEGACY_GENERATED, "")).replace(CARD, "");
  return cleaned.replace(NOTES_HEADING, "").trim();
}

/**
 * Put the card block into a note. The old generated block is replaced; text that was before or after it
 * moves under `## Notes`. Notes that already have a card block are returned unchanged, so this is idempotent.
 */
export function withPersonCard(content: string, options: PersonCardOptions = {}): string {
  if (hasPersonCard(content)) return content;
  if (options.primary) return personNoteLayout(content, { card: true, divider: options.divider !== false });
  const front = content.match(FRONTMATTER)?.[0] ?? "";
  const body = content.slice(front.length);
  const [lead, rest] = splitLead(body);
  const { text, found } = withoutOldBlocks(rest);
  const notes = (found ? text : text.replace(LEGACY_GENERATED, "")).replace(CARD, "").trim();
  const heading = NOTES_HEADING.test(notes) || (options.primary && ANY_HEADING.test(notes)) ? "" : "## Notes\n\n";
  const head = front && !front.endsWith("\n") ? `${front}\n` : front;
  const top = lead ? `${lead.trimEnd()}\n\n` : front ? "\n" : "";
  return `${head}${top}${PERSON_CARD_BLOCK}\n\n${heading}${notes}`.trimEnd() + "\n";
}

const DIVIDER_LINE = /^(?:\*\*\*+|___+|---+|\* \* \*)[ \t]*$/;
const CALLOUT = /^> \[!comsift-links\][^\n]*(?:\r?\n>[^\n]*)*/;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Drop blank lines and `***`/`---`/`___` lines from the start (or end) of `text`. */
function trimDividers(text: string, end = false): string {
  const lines = text.split(/\r?\n/);
  const empty = (line: string) => !line.trim() || DIVIDER_LINE.test(line.trim());
  if (end) while (lines.length && empty(lines[lines.length - 1])) lines.pop();
  else while (lines.length && empty(lines[0])) lines.shift();
  return lines.join("\n");
}

/**
 * Remove every match of `pattern` (whole lines) from `text`, together with a divider line right after it
 * (only blank lines in between): the divider that used to sit under the Canvas embed. Returns the removed parts.
 */
function extract(text: string, pattern: RegExp): { text: string; found: string[] } {
  const found: string[] = [];
  const rest = text.replace(pattern, match => { found.push(match.replace(/\s+$/, "")); return "\uE000"; })
    .replace(/\uE000(?:[ \t]*\r?\n)*[ \t]*(?:\*\*\*+|___+|---+)[ \t]*(?=\r?\n|$)/g, "\uE000")
    .replace(/(?:[ \t]*\r?\n)*\uE000(?:[ \t]*\r?\n)*/g, "\n\n");
  return { text: rest, found };
}

/**
 * Layout of a person's primary note (`Person/Person.md`):
 *
 * frontmatter → card block → `![[Person.canvas]]` → `***` → `## Notes` → the user's text.
 *
 * The card and the Canvas embed are taken from wherever they are and put at the top; dividers that sat
 * around them are dropped, so there is exactly one `***`, right before `## Notes`. An old relationships
 * callout stays in the top part. Dividers inside the user's own text are kept. Idempotent; a note with
 * nothing to put on top (card off, no Canvas) is returned unchanged.
 */
export function personNoteLayout(content: string, options: PersonNoteLayout): string {
  const front = content.match(FRONTMATTER)?.[0] ?? "";
  let body = content.slice(front.length);
  const cards = extract(body, new RegExp(CARD.source, "gm"));
  body = cards.text;
  let embed = "";
  const canvasLine = options.canvas
    ? new RegExp(`^!\\[\\[(?:[^\\]|#\\n]*/)?${escapeRegExp(options.canvas)}(?:\\|[^\\]\\n]*)?\\]\\][ \t]*(?:\\r?\\n|$)`, "m")
    : null;
  // Only the whole-board embed (optionally `|size`) is the person's; `Name.canvas#node` embeds are the user's.
  if (canvasLine) {
    const embeds = extract(body, canvasLine);
    body = embeds.text;
    embed = embeds.found[0] ?? "";
  } else {
    // Unknown Canvas name: only an embed at the top of the note (before the user's text) is the person's.
    const top = trimDividers(body).match(/^(?:> \[!comsift-links\][^\n]*(?:\r?\n>[^\n]*)*(?:[ \t]*\r?\n)+)?(!\[\[[^\]#|\n]+\.canvas(?:\|[^\]\n]*)?\]\])[ \t]*(?:\r?\n|$)/);
    if (top) { const embeds = extract(body, new RegExp(`^${escapeRegExp(top[1])}[ \t]*(?:\\r?\\n|$)`, "m")); body = embeds.text; embed = embeds.found[0] ?? ""; }
  }
  if (!embed && options.addCanvas && options.canvas) embed = `![[${options.canvas}]]`;
  const card = cards.found.length || options.card ? PERSON_CARD_BLOCK : "";
  if (!card && !embed) return content;
  body = trimDividers(body);
  const callout = body.match(CALLOUT)?.[0] ?? "";
  if (callout) body = trimDividers(body.slice(callout.length));
  if (card) {
    const { text, found } = withoutOldBlocks(body);
    body = trimDividers(found ? text : text.replace(LEGACY_GENERATED, ""));
  }
  body = trimDividers(body, true);
  // `## Notes` starts the user's part. A heading further down moves up; the text above it stays above it.
  if (NOTES_HEADING.test(body)) {
    body = trimDividers(body.replace(NOTES_HEADING, "\uE000")
      .replace(/(?:[ \t]*\r?\n)*(?:(?:\*\*\*+|___+)[ \t]*\r?\n(?:[ \t]*\r?\n)*)?\uE000(?:[ \t]*\r?\n)*/, "\n\n"));
  }
  const head = front && !front.endsWith("\n") ? `${front}\n` : front;
  const top = [card, embed, callout.trimEnd()].filter(Boolean).join("\n\n");
  const notes = body ? `## Notes\n\n${body}` : "## Notes";
  return `${head}${front ? "\n" : ""}${top}\n\n${options.divider ? "***\n\n" : ""}${notes}\n`;
}
