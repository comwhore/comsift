import { exactProfileMatch } from "./connectionIdentity";
import type { ProfileRecord } from "./runner";
import { readListProperty, writeListProperty } from "../service/graphLogic";
import { personNotes, withPersonCard } from "../service/personCardFormat";
export type StoredProfile = Pick<ProfileRecord, "id" | "dataset" | "row" | "fields">;
const KNOWN = /(?:^|[\s.])(instagram|tiktok|roblox|bluesky|bsky|twitter|facebook|youtube|discord|snapchat|threads|reddit|telegram|twitch)(?:\.com)?$/i;
export function canonicalPlatform(fields: Record<string, string>): string {
  const raw = (fields.platform ?? "").trim().toLowerCase();
  let host = "";
  try { host = new URL(fields.profile_url ?? "").hostname.toLowerCase().replace(/^www\./, ""); } catch { /* No URL evidence. */ }
  const fromHost = host.match(/(?:^|\.)(instagram|tiktok|roblox|facebook|youtube|discord|snapchat|threads|reddit|twitch)\.(?:com|net|tv)$/)?.[1];
  const value = fromHost ?? (host === "bsky.app" ? "bluesky" : host === "x.com" ? "twitter" : undefined) ?? raw.match(KNOWN)?.[1] ?? raw;
  return value === "bsky" ? "bluesky" : value;
}
export function profileAccountKey(fields: Record<string, string>, fallback: string): string {
  const custom = Object.entries(fields).filter(([key, value]) => key.startsWith("column:") && value.trim()).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, value.trim().toLowerCase()]);
  const chosen = Object.keys(fields).filter(key => key.startsWith("id:") && fields[key].trim()).sort()[0];
  const handle = (fields.username || fields.profile_url || fields.user_id || (chosen ? `${chosen}=${fields[chosen]}` : "") || (custom.length ? JSON.stringify(custom) : fallback)).trim().toLowerCase().replace(/^@/, "");
  return `${canonicalPlatform(fields)}|${handle}`;
}
/** Fields produced by columns the user marked as identifying one person (see column mapping "_identity"). */
export function identityFields(fields: Record<string, string>): string[] {
  return Object.keys(fields).filter(key => key.startsWith("id:")).sort();
}
/**
 * One-line YAML scalar → string. Comsift writes JSON (double-quoted) strings, but Obsidian rewrites
 * frontmatter it edits (for example when a relationship mark is added) with single quotes.
 */
function yamlScalar(raw: string): string | null {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try { const parsed: unknown = JSON.parse(value); return typeof parsed === "string" ? parsed : null; } catch { return null; }
  }
  if (value.startsWith("'")) return value.length > 1 && value.endsWith("'") ? value.slice(1, -1).replace(/''/g, "'") : null;
  return value;
}
export function readProfileRecords(text: string, fallbackIds: string[] = []): StoredProfile[] {
  const encoded = text.match(/^comsift_profile_data: (.+)$/m)?.[1];
  const decoded = encoded === undefined ? null : yamlScalar(encoded);
  if (decoded) {
    try {
      const records: unknown = JSON.parse(decoded);
      if (Array.isArray(records) && records.every((r: unknown) => !!r && typeof r === "object" && "id" in r && typeof r.id === "string" && "dataset" in r && typeof r.dataset === "string" && "row" in r && typeof r.row === "number" && Number.isFinite(r.row) && "fields" in r && !!r.fields && typeof r.fields === "object" && !Array.isArray(r.fields) && Object.values(r.fields).every((v: unknown) => typeof v === "string"))) return records as StoredProfile[];
    } catch { /* Legacy body below. */ }
  }
  const ids = [...new Set([...readListProperty(text, "comsift_records"), ...readListProperty(text, "comsift_record"), ...fallbackIds])];
  const fields: Record<string, string> = {};
  for (const match of text.matchAll(/^- ([\w :]+): (.*)$/gm)) fields[match[1].trim()] = match[2].trim();
  const dataset = text.match(/^Source dataset: (?:\[\[)?([^\]\r\n]+?)(?:\]\])?\s*$/m)?.[1]?.trim() ?? text.match(/^- \[\[([^\]]+)\]\], row/m)?.[1]?.trim();
  if (!ids.length) {
    const heading = text.match(/^# (.+)$/m)?.[1]?.trim();
    if (heading && /^.*:\d+(?:\.\d+)?$/.test(heading)) ids.push(heading);
  }
  if (!dataset) return [];
  return ids.map(id => {
    const parsed = id.match(/^(.*):(\d+)(?:\.\d+)?$/);
    const source = parsed?.[1] ?? (/\.(md|csv)$/i.test(dataset) ? dataset : `${dataset}.md`);
    return { id, dataset: source, row: parsed ? Number(parsed[2]) : Number(text.match(/row (\d+)/)?.[1] ?? 0), fields: { ...fields, platform: canonicalPlatform(fields) } };
  });
}
function scalar(content: string, key: string, value: string): string {
  const block = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const body = block ? content.slice(block[0].length) : content;
  const front = (block?.[1] ?? "").replace(new RegExp(`^${key}:.*(?:\\r?\\n|$)`, "m"), "").trim();
  return `---\n${front ? front + "\n" : ""}${key}: ${JSON.stringify(value)}\n---\n${body}`;
}
export function mergeProfileContent(records: StoredProfile[], name: string, existing = ""): string {
  const unique: StoredProfile[] = [...new Map(records.map(record => [`${record.id}\n${profileAccountKey(record.fields, record.id)}`, { ...record, fields: { ...record.fields, platform: canonicalPlatform(record.fields) } }])).values()];
  const accounts = [...new Set(unique.map(record => profileAccountKey(record.fields, record.id)))];
  let result = scalar(existing, "comsift_account", accounts[0] ?? "");
  result = scalar(result, "comsift_profile_data", JSON.stringify(unique));
  result = writeListProperty(result, "comsift_records", [...new Set(unique.map(record => record.id))]);
  result = writeListProperty(result, "comsift_accounts", accounts);
  result = writeListProperty(result, "aliases", [...new Set([...readListProperty(existing, "aliases"), ...unique.map(record => record.fields.username).filter((v): v is string => !!v)])]);
  const sources = [...new Set(unique.map(record => record.dataset.split("#")[0]))];
  result = writeListProperty(result, "comsift_sources", sources.map(path => `[[${path.endsWith(".md") ? path.slice(0, -3) : path}]]`));
  // The body only holds the card block (rendered from these properties) and the user's notes.
  return withPersonCard(result, { primary: /^comsift_id:/m.test(result.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "") });
}

/**
 * Give a note the person card layout. Old notes without `comsift_profile_data` keep their rows only in the
 * generated body, so those rows are stored in frontmatter first; nothing the body held is lost.
 */
export function upgradeProfileNote(content: string, primary = false): string {
  if (/^comsift_profile_data:/m.test(content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "")) return withPersonCard(content, { primary });
  const records = readProfileRecords(content);
  return records.length ? mergeProfileContent(records, "", content) : withPersonCard(content, { primary });
}

export function mergeProfileDocuments(records: StoredProfile[], name: string, documents: string[]): string {
  let result = mergeProfileContent(records, name, documents[0] ?? "");
  for (const key of ["tags", "aliases", "relationships", "comsift_links", "comsift_same", "comsift_related", "comsift_uncertain"]) {
    const values = [...new Set([...readListProperty(result, key), ...documents.flatMap(text => readListProperty(text, key))])];
    result = writeListProperty(result, key, values);
  }
  for (const text of documents.slice(1)) {
    const extra = personNotes(text);
    if (extra && !result.includes(extra)) result += `\n\n${extra}\n`;
    const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
    if (front) {
      const known = /^(?:comsift_account|comsift_profile_data|comsift_records|comsift_record|comsift_accounts|comsift_sources|tags|aliases|relationships|comsift_links|comsift_same|comsift_related|comsift_uncertain):[^\n]*(?:\r?\n(?:[ \t]+[^\n]*|-[ \t][^\n]*))*/gm;
      const metadata = front.replace(known, "").trim();
      if (metadata && !result.includes(metadata)) result += `\n\n### Metadata preserved from a merged profile\n\n\`\`\`yaml\n${metadata}\n\`\`\`\n`;
    }
  }
  return result;
}

export interface ProfileEntry { path: string; scope: string; records: StoredProfile[]; text: string }
export interface ProfileComponent { key: string; scope: string; records: StoredProfile[]; entries: ProfileEntry[] }
/** Only compatible exact evidence or explicitly confirmed review choices establish shared identity. */
export function profileComponents(entries: ProfileEntry[], reviews: Array<Record<string, unknown>>): ProfileComponent[] {
  const fields = ["username", "user_id", "profile_url", "display_name", "bio", "location", "website"];
  const normalized = (record: StoredProfile): Map<string, string> => {
    const values = new Map<string, string>();
    const platform = canonicalPlatform(record.fields); if (platform) values.set("platform", platform);
    for (const key of [...fields, ...identityFields(record.fields)]) {
      let value = (record.fields[key] ?? "").trim().toLowerCase().replace(/\s+/g, " ");
      if (key === "username") value = value.replace(/^@/, "");
      if (key === "profile_url" && value) {
        try { const url = new URL(value); url.hostname = url.hostname.replace(/^www\./, ""); url.hash = ""; value = url.toString().replace(/\/$/, ""); } catch { /* Non-URL labels retain normalized text. */ }
      }
      if (value) values.set(key, value);
    }
    return values;
  };
  const parents = new Map<string, string>();
  const facts = new Map<string, Map<string, string>>();
  const anchors = new Map<string, Set<string>>();
  const groupAnchors = new Map<string, Set<string>>();
  const byRecord = new Map<string, Set<string>>();
  const occurrences: Array<{ entry: ProfileEntry; record: StoredProfile; key: string }> = [];
  const find = (key: string): string => {
    let root = key;
    while (parents.get(root)! !== root) root = parents.get(root)!;
    while (key !== root) { const next = parents.get(key)!; parents.set(key, root); key = next; }
    return root;
  };
  const union = (left: string, right: string) => {
    const a = find(left), b = find(right); if (a === b) return;
    parents.set(b, a);
    for (const [key, value] of facts.get(b)!) if (!facts.get(a)!.has(key)) facts.get(a)!.set(key, value);
    for (const anchor of groupAnchors.get(b)!) {
      const bucket = anchors.get(anchor)!; bucket.delete(b); bucket.add(a); groupAnchors.get(a)!.add(anchor);
    }
  };
  const unique = new Map<string, string>();
  for (const entry of entries) for (const record of entry.records) {
    // A row ID is provenance, not identity. Keep conflicting observations of a reused row distinct.
    const signature = JSON.stringify([entry.scope, record.dataset, record.row, record.id, Object.entries(record.fields).sort(([a], [b]) => a.localeCompare(b))]);
    let key = unique.get(signature);
    if (!key) {
      key = `${entry.scope}\n${unique.size}`; unique.set(signature, key); parents.set(key, key);
      const values = normalized(record); facts.set(key, values); groupAnchors.set(key, new Set());
      const candidates = new Set<string>();
      for (const field of ["username", "user_id", "profile_url", ...identityFields(record.fields)]) {
        const value = values.get(field); if (!value) continue;
        const anchor = JSON.stringify([entry.scope, field, value]);
        const bucket = anchors.get(anchor) ?? new Set<string>();
        for (const candidate of bucket) candidates.add(find(candidate));
        bucket.add(key); anchors.set(anchor, bucket); groupAnchors.get(key)!.add(anchor);
      }
      for (const candidate of candidates) {
        const root = find(key), other = find(candidate); if (root === other) continue;
        // Missing fields cannot bridge two clusters with contradictory known identifiers.
        const compatible = [...facts.get(other)!].every(([field, value]) => !facts.get(root)!.has(field) || facts.get(root)!.get(field) === value);
        if (compatible && exactProfileMatch(record.fields, Object.fromEntries(facts.get(other)!))) union(root, other);
      }
    }
    occurrences.push({ entry, record, key });
    const ids = byRecord.get(`${entry.scope}\n${record.id}`) ?? new Set<string>(); ids.add(key); byRecord.set(`${entry.scope}\n${record.id}`, ids);
  }
  const scopes = [...new Set(entries.map(entry => entry.scope))];
  for (const review of reviews) for (const [pair, raw] of Object.entries(review)) {
    if (!raw || typeof raw !== "object" || !("status" in raw) || raw.status !== "confirmed") continue;
    const parts = pair.split(" → ");
    const source = "source_id" in raw && typeof raw.source_id === "string" ? raw.source_id : parts[0];
    const target = "candidate_id" in raw && typeof raw.candidate_id === "string" ? raw.candidate_id : parts[1];
    for (const scope of scopes) {
      const a = new Set([...(byRecord.get(`${scope}\n${source}`) ?? [])].map(find));
      const b = new Set([...(byRecord.get(`${scope}\n${target}`) ?? [])].map(find));
      if (a.size !== 1 || b.size !== 1) continue; // Reused ambiguous row IDs cannot prove identity.
      union([...a][0], [...b][0]);
    }
  }
  const groups = new Map<string, ProfileComponent>();
  const seenRecords = new Map<string, Set<string>>();
  const seenEntries = new Map<string, Set<ProfileEntry>>();
  for (const { entry, record, key: node } of occurrences) {
    const key = find(node);
    const group = groups.get(key) ?? { key, scope: entry.scope, records: [], entries: [] };
    const seen = seenRecords.get(key) ?? new Set<string>();
    if (!seen.has(node)) { group.records.push(record); seen.add(node); seenRecords.set(key, seen); }
    const documents = seenEntries.get(key) ?? new Set<ProfileEntry>();
    if (!documents.has(entry)) { group.entries.push(entry); documents.add(entry); seenEntries.set(key, documents); }
    groups.set(key, group);
  }
  return [...groups.values()];
}
