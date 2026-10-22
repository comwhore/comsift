import type ComsiftPlugin from "../main";
import type { SetMarkType } from "./personMarks";
import { primaryIdentity } from "../analysis/primaryIdentity";

export interface ReviewRelation { source: string; target: string; type: SetMarkType }

/** Read committed analysis choices using current profile paths, including consolidated accounts. */
export async function reviewRelations(plugin: ComsiftPlugin): Promise<ReviewRelation[]> {
  const { vault, metadataCache } = plugin.app;
  const paths = new Map<string, string>();
  for (const file of vault.getMarkdownFiles()) {
    paths.set(`${file.path}:0`, file.path);
    const frontmatter = metadataCache.getFileCache(file)?.frontmatter;
    if (plugin.investigations?.forPrimaryPath?.(file.path)) {
      for (const record of primaryIdentity(file.path, await vault.cachedRead(file), frontmatter)) paths.set(record.id, file.path);
    }
    const raw: unknown = frontmatter?.comsift_profile_data;
    if (typeof raw !== "string") continue;
    try {
      const records: unknown = JSON.parse(raw);
      if (Array.isArray(records)) for (const record of records as unknown[]) {
        if (record && typeof record === "object" && "id" in record && typeof record.id === "string") paths.set(record.id, file.path);
      }
    } catch { /* A malformed profile must not hide relationships on other notes. */ }
  }
  const choices = new Map<string, { source: string; target: string; status: string; updated: string }>();
  for (const file of vault.getFiles().filter(file => file.path.endsWith("/Analysis/reviews.json"))) {
    let entries: Record<string, unknown>;
    try { entries = JSON.parse(await vault.cachedRead(file)) as Record<string, unknown>; } catch { continue; }
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    for (const [key, raw] of Object.entries(entries)) {
      if (!raw || typeof raw !== "object") continue;
      const draft = raw as Record<string, unknown>;
      const entry = (draft.pending ? draft.committedReview : draft) as Record<string, unknown> | undefined;
      if (!entry || typeof entry !== "object") continue;
      const [left, right] = key.split(" → ");
      const source = paths.get(typeof entry.source_id === "string" ? entry.source_id : left);
      const target = paths.get(typeof entry.candidate_id === "string" ? entry.candidate_id : right);
      if (!source || !target || source === target || typeof entry.status !== "string") continue;
      const pair = [source, target].sort().join("\n");
      const updated = typeof entry.updatedAt === "string" ? entry.updatedAt : "";
      if (!choices.has(pair) || updated >= choices.get(pair)!.updated) choices.set(pair, { source, target, status: entry.status, updated });
    }
  }
  return [...choices.values()].flatMap(({ source, target, status }) => {
    const type = status === "confirmed" ? "same" : status === "related" || status === "uncertain" ? status : null;
    return type ? [{ source, target, type }] : [];
  });
}
