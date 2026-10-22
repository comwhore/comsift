// Pure attribution of files to the account they came from, and connection scores for profiles.
//
// A friend-list export named "<handle> <platform>.sheet.md" (or .csv) was exported FROM the account with that
// handle on that platform. When that account is a profile in the person's folder (a sub-account or another
// person's profile), the sheet belongs to that profile and so do its rows: the profile links to the sheet,
// every row profile links to the profile, and the person's note stops linking to the sheet and to rows that
// only came from such sheets. Maigret/Sherlock results ("<handle> <site> …") are attributed the same way by
// handle. `comsift_owner: "[[Profile]]"` on a file overrides detection (pointing it at the person's own note
// keeps the file the person's). A match with the person themselves (their aliases, accounts or folder name)
// keeps the file the person's too.
import type { LinkMap } from "./graphLogic";

export type OwnerKind = "primary" | "profile" | "file";

export interface OwnerNote {
  path: string;
  kind: OwnerKind;
  /** "platform|handle" (lowercase); "*|handle" matches any platform. */
  accounts: string[];
  /** Resolved `comsift_sources` (the files a profile's rows came from). */
  sources: string[];
  /** Resolved links the user or a Canvas arrow made (body, embeds, marks, properties; never generated lists). */
  links: string[];
  /** Resolved `comsift_owner` override. */
  owner?: string | null;
}

export interface OwnerPerson { folder: string; primary: string }

export interface Ownership {
  /** File → owning profile (or another person's note). Files the person owns themselves are absent. */
  owners: Map<string, string>;
  /** Links to write: owner → owned files, row profile → owner. */
  links: LinkMap;
  /** Notes the person's note no longer links to directly: they hang off an owner profile instead. */
  detached: Set<string>;
}

const PLATFORMS: Record<string, string> = { bsky: "bluesky", x: "twitter", "x.com": "twitter", "bsky.app": "bluesky" };

const normalizeHandle = (value: string) => value.trim().toLowerCase().replace(/^@/, "");
const normalizePlatform = (value: string) => {
  const raw = value.trim().toLowerCase().replace(/^www\./, "");
  return PLATFORMS[raw] ?? raw.replace(/\.(?:com|net|tv|app|org)$/, "");
};
const baseName = (path: string) => path.split("/").at(-1) ?? path;

/** "<handle> <platform>.sheet.md" / ".csv" → handle and platform. */
export function exportName(path: string): { handle: string; platform: string } | null {
  const match = baseName(path).match(/^(.+?)\s+([^\s]+?)(?:\s+\d+)?\.(?:sheet\.md|csv)$/i);
  if (!match) return null;
  const handle = normalizeHandle(match[1]);
  return handle && !/\s/.test(handle) ? { handle, platform: normalizePlatform(match[2]) } : null;
}

/** A Maigret/Sherlock result note ("<handle> <site> …" in the person's Maigret or Sherlock folder) → the handle. */
export function searchName(path: string): string | null {
  if (!/\/(?:Maigret|Sherlock)\/[^/]+\.md$/i.test(path)) return null;
  const handle = normalizeHandle(baseName(path).split(/\s+/)[0] ?? "");
  return handle && !/\.md$/i.test(handle) ? handle : null;
}

function personOf(path: string, people: OwnerPerson[]): OwnerPerson | null {
  let best: OwnerPerson | null = null;
  for (const person of people) {
    if (path.startsWith(person.folder + "/") && (!best || person.folder.length > best.folder.length)) best = person;
  }
  return best;
}

function handles(note: OwnerNote, platform: string | null): Set<string> {
  const out = new Set<string>();
  for (const account of note.accounts) {
    const split = account.indexOf("|");
    const kind = split < 0 ? "*" : account.slice(0, split);
    const handle = normalizeHandle(split < 0 ? account : account.slice(split + 1));
    if (!handle) continue;
    if (platform === null || kind === "*" || normalizePlatform(kind) === platform) out.add(handle);
  }
  return out;
}

/**
 * Who a file came from: `owner` override first, then the handle in its name matched against the person's own
 * note (keeps it theirs), profiles in the same person folder, then other people's notes.
 */
export function detectOwner(file: OwnerNote, notes: OwnerNote[], people: OwnerPerson[], byPath?: Map<string, OwnerNote>): string | null {
  const person = personOf(file.path, people);
  if (!person) return null;
  if (file.owner && file.owner !== file.path) return file.owner === person.primary ? null : file.owner;
  const parsed = exportName(file.path);
  const handle = parsed?.handle ?? searchName(file.path);
  if (!handle) return null;
  const platform = parsed ? parsed.platform : null;
  const index = byPath ?? new Map(notes.map(note => [note.path, note]));
  const primary = index.get(person.primary);
  if (primary && handles(primary, platform).has(handle)) return null;
  if (normalizeHandle(baseName(person.folder)) === handle) return null;
  const match = (note: OwnerNote) => note.path !== file.path && handles(note, platform).has(handle);
  const order = (a: OwnerNote, b: OwnerNote) => a.path.length - b.path.length || a.path.localeCompare(b.path);
  const local = notes.filter(note => note.kind === "profile" && note.path.startsWith(person.folder + "/") && match(note)).sort(order);
  if (local.length) return local[0].path;
  const others = people.filter(other => other !== person).map(other => index.get(other.primary))
    .filter((note): note is OwnerNote => !!note && (match(note) || normalizeHandle(baseName(note.path).replace(/\.md$/i, "")) === handle)).sort(order);
  return others[0]?.path ?? null;
}

/** Owners of every file in a person folder, the links they imply, and what the person's note should drop. */
export function ownership(notes: OwnerNote[], people: OwnerPerson[]): Ownership {
  const byPath = new Map(notes.map(note => [note.path, note]));
  const owners = new Map<string, string>();
  for (const note of notes) {
    if (note.kind !== "file") continue;
    const owner = detectOwner(note, notes, people, byPath);
    if (owner) owners.set(note.path, owner);
  }
  const links: LinkMap = {};
  const add = (from: string, to: string) => { if (from !== to && !(links[from] ??= []).includes(to)) links[from].push(to); };
  for (const [file, owner] of owners) add(owner, file);
  const ownerSet = new Set(owners.values());
  const detached = new Set(owners.keys());
  for (const note of notes) {
    if (note.kind !== "profile" || !note.sources.length) continue;
    const from = note.sources.map(source => owners.get(source)).filter((owner): owner is string => !!owner && owner !== note.path);
    for (const owner of from) add(note.path, owner);
    // Rows that only came from owned exports hang off the owner; an owner itself stays the person's.
    if (from.length && from.length === note.sources.length && !ownerSet.has(note.path)) detached.add(note.path);
  }
  // Files the user linked to (or from) one profile and the person's note never linked by hand belong to it.
  const primaries = new Set(people.map(person => person.primary));
  const profileLinks = new Map<string, number>();
  for (const note of notes) profileLinks.set(note.path, note.links.filter(target => byPath.get(target)?.kind === "profile").length);
  for (const [file, attached] of ownFiles(notes, byPath)) {
    if (!attached.size || detached.has(file)) continue;
    const person = personOf(file, people);
    if (!person || [...primaries].some(primary => byPath.get(primary)?.links.includes(file))) continue;
    if ((profileLinks.get(file) ?? 0) > 3) continue;
    detached.add(file);
  }
  return { owners, links, detached };
}

/**
 * Non-profile files each profile links to or is linked from by hand (a file linking to more than three
 * profiles is a list, not someone's file). Map: file → profiles it belongs to.
 */
function ownFiles(notes: OwnerNote[], byPath: Map<string, OwnerNote>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const isFile = (path: string) => { const kind = byPath.get(path)?.kind; return kind === undefined || kind === "file"; };
  const attach = (file: string, profile: string) => { if (!/\.canvas$/i.test(file)) (out.get(file) ?? out.set(file, new Set()).get(file)!).add(profile); };
  for (const note of notes) {
    if (note.kind === "profile") {
      for (const target of note.links) if (isFile(target) && !note.sources.includes(target)) attach(target, note.path);
    } else if (note.kind === "file") {
      const profiles = note.links.filter(target => byPath.get(target)?.kind === "profile");
      if (profiles.length <= 3) for (const profile of profiles) attach(note.path, profile);
    }
  }
  return out;
}

export interface ConnectionScore { score: number; people: number; files: number; sources: number; rows: number }

/**
 * Connection score per profile: distinct people/profiles linked by hand (marks, arrows, links) either way,
 * its own files (linked by hand or exported from it), source origins beyond the first it appears in (one per
 * owner account, or per export when nobody owns it; a CSV and its sheet are one export), plus log2 of
 * the rows exported from it. A friend-list row seen once with nothing else scores 0.
 */
export function connectionScores(notes: OwnerNote[], owned: Ownership): Map<string, ConnectionScore> {
  const byPath = new Map(notes.map(note => [note.path, note]));
  const isPerson = (path: string) => { const kind = byPath.get(path)?.kind; return kind === "profile" || kind === "primary"; };
  const people = new Map<string, Set<string>>();
  const meet = (a: string, b: string) => {
    if (a === b) return;
    (people.get(a) ?? people.set(a, new Set()).get(a)!).add(b);
    (people.get(b) ?? people.set(b, new Set()).get(b)!).add(a);
  };
  for (const note of notes) {
    if (note.kind === "file") continue;
    for (const target of note.links) if (isPerson(target)) meet(note.path, target);
  }
  const files = new Map<string, Set<string>>();
  for (const [file, profiles] of ownFiles(notes, byPath)) for (const profile of profiles) (files.get(profile) ?? files.set(profile, new Set()).get(profile)!).add(file);
  for (const [file, owner] of owned.owners) (files.get(owner) ?? files.set(owner, new Set()).get(owner)!).add(file);
  const rows = new Map<string, number>();
  for (const note of notes) {
    if (note.kind !== "profile") continue;
    for (const owner of new Set(note.sources.map(source => owned.owners.get(source)).filter((value): value is string => !!value && value !== note.path))) {
      rows.set(owner, (rows.get(owner) ?? 0) + 1);
    }
  }
  const out = new Map<string, ConnectionScore>();
  for (const note of notes) {
    if (note.kind !== "profile") continue;
    const peopleCount = people.get(note.path)?.size ?? 0;
    const fileCount = files.get(note.path)?.size ?? 0;
    // One origin per owner (or per export: "x.csv" and "x.sheet.md" are the same list).
    const sources = new Set(note.sources.map(source => owned.owners.get(source) ?? source.replace(/\.(?:sheet\.md|csv|md)$/i, ""))).size;
    const rowCount = rows.get(note.path) ?? 0;
    const score = peopleCount + fileCount + Math.max(0, sources - 1) + (rowCount ? Math.log2(1 + rowCount) : 0);
    out.set(note.path, { score: Math.round(score * 10) / 10, people: peopleCount, files: fileCount, sources, rows: rowCount });
  }
  return out;
}

export const MAX_SIZE_MULTIPLIER = 2.5;

/** Clew size multiplier for a score: 1 + 0.25 per point, capped at 2.5×, in Clew's 0.1 slider steps. */
export function sizeMultiplier(score: number): number {
  return Math.round(Math.min(MAX_SIZE_MULTIPLIER, 1 + 0.25 * Math.max(0, score)) * 10) / 10;
}

/**
 * Read helper for person cards: owned files per owner from the stored owner links (`graphSources.owners`,
 * i.e. `Ownership.links`). Row → owner links point at profiles and are left out.
 */
export function ownedFilesByOwner(links: LinkMap | undefined, isNote: (path: string) => boolean): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [owner, targets] of Object.entries(links ?? {})) {
    const files = targets.filter(target => !isNote(target));
    if (files.length) out.set(owner, files);
  }
  return out;
}
