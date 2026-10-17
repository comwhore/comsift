export interface DatasetColumns { name: string; columns: string[] }
export const CANONICAL = ["username", "display_name", "profile_url", "website", "bio", "location", "platform",
  "user_id", "created", "avatar_hash", "avatar_url", "verified", "followers", "relation"];
const ALIASES: Record<string, string> = {
  handle: "username", user: "username", user_name: "username", name: "display_name", full_name: "display_name",
  nickname: "display_name", description: "bio", biography: "bio", url: "profile_url", profile_link: "profile_url",
  screen_name: "username", login: "username", real_name: "display_name", about: "bio", profile: "profile_url",
  url_user: "profile_url", link: "profile_url", homepage: "website", personal_url: "website",
  city: "location", place: "location", country: "location", site: "platform", service: "platform", network: "platform",
  id: "user_id", uid: "user_id", pk: "user_id", did: "user_id", account_id: "user_id",
  created_at: "created", account_created: "created", joined: "created", member_since: "created",
  image_hash: "avatar_hash", dhash: "avatar_hash", avatar: "avatar_url", image: "avatar_url", profile_pic: "avatar_url", picture: "avatar_url",
  is_verified: "verified", followers_count: "followers", follower_count: "followers", relationship: "relation", list: "relation", kind: "relation",
};
export const fieldName = (name: string) => name.trim().toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, "_").replace(/^_+|_+$/g, "");
export function mappedField(column: string, mapping: Record<string, string>): string {
  if ((mapping._ignore ?? "").split("\n").includes(column)) return "";
  return Object.entries(mapping).find(([key, source]) => key !== "_ignore" && source === column)?.[0] ?? ALIASES[fieldName(column)] ?? fieldName(column);
}
export function datasetLabel(path: string): string {
  return (path.split("/").at(-1) ?? path).replace(/\.sheet\.md(?=#|$)/, ".sheet");
}
/** Compare effective shared fields, including saved mappings and ignored columns. */
export function columnMismatches(datasets: DatasetColumns[], saved: string) {
  let mappings: Record<string, Record<string, string>> = {};
  try { mappings = JSON.parse(saved || "{}") as Record<string, Record<string, string>>; } catch { /* Invalid settings are reported in the mapping dialog. */ }
  if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) mappings = {};
  const rows = datasets.map(dataset => {
    const mapping = { ...(mappings["*"] ?? {}), ...(mappings[dataset.name] ?? {}) };
    const fields = dataset.columns.map(column => mappedField(column, mapping));
    return { ...dataset, mapping, fields, signature: [...new Set(fields.filter(Boolean))].sort().join("\n") };
  });
  const signatures = new Map<string, number>();
  for (const row of rows) signatures.set(row.signature, (signatures.get(row.signature) ?? 0) + 1);
  return rows.map(row => ({ ...row,
    mismatching: rows.length < 2 ? [] : row.columns.filter((_, index) => {
      const field = row.fields[index];
      return field && rows.some(other => !other.fields.includes(field));
    }),
    mismatch: signatures.size > 1,
  })).sort((a, b) => (signatures.get(a.signature)! - signatures.get(b.signature)!) || a.name.localeCompare(b.name));
}
