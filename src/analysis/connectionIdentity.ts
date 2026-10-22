import { canonicalPlatform } from "./profileIdentity";

const normalize = (value: string | undefined) => (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
function value(fields: Record<string, string>, key: string): string {
  const text = normalize(fields[key]);
  if (key === "username") return text.replace(/^@/, "");
  if (key === "profile_url" && text) {
    try { const url = new URL(text); url.hostname = url.hostname.replace(/^www\./, ""); url.hash = ""; return url.toString().replace(/\/$/, ""); } catch { return text; }
  }
  return text;
}

/** Missing values are not conflicts; common names/places alone never establish identity. */
export function exactProfileMatch(a: Record<string, string>, b: Record<string, string>): boolean {
  const platformA = canonicalPlatform(a), platformB = canonicalPlatform(b);
  if (platformA && platformB && platformA !== platformB) return false;
  const keys = ["username", "user_id", "profile_url", "display_name", "bio", "location", "website"];
  // "id:<field>" values come from columns the user marked as identifying one person.
  const chosen = Object.keys(a).filter(key => key.startsWith("id:") && value(a, key) && value(b, key));
  const shared = [...keys, ...chosen].filter(key => value(a, key) && value(b, key));
  if (shared.some(key => value(a, key) !== value(b, key))) return false;
  if (chosen.length) return true;
  if (shared.includes("profile_url")) {
    try {
      const url = new URL(value(a, "profile_url"));
      if (["http:", "https:"].includes(url.protocol) && (url.pathname.length > 1 && !/^\/(?:users?|profiles?|people)\/?$/i.test(url.pathname) || url.searchParams.has("id"))) return true;
    } catch { /* A placeholder or malformed URL cannot establish identity. */ }
  }
  if (shared.includes("user_id") && !!(platformA || platformB)) return true;
  if (shared.includes("username") && !!(platformA || platformB)) return true;
  return shared.includes("username") && shared.some(key => key !== "username" && key !== "location");
}
