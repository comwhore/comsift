/**
 * Column roles for imported datasets.
 *
 * Saved format (settings.columnMapping, JSON) — unchanged keys stay valid:
 *   { "<dataset name>" | "*" | "headers:<layout>": {
 *       "<field>": "<column>",          // canonical field (username, profile_url…) or a custom field name
 *       "_ignore": "col\ncol",          // skipped columns (left out everywhere)
 *       "_identity": "col\ncol",        // extra columns that identify one person (email, phone, Discord ID…)
 *       "_nomatch": "col\ncol",         // kept on profiles, not used by Splink, evidence scoring or Jina
 *       "_require_identity": "1" } }    // rows with no identity value are not people (totals, notes)
 * "headers:<layout>" entries are remembered per column layout and applied to new datasets with the same
 * (or nearly the same) headers. Username, user ID and profile link always identify an account.
 */
export interface DatasetColumns {
  name: string;
  columns: string[];
  samples?: Record<string, string[]>;
  filled?: Record<string, number>;
  distinct?: Record<string, number>;
  rows?: number;
  examples?: Array<Record<string, string>>;
}
export type Confidence = "high" | "medium" | "low";
export interface Detection { role: string; name: string; identity: boolean; confidence: Confidence; reason: string }
export interface ColumnChoice extends Detection { column: string; match: boolean; source: "saved" | "layout" | "auto"; detected: Detection }
export type Mapping = Record<string, string>;
export type Mappings = Record<string, Mapping>;

export const CANONICAL = ["username", "display_name", "profile_url", "website", "bio", "location", "platform",
  "user_id", "created", "avatar_hash", "avatar_url", "verified", "followers", "relation"];
export const IDENTITY_ROLES = new Set(["username", "user_id", "profile_url"]);
export const ROLE_LABELS: Record<string, string> = {
  username: "Username", display_name: "Display name", profile_url: "Profile link", user_id: "User ID",
  website: "Website", bio: "Bio", location: "Location", platform: "Platform", created: "Joined / created",
  avatar_url: "Avatar image", avatar_hash: "Avatar hash", verified: "Verified", followers: "Follower count",
  relation: "Relation (following, follower…)", other: "Other detail", skip: "Skip column",
};
const ALIASES: Record<string, string> = {
  handle: "username", user: "username", user_name: "username", screen_name: "username", login: "username", nick: "username",
  name: "display_name", full_name: "display_name", nickname: "display_name", real_name: "display_name",
  description: "bio", biography: "bio", about: "bio", status_text: "bio",
  url: "profile_url", profile_link: "profile_url", profile: "profile_url", url_user: "profile_url", link: "profile_url", profile_url: "profile_url",
  homepage: "website", personal_url: "website", site_url: "website",
  city: "location", place: "location", country: "location", region: "location",
  site: "platform", service: "platform", network: "platform",
  id: "user_id", uid: "user_id", pk: "user_id", did: "user_id", account_id: "user_id", userid: "user_id",
  created_at: "created", account_created: "created", joined: "created", member_since: "created", date_joined: "created", registered: "created",
  image_hash: "avatar_hash", dhash: "avatar_hash",
  avatar: "avatar_url", image: "avatar_url", profile_pic: "avatar_url", picture: "avatar_url", photo: "avatar_url", image_url: "avatar_url",
  is_verified: "verified", followers_count: "followers", follower_count: "followers", subscribers: "followers",
  relationship: "relation", list: "relation", kind: "relation",
};
const SECTION_LABELS = new Set(["following", "followers", "followed", "in common", "mutual", "mutuals", "friends", "connections"]);
const PERSONAL = { email: /^(e_?mail|mail|email_address|e_mail_address)$/, phone: /^(phone|phone_number|mobile|tel|telephone)$/ };

export const fieldName = (name: string) => name.trim().toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, "_").replace(/^_+|_+$/g, "");
/** Same comparison the Python parser uses for column names. */
const same = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
const lines = (value: string | undefined) => new Set((value ?? "").split("\n").map(same).filter(Boolean));

export function datasetLabel(path: string): string {
  return (path.split("/").at(-1) ?? path).replace(/\.sheet\.md(?=#|$)/, ".sheet");
}
/** Saved connection profiles are compared with the fields they were stored with; columns do not apply. */
export const isProfileDataset = (name: string) => /\.md$/i.test(name) && !/\.sheet\.md$/i.test(name);

/** Parse saved settings, dropping malformed entries instead of failing. */
export function parseMappings(saved: string): Mappings {
  try {
    const parsed: unknown = JSON.parse(saved || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([name, fields]: [string, unknown]) => {
      if (!fields || typeof fields !== "object" || Array.isArray(fields)) return [];
      return [[name, Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, string] => typeof entry[1] === "string"))]];
    }));
  } catch { return {}; }
}

/** The saved mapping a dataset inherits: global, source CSV, workbook, tab, then the exact range. */
export function savedMappingFor(mappings: Mappings, name: string, source?: string): Mapping {
  const sheet = name.split("#")[0];
  const tab = name.replace(/@[A-Z]+\d+:[A-Z]+\d+$/i, "");
  return { ...(mappings["*"] ?? {}), ...(source ? mappings[source] ?? {} : {}), ...(mappings[sheet] ?? {}), ...(mappings[tab] ?? {}), ...(mappings[name] ?? {}) };
}

/** Old helper kept for callers that only need the shared field name. */
export function mappedField(column: string, mapping: Mapping): string {
  if (lines(mapping._ignore).has(same(column))) return "";
  return Object.entries(mapping).find(([key, source]) => !key.startsWith("_") && same(source) === same(column))?.[0] ?? ALIASES[fieldName(column)] ?? fieldName(column);
}

export function layoutKey(columns: string[]): string {
  return "headers:" + [...new Set(columns.map(fieldName).filter(Boolean))].sort().join("|");
}
/** A remembered mapping for the same column layout, or a close one (most headers shared). */
export function findLayout(columns: string[], mappings: Mappings): Mapping | undefined {
  const key = layoutKey(columns);
  if (mappings[key]) return mappings[key];
  const mine = new Set(key.slice(8).split("|").filter(Boolean));
  let best: { score: number; mapping: Mapping } | undefined;
  for (const [name, mapping] of Object.entries(mappings)) {
    if (!name.startsWith("headers:")) continue;
    const theirs = new Set(name.slice(8).split("|").filter(Boolean));
    const shared = [...mine].filter(value => theirs.has(value)).length;
    const score = shared / (new Set([...mine, ...theirs]).size || 1);
    if (score >= 0.75 && (!best || score > best.score)) best = { score, mapping };
  }
  return best?.mapping;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const LINK = /^https?:\/\/\S+$/i;
const HANDLE = /^@[\p{L}\p{N}_.-]{2,}$/u;
const DIGITS = /^\d{5,}$/;
const DATE = /^(\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})([ T]\d{1,2}:\d{2}.*)?$/;
const PHONE = /^\+?[\d\s().-]{7,}$/;
const HEX = /^[0-9a-f]{12,64}$/i;
const COUNT = /^\d+(?:[ ,.]\d+)*\s*[kmb]?$/i;
const IMAGE = /\.(jpe?g|png|gif|webp|avif)(\?|$)|avatar|pfp|profile_pic|cdninstagram|scontent|pbs\.twimg|rbxcdn|tiktokcdn/i;
const SOCIAL = /(^|\.)(instagram|tiktok|roblox|bsky|twitter|x|facebook|youtube|discord|snapchat|threads|reddit|t|telegram|twitch|github|linkedin|vk|pinterest|tumblr|mastodon)\.(com|app|net|tv|me|social|org)$/i;

function share(values: string[], test: (value: string) => boolean): number {
  return values.length ? values.filter(test).length / values.length : 0;
}
function profileLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.pathname.length > 1 && (SOCIAL.test(url.hostname.replace(/^www\./, "")) || /\/(@|u\/|users?\/|profiles?\/|people\/|channel\/)/i.test(url.pathname));
  } catch { return false; }
}

/** Suggest a role from the header, then from sample values. Deterministic; no AI. */
export function detectColumn(column: string, info: Pick<DatasetColumns, "samples" | "filled" | "distinct" | "rows"> = {}): Detection {
  const name = fieldName(column);
  const header = same(column);
  const values = (info.samples?.[column] ?? []).map(value => value.trim()).filter(Boolean);
  const filled = info.filled?.[column];
  const rows = info.rows ?? 0;
  const result = (role: string, confidence: Confidence, reason: string, extra: Partial<Detection> = {}): Detection =>
    ({ role, name: role === "other" ? extra.name ?? name : "", identity: IDENTITY_ROLES.has(role), confidence, reason, ...extra });
  if (!name) return result("skip", "high", "No header");
  if (/^\d+$/.test(column.trim())) return result("skip", "high", "A number in the header row, not a column name");
  if (column.trim().endsWith(":")) return result("skip", "high", "A label for a total, not a column");
  if (SECTION_LABELS.has(header) && !filled) return result("skip", "high", "Section label above a block of columns");
  if (rows > 0 && filled === 0) return result("skip", "high", "Empty in every row");
  const constant = rows >= 3 && (filled ?? 0) >= 3 && info.distinct?.[column] === 1;
  for (const [kind, pattern] of Object.entries(PERSONAL)) {
    if (pattern.test(name)) return result("other", "high", `Header says ${kind}`, { name: kind, identity: !constant });
  }
  const alias = ALIASES[name] ?? (CANONICAL.includes(name) ? name : undefined);
  const links = share(values, value => LINK.test(value));
  if (alias && !(["profile_url", "website", "avatar_url"].includes(alias) && values.length >= 2 && links < 0.5)) {
    if (constant && !["platform", "relation", "verified"].includes(alias)) return result("skip", "medium", "Same value in every row");
    if (alias === "profile_url" && values.length && links >= 0.8 && share(values, profileLink) < 0.5) return result("website", "medium", "Links are not profile pages");
    return result(alias, "high", "Header name");
  }
  if (constant) return result("skip", "medium", "Same value in every row");
  const most = (test: (value: string) => boolean) => values.length > 0 && share(values, test) >= 0.8;
  if (most(value => EMAIL.test(value))) return result("other", "medium", "Values are email addresses", { name: "email", identity: true });
  if (most(value => LINK.test(value))) {
    if (most(value => IMAGE.test(value))) return result("avatar_url", "medium", "Values are image links");
    if (most(profileLink)) return result("profile_url", "medium", "Values are profile links");
    return result("website", "medium", "Values are links");
  }
  if (most(value => HANDLE.test(value))) return result("username", "medium", "Values look like @handles");
  if (most(value => DATE.test(value))) return result("created", "medium", "Values are dates");
  if (/follow|subscriber|fans/.test(name) && most(value => COUNT.test(value))) return result("followers", "medium", "Header and values look like follower counts");
  if (/(^|_)(id|uid|pk)$|_?id$/.test(name) && most(value => DIGITS.test(value) || HEX.test(value))) return result("user_id", "medium", "Header ends in “id” and values are IDs");
  if (most(value => PHONE.test(value) && /[+\s().-]/.test(value) && value.replace(/\D/g, "").length >= 7)) return result("other", "medium", "Values look like phone numbers", { name: "phone", identity: true });
  if (/verif/.test(name) && most(value => /^(true|false|yes|no|0|1)$/i.test(value))) return result("verified", "medium", "Header and values look like a verified flag");
  if (/user.?name|handle|login/.test(name)) return result("username", "medium", "Header mentions a username");
  if (/display|full.?name|^name|_name$/.test(name)) return result("display_name", "medium", "Header mentions a name");
  if (/bio|about|description/.test(name)) return result("bio", "medium", "Header mentions a bio");
  if (/city|country|location|region|town/.test(name)) return result("location", "medium", "Header mentions a place");
  if (/created|joined|since|registered/.test(name)) return result("created", "medium", "Header mentions a date");
  if (/avatar|photo|picture|image/.test(name)) return result("avatar_url", "medium", "Header mentions an image");
  if (/follower|subscriber/.test(name)) return result("followers", "medium", "Header mentions followers");
  return result("other", "low", values.length ? "No known pattern; kept as its own detail" : "No sample values; kept as its own detail");
}

function fromMapping(mapping: Mapping | undefined, column: string): Pick<ColumnChoice, "role" | "name"> | undefined {
  if (!mapping) return undefined;
  if (lines(mapping._ignore).has(same(column))) return { role: "skip", name: "" };
  const key = Object.entries(mapping).find(([field, source]) => !field.startsWith("_") && same(source) === same(column))?.[0];
  if (key === undefined) return undefined;
  const field = key.replace(/^column:/, "");
  return CANONICAL.includes(field) ? { role: field, name: "" } : { role: "other", name: fieldName(field) || fieldName(column) };
}

const RANK = { saved: 3, layout: 2, auto: 1 } as const;
const CONFIDENCE = { high: 3, medium: 2, low: 1 } as const;
/** Field a choice produces in profiles ("" for skipped columns). */
export const choiceField = (choice: Pick<ColumnChoice, "role" | "name" | "column">) =>
  choice.role === "skip" ? "" : choice.role === "other" ? fieldName(choice.name) || fieldName(choice.column) : choice.role;

/** Saved choices win, then a remembered layout, then automatic detection. Automatic duplicates are demoted. */
export function resolveColumns(dataset: DatasetColumns, saved?: Mapping, layout?: Mapping): ColumnChoice[] {
  const choices = dataset.columns.map((column): ColumnChoice => {
    const detected = detectColumn(column, dataset);
    for (const [source, mapping] of [["saved", saved], ["layout", layout]] as const) {
      const picked = fromMapping(mapping, column);
      if (!picked) continue;
      const listed = mapping!._identity !== undefined;
      const identity = !lines(mapping!._noidentity).has(same(column)) && (IDENTITY_ROLES.has(picked.role) || (listed ? lines(mapping!._identity).has(same(column))
        : detected.identity && detected.role === picked.role && detected.name === picked.name));
      return { ...detected, ...picked, column, identity: picked.role !== "skip" && identity, match: !lines(mapping!._nomatch).has(same(column)),
        source, confidence: "high", reason: source === "saved" ? "Saved for this dataset" : "Remembered from datasets with the same columns", detected };
    }
    return { ...detected, column, match: true, source: "auto", detected };
  });
  const order = [...choices].sort((a, b) => RANK[b.source] - RANK[a.source] || CONFIDENCE[b.confidence] - CONFIDENCE[a.confidence]);
  const taken = new Map<string, ColumnChoice>();
  for (const choice of order) {
    if (choice.role === "skip") continue;
    let field = choiceField(choice);
    const winner = taken.get(field);
    if (winner && choice.source !== "saved") {
      const label = ROLE_LABELS[choice.role] ?? choice.name;
      choice.role = "other"; choice.identity = choice.detected.role === "other" && choice.detected.identity;
      choice.name = fieldName(choice.column); choice.confidence = "low";
      choice.reason = `${label} already comes from “${winner.column}”`;
      field = choiceField(choice);
      for (let n = 2; taken.has(field); n++) { choice.name = `${fieldName(choice.column)}_${n}`; field = choiceField(choice); }
    }
    if (!taken.has(field)) taken.set(field, choice);
  }
  return choices;
}

/** Problems a person has to decide; automatic suggestions never produce these. */
export function columnConflicts(choices: ColumnChoice[]): string[] {
  const problems: string[] = [];
  const byField = new Map<string, string[]>();
  for (const choice of choices) {
    const field = choiceField(choice);
    if (field) byField.set(field, [...(byField.get(field) ?? []), choice.column]);
  }
  for (const [field, columns] of byField) {
    if (columns.length > 1) problems.push(`${columns.map(column => `“${column}”`).join(" and ")} are all set to ${ROLE_LABELS[field] ?? field}.`);
  }
  if (choices.some(choice => choice.role !== "skip") && !choices.some(choice => choice.role !== "skip" && choice.identity && choice.match)) {
    problems.push("Keep at least one identity column enabled for matching.");
  }
  return problems;
}
export const hasIdentity = (choices: ColumnChoice[]) => choices.some(choice => choice.role !== "skip" && choice.identity);

/** Serialize choices into the saved/Python mapping format. */
export function choicesToMapping(choices: ColumnChoice[], options: { requireIdentity?: boolean } = {}): Mapping {
  const mapping: Mapping = {};
  const ignore: string[] = [], identity: string[] = [], unmatched: string[] = [], noIdentity: string[] = [];
  for (const choice of choices) {
    if (choice.role === "skip") { ignore.push(choice.column); continue; }
    mapping[choiceField(choice)] = choice.column;
    if (choice.identity && !IDENTITY_ROLES.has(choice.role)) identity.push(choice.column);
    if (!choice.identity && IDENTITY_ROLES.has(choice.role)) noIdentity.push(choice.column);
    if (!choice.match) unmatched.push(choice.column);
  }
  if (ignore.length) mapping._ignore = ignore.join("\n");
  mapping._identity = identity.join("\n");
  if (noIdentity.length) mapping._noidentity = noIdentity.join("\n");
  if (unmatched.length) mapping._nomatch = unmatched.join("\n");
  if (options.requireIdentity) mapping._require_identity = "1";
  return mapping;
}

/** Complete per-dataset mappings for parsing: saved choices plus automatic suggestions for everything else. */
export function effectiveMapping(dataset: DatasetColumns, saved: Mapping, mappings: Mappings): Mapping {
  const layout = findLayout(dataset.columns, mappings);
  const requireIdentity = (saved._require_identity ?? layout?._require_identity) === "1";
  return choicesToMapping(resolveColumns(dataset, saved, layout), { requireIdentity });
}

/** Copy roles to another dataset for columns with the same header. Other columns keep their choices. */
export function copyChoices(from: ColumnChoice[], to: ColumnChoice[]): ColumnChoice[] {
  const byColumn = new Map(from.map(choice => [same(choice.column), choice]));
  return to.map(choice => {
    const source = byColumn.get(same(choice.column));
    return source ? { ...choice, role: source.role, name: source.name, identity: source.identity, match: source.match, source: "saved", reason: "Copied" } : choice;
  });
}

export interface ProfilePreview { title: string; identity: Array<[string, string]>; details: Array<[string, string]>; unmatched: string[]; skipped: string[]; isPerson: boolean }
/** What one imported row turns into, for the live preview. */
export function previewProfile(choices: ColumnChoice[], row: Record<string, string>, requireIdentity = false): ProfilePreview {
  const identity: Array<[string, string]> = [], details: Array<[string, string]> = [], unmatched: string[] = [], skipped: string[] = [];
  const label = (choice: ColumnChoice) => choice.role === "other" ? choiceField(choice) : ROLE_LABELS[choice.role] ?? choice.role;
  for (const choice of choices) {
    if (choice.role === "skip") { skipped.push(choice.column); continue; }
    const value = row[choice.column]?.trim();
    if (!value) continue;
    if (choice.identity) identity.push([label(choice), value]);
    else details.push([label(choice), value]);
    if (!choice.match) unmatched.push(label(choice));
  }
  const find = (role: string) => choices.find(choice => choice.role === role && row[choice.column]?.trim());
  const named = find("display_name") ?? find("username") ?? choices.find(choice => choice.identity && row[choice.column]?.trim());
  return { title: named ? row[named.column].trim() : "Unnamed profile", identity, details, unmatched, skipped, isPerson: !requireIdentity || identity.length > 0 };
}

/** Compare effective shared fields (saved, remembered and automatic) and report genuine conflicts. */
export function columnMismatches(datasets: DatasetColumns[], saved: string) {
  const mappings = parseMappings(saved);
  const rows = datasets.map(dataset => {
    const mapping = savedMappingFor(mappings, dataset.name);
    // Stored profiles already carry field names ("column:", "id:" and "note:" prefixes mark custom fields).
    const profile = isProfileDataset(dataset.name);
    const choices = profile ? [] : resolveColumns(dataset, mapping, findLayout(dataset.columns, mappings));
    const fields = profile ? dataset.columns.map(column => column.replace(/^(column|id|note):/, "")) : choices.map(choiceField);
    return { ...dataset, mapping, fields, conflicts: columnConflicts(choices), signature: [...new Set(fields.filter(Boolean))].sort().join("\n") };
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
