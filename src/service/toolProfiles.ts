// Pure helpers: Maigret and Sherlock result notes (`<Person>/Maigret/*.md`, `<Person>/Sherlock/*.md`) → profile
// records, so every account found becomes a connection profile with a person card, like an imported row.
import type { ProfileRecord } from "../analysis/runner";

export type ToolKind = "maigret" | "sherlock";

/** `Person/Maigret/x.md` → "maigret"; anything else → null. */
export function toolReportKind(path: string): ToolKind | null {
  if (!/\.md$/i.test(path)) return null;
  const parts = path.split("/");
  const folder = parts.at(-2)?.toLowerCase();
  return parts.length >= 3 && (folder === "maigret" || folder === "sherlock") ? folder : null;
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const ROW = /^([A-Za-z_][\w. -]{0,60}):[ \t]?(.*)$/;

/** Platform name from a profile URL host: `www.tiktok.com` → tiktok, `t.me` → telegram, `name.wordpress.com` → wordpress. */
export function platformFromHost(url: string): string {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
  const special: Record<string, string> = { "t.me": "telegram", "telegram.me": "telegram", "x.com": "twitter", "twitter.com": "twitter", "bsky.app": "bluesky", "youtu.be": "youtube", "vk.com": "vk", "ok.ru": "ok" };
  if (special[host]) return special[host];
  const labels = host.split(".");
  if (labels.length < 2) return host;
  // `example.co.uk` → example; `op.gg` stays op.gg (a two-letter name says little on its own).
  const second = labels.length >= 3 && /^(?:co|com|org|net|ac|gov)$/.test(labels.at(-2) ?? "") ? labels.at(-3) ?? "" : labels.at(-2) ?? "";
  return second.length <= 2 ? labels.slice(-2).join(".") : second;
}

/** Rows of a report: `key: value` lines; for keys that repeat (`username`), the last one wins. */
function reportRows(content: string, start: number): Array<[string, string]> {
  const lines = content.split(/\r?\n/);
  const rows: Array<[string, string]> = [];
  for (const line of lines.slice(start)) {
    if (!line.trim()) { if (rows.length) break; continue; }
    const match = line.match(ROW);
    if (!match) { if (rows.length) break; continue; }
    rows.push([match[1].trim(), match[2].trim()]);
  }
  return rows;
}

const first = (values: Record<string, string>, keys: string[]): string => {
  for (const key of keys) if (values[key]?.trim()) return values[key].trim();
  return "";
};

/** Profile fields and raw values of one found account. */
export interface ToolAccount {
  kind: ToolKind;
  fields: Record<string, string>;
  raw: Record<string, string>;
}

/**
 * Parse a Maigret report written by `MaigretService.buildSiteMarkdown`:
 * `# header`, `<small>url</small>`, then `key: value` rows (`username: <query>` first, then Maigret's ids).
 * Sherlock reports: `# Site`, `Username: x`, `Profile: url`, `Site: main url`.
 */
export function parseToolReport(path: string, content: string): ToolAccount | null {
  const kind = toolReportKind(path);
  if (!kind) return null;
  const body = content.replace(FRONTMATTER, "");
  const lines = body.split(/\r?\n/);
  const header = lines.find(line => /^# /.test(line))?.slice(2).trim() ?? "";
  if (kind === "sherlock") {
    const values: Record<string, string> = {};
    for (const line of lines) {
      const match = line.match(/^(Username|Profile|Site|HTTP status):[ \t]*(.*)$/);
      if (match) values[match[1].toLowerCase()] = match[2].trim();
    }
    const url = values.profile ?? "";
    if (!/^https?:\/\//i.test(url)) return null;
    const site = header && header !== values.username ? header : platformFromHost(values.site || url);
    const fields = { username: values.username ?? "", platform: (site || platformFromHost(url)).toLowerCase(), profile_url: url };
    return { kind, fields, raw: { Site: site, Username: values.username ?? "", Profile: url } };
  }
  const urlLine = lines.findIndex(line => /^<small>\s*https?:\/\/[^<]+<\/small>\s*$/i.test(line.trim()));
  if (urlLine < 0) return null;
  const url = lines[urlLine].trim().replace(/^<small>\s*/i, "").replace(/\s*<\/small>$/i, "");
  const rows = reportRows(body, urlLine + 1);
  const values: Record<string, string> = {};
  for (const [key, value] of rows) if (value) values[key] = value;
  const query = rows.find(([key]) => key === "username")?.[1] ?? path.split("/").at(-1)?.split(" ")[0] ?? "";
  const site = (values.site || platformFromHost(url)).toLowerCase();
  const siteKey = site.replace(/\s+/g, "_");
  const handle = header.includes(" / ") ? header.split(" / ").slice(1).join(" / ").trim() : "";
  const fields: Record<string, string> = {
    username: first(values, [`${siteKey}_username`, "screen_name", "handle"]) || handle || values.username || query,
    platform: site,
    profile_url: url,
    display_name: first(values, ["fullname", "full_name", "name", "display_name", "nickname", `${siteKey}_name`]),
    bio: first(values, ["bio", "description", "about", "status_message"]),
    user_id: first(values, ["uid", "user_id", "id", `${siteKey}_id`, `${siteKey}_user_id`]) ||
      (Object.entries(values).find(([key]) => /(?:^|_)(?:user_)?id$/.test(key) && !/^sec_/.test(key))?.[1] ?? ""),
    avatar_url: first(values, ["image", "img", "avatar", "avatar_url", "profile_image_url"]),
    followers: first(values, ["follower_count", "followers_count", "followers"]),
    created: first(values, ["created_at", "created", "registered", "join_date"]),
    location: first(values, ["location", "country", "city"]),
    website: first(values, ["website", "links", "external_url"]),
    verified: first(values, ["is_verified", "verified"]),
  };
  for (const key of Object.keys(fields)) if (!fields[key]) delete fields[key];
  const raw: Record<string, string> = { site, url };
  for (const [key, value] of rows) if (value && key !== "site") raw[key] = value;
  return { kind, fields, raw };
}

/** One profile record per report note. The id is stable, so importing the same note again changes nothing. */
export function toolRecord(path: string, account: ToolAccount): ProfileRecord {
  return { id: `${path}:0`, dataset: path, row: 0, fields: account.fields, raw: account.raw, section: account.kind === "maigret" ? "Maigret" : "Sherlock" };
}
