// Relationship marks stored in a note's own frontmatter: one list property per type, each entry a wiki link.
import type { ArrowType } from "./canvasModel";

export type MarkType = Exclude<ArrowType, "normal"> | "none";
export type SetMarkType = Exclude<MarkType, "none">;

/** Frontmatter list properties holding marks (`[[Person/Person]]` links), one per type. */
export const MARK_PROPERTIES: Record<SetMarkType, string> = { same: "comsift_same", related: "comsift_related", uncertain: "comsift_uncertain" };

/** `[[path|alias]]` → `path` (also `path#heading`); null when the value is not a wiki link. */
export function markLinkTarget(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/);
  return match ? match[1].trim() : null;
}

/** Every mark value stored in a note's frontmatter. */
export function readMarks(frontmatter: Record<string, unknown> | undefined): Array<{ type: SetMarkType; value: string }> {
  const out: Array<{ type: SetMarkType; value: string }> = [];
  for (const [type, key] of Object.entries(MARK_PROPERTIES) as Array<[SetMarkType, string]>) {
    const raw = frontmatter?.[key];
    for (const value of Array.isArray(raw) ? raw : [raw]) if (typeof value === "string" && markLinkTarget(value)) out.push({ type, value });
  }
  return out;
}

/**
 * Set (or with "none" clear) the mark towards one target in a note's frontmatter: every entry that
 * `isTarget` recognises is removed, then `link` is added under the chosen type. Other values stay.
 */
export function setMark(frontmatter: Record<string, unknown>, type: MarkType, link: string, isTarget: (value: string) => boolean): void {
  for (const [kind, key] of Object.entries(MARK_PROPERTIES)) {
    const raw = frontmatter[key];
    const list: unknown[] = Array.isArray(raw) ? [...(raw as unknown[])] : raw === undefined || raw === null || raw === "" ? [] : [raw];
    const kept = list.filter(value => typeof value !== "string" || !isTarget(value));
    if (kind === type) kept.push(link);
    if (kept.length) frontmatter[key] = kept;
    else delete frontmatter[key];
  }
}
