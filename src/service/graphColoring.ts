// Pure computation of Graph View colors: who owns which note, at what distance, in what color.
//
// Rules (also in README → "Graph View colors"):
// - Person: the primary note, the person's Canvas, and every note verified as the same person — "same person"
//   Canvas arrows or `comsift_same` marks linking to the person or to one of their verified notes, transitively —
//   get exactly the person color. A promoted profile is its own person (its own folder and color).
// - Custom people: connection profile notes (profile frontmatter, passed in as `profiles`) in a person's folder
//   that are joined to at least one other profile by same-person arrows/marks form an evidenced separate identity.
//   Each such cluster gets one color derived from the person color (hue turned, see `personaColor`); clusters
//   differ from each other and from the person.
// - Notable profiles: a lone profile whose connection score (fileOwners.ts: people linked by hand, own files,
//   extra sources, exported rows) reaches `importance` gets `notableShade` (one per person); in Clew it and
//   persona profiles also grow with the score (`sizeMultiplier`, at most 2.5×).
// - Everything else in the person's folder gets `memberShade` (the person color slightly darker if light, slightly
//   lighter if dark): lone profiles (friend-list rows, related/uncertain-marked connections), Sherlock/Maigret
//   results, Analysis, sheets, chats and other notes.
// - Notes outside folders are shaded by link distance from the person's notes (`shade`); related/uncertain arrows
//   and marks are links, so they sit one step away. Notes equally near two people get the bridge color/mix.
import { connectionScope } from "./profilePaths";
import { memberShade, mixAll, notableShade, personaColor, relatedShade, shade } from "./colors";
import { sizeMultiplier } from "./fileOwners";

export interface ColorPerson { id: string; folder: string; color: string; tag: string; primary?: string; canvas?: string }
/** `importance`: connection score from which a lone profile is notable (default 1). */
export interface ColorOptions { depth: number; fade: number; bridgeMode: "neutral" | "mix"; bridgeColor: string; personaMix: number; importance?: number }
/**
 * `persona`: a custom person's profile (2+ same-linked profiles); `notable`: a lone profile with enough
 * connections; `member`: any other non-person note in the folder. `size`: Clew size multiplier.
 */
export interface NoteColor { color: string; owners: string[]; distance: number; persona?: boolean; notable?: boolean; member?: boolean; related?: boolean; size?: number }
export interface ColorGroup { query: string; color: string }

const PATHS_PER_GROUP = 40;

function quote(path: string): string { return `path:"${path.replace(/"/g, '\\"')}"`; }

const baseName = (folder: string) => folder.split("/").at(-1) ?? folder;
export const primaryOf = (person: ColorPerson) => person.primary ?? `${person.folder}/${baseName(person.folder)}.md`;
export const canvasOf = (person: ColorPerson) => person.canvas ?? `${person.folder}/${baseName(person.folder)}.canvas`;

export function ownerOf(path: string, people: ColorPerson[]): ColorPerson | null {
  let best: ColorPerson | null = null;
  for (const person of people) {
    if (!path.startsWith(person.folder + "/")) continue;
    if (!best || person.folder.length > best.folder.length) best = person;
  }
  return best;
}

class Clusters {
  private parent = new Map<string, string>();
  find(path: string): string {
    if (!this.parent.has(path)) this.parent.set(path, path);
    let root = path;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let current = path;
    while (current !== root) { const next = this.parent.get(current)!; this.parent.set(current, root); current = next; }
    return root;
  }
  union(a: string, b: string) { const x = this.find(a), y = this.find(b); if (x !== y) this.parent.set(x, y); }
}

/**
 * Identity clusters of a person's profiles: `profiles` (default: notes in the connection folders) owned by
 * `person`, merged only by same-person edges. Singletons are clusters too.
 */
export function personaClusters(paths: string[], edges: Array<[string, string]>, person: ColorPerson, profiles?: string[]): string[][] {
  const candidates = profiles ?? paths.filter(path => connectionScope(path) !== null);
  const members = new Set(candidates.filter(path => path.startsWith(person.folder + "/") && path !== primaryOf(person)));
  const clusters = new Clusters();
  for (const [a, b] of edges) if (members.has(a) && members.has(b)) clusters.union(a, b);
  const groups = new Map<string, string[]>();
  for (const path of members) groups.set(clusters.find(path), [...(groups.get(clusters.find(path)) ?? []), path]);
  return [...groups.values()].map(group => group.sort());
}

function pushGroups(groups: ColorGroup[], paths: string[], color: string) {
  const sorted = [...paths].sort();
  for (let index = 0; index < sorted.length; index += PATHS_PER_GROUP) {
    groups.push({ query: sorted.slice(index, index + PATHS_PER_GROUP).map(quote).join(" OR "), color });
  }
}

/**
 * `claimed` pins notes to a person (`[path, personId]`); `samePersonEdges` are same-person arrows and marks
 * (any two notes); `profiles` lists real profile notes (default: every note in a connection folder).
 */
export function computeColors(people: ColorPerson[], paths: string[], edges: Array<[string, string]>,
  options: ColorOptions, claimed: Array<[string, string]> = [], samePersonEdges: Array<[string, string]> = [],
  profiles?: string[], scores: Map<string, number> = new Map(), relatedEdges: Array<[string, string]> = []): { notes: Map<string, NoteColor>; groups: ColorGroup[] } {
  const notes = new Map<string, NoteColor>();
  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a)!.add(b);
    adjacency.get(b)!.add(a);
  };
  edges.forEach(([a, b]) => link(a, b));
  relatedEdges.forEach(([a, b]) => link(a, b));
  const byId = new Map(people.map(person => [person.id, person]));
  const all = new Set([...paths, ...adjacency.keys()]);
  const profileSet = new Set(profiles ?? [...all].filter(path => connectionScope(path) !== null));
  // A person's primary note and Canvas always belong to that person, whatever links or marks say.
  const fixed = new Map<string, ColorPerson>();
  for (const person of people) { fixed.set(primaryOf(person), person); fixed.set(canvasOf(person), person); }
  for (const path of fixed.keys()) profileSet.delete(path);

  // Identity clusters across the vault: same-person edges, explicit claims (joined to the primary note).
  const clusters = new Clusters();
  for (const [a, b] of samePersonEdges) clusters.union(a, b);
  for (const [path, id] of claimed) { const person = byId.get(id); if (person) clusters.union(path, primaryOf(person)); }
  const clusterPerson = new Map<string, ColorPerson>();
  for (const person of people) {
    const root = clusters.find(primaryOf(person));
    if (!clusterPerson.has(root)) clusterPerson.set(root, person);
  }

  // Own notes: the person's color, distance 0.
  const own = new Map<string, ColorPerson>(fixed);
  for (const path of all) {
    if (own.has(path)) continue;
    const person = clusterPerson.get(clusters.find(path));
    if (!person) continue;
    const owner = ownerOf(path, people);
    // Inside another person's folder only a profile (an account) can be someone else's.
    if (owner && owner.id !== person.id && !profileSet.has(path)) continue;
    own.set(path, person);
  }
  const groups: ColorGroup[] = [];
  const ownGroups = new Map<string, string[]>();
  for (const [path, person] of own) {
    notes.set(path, { color: person.color, owners: [person.id], distance: 0 });
    ownGroups.set(person.id, [...(ownGroups.get(person.id) ?? []), path]);
  }

  // Profiles of other identities, one derived color per cluster.
  const usedColors = new Map<string, Set<string>>();
  const used = (person: ColorPerson) => {
    if (!usedColors.has(person.id)) usedColors.set(person.id, new Set([person.color, memberShade(person.color), notableShade(person.color)].map(color => color.toLowerCase())));
    return usedColors.get(person.id)!;
  };
  const personaSets = new Map<string, { person: ColorPerson; paths: string[] }>();
  for (const path of [...profileSet].sort()) {
    if (own.has(path) || !all.has(path)) continue;
    const owner = ownerOf(path, people);
    if (!owner) continue;
    const key = `${owner.id}\n${clusters.find(path)}`;
    const set = personaSets.get(key) ?? { person: owner, paths: [] };
    set.paths.push(path);
    personaSets.set(key, set);
  }
  const personaGroups: ColorGroup[] = [];
  const threshold = options.importance ?? 1;
  const size = (path: string) => { const score = scores.get(path) ?? 0; return score >= threshold && score > 0 ? sizeMultiplier(score) : undefined; };
  const notable = new Map<string, { person: ColorPerson; paths: string[] }>();
  for (const { person, paths: cluster } of personaSets.values()) {
    // A lone profile is a connection (e.g. a friend-list row), not an evidenced identity: notable when it has
    // enough connections of its own, otherwise the member shade below.
    if (cluster.length < 2) {
      const score = scores.get(cluster[0]) ?? 0;
      if (score <= 0 || score < threshold) continue;
      const entry = notable.get(person.id) ?? { person, paths: [] };
      entry.paths.push(cluster[0]);
      notable.set(person.id, entry);
      continue;
    }
    const taken = used(person);
    let color = person.color;
    for (let attempt = 0; attempt < 50 && taken.has(color.toLowerCase()); attempt++) {
      color = personaColor(person.color, cluster[0], options.personaMix, attempt);
    }
    taken.add(color.toLowerCase());
    for (const path of cluster) notes.set(path, { color, owners: [person.id], distance: 0, persona: true, ...(size(path) ? { size: size(path) } : {}) });
    pushGroups(personaGroups, cluster, color);
  }
  for (const { person, paths: lone } of notable.values()) {
    const color = notableShade(person.color);
    for (const path of lone) notes.set(path, { color, owners: [person.id], distance: 0, notable: true, size: size(path) });
    pushGroups(personaGroups, lone, color);
  }

  // A related profile and its same-person accounts share the family/partner shade.
  const relatedRoots = new Set(relatedEdges.flatMap(([a, b]) => [clusters.find(a), clusters.find(b)]));
  const relatedGroups: ColorGroup[] = [];
  for (const path of profileSet) {
    if (own.has(path) || !relatedRoots.has(clusters.find(path))) continue;
    const person = ownerOf(path, people);
    if (!person) continue;
    const color = relatedShade(person.color);
    notes.set(path, { color, owners: [person.id], distance: 0, related: true });
    pushGroups(relatedGroups, [path], color);
  }
  // Everything else in a person's folder: the member shade.
  const owned = new Map<string, ColorPerson>(own);
  const memberGroups = new Map<string, string[]>();
  for (const path of all) {
    if (owned.has(path)) continue;
    const owner = ownerOf(path, people);
    if (!owner) continue;
    owned.set(path, owner);
    if (notes.has(path)) continue;
    notes.set(path, { color: memberShade(owner.color), owners: [owner.id], distance: 0, member: true });
    memberGroups.set(owner.id, [...(memberGroups.get(owner.id) ?? []), path]);
  }

  // Breadth-first from each person's notes through notes nobody owns.
  const reach = new Map<string, Map<string, number>>();
  const depth = Math.max(1, Math.min(6, Math.round(options.depth)));
  for (const person of people) {
    let frontier = [...owned.entries()].filter(([, owner]) => owner.id === person.id).map(([path]) => path);
    const seen = new Set(frontier);
    for (let distance = 1; distance <= depth && frontier.length; distance++) {
      const next: string[] = [];
      for (const path of frontier) {
        for (const other of adjacency.get(path) ?? []) {
          if (seen.has(other) || owned.has(other)) continue;
          seen.add(other);
          next.push(other);
          if (!reach.has(other)) reach.set(other, new Map());
          reach.get(other)!.set(person.id, distance);
        }
      }
      frontier = next;
    }
  }
  const shaded = new Map<string, string[]>();
  for (const [path, distances] of reach) {
    const nearest = Math.min(...distances.values());
    const owners = [...distances.entries()].filter(([, distance]) => distance === nearest).map(([id]) => id);
    const colors = owners.map(id => byId.get(id)!.color);
    const color = owners.length === 1 ? shade(colors[0], nearest, options.fade)
      : options.bridgeMode === "mix" ? shade(mixAll(colors), nearest, options.fade) : options.bridgeColor;
    notes.set(path, { color, owners, distance: nearest });
    shaded.set(color, [...(shaded.get(color) ?? []), path]);
  }

  // Native Graph View: the first matching group wins, so specific path lists come before the tag fallback.
  groups.push(...relatedGroups, ...personaGroups);
  for (const person of people) pushGroups(groups, ownGroups.get(person.id) ?? [], person.color);
  for (const person of people) pushGroups(groups, memberGroups.get(person.id) ?? [], memberShade(person.color));
  for (const [color, members] of shaded) pushGroups(groups, members, color);
  for (const person of people) groups.push({ query: `tag:#${person.tag}`, color: person.color });
  return { notes, groups };
}

/** Line color between two notes: same person → nearer note's color, different people → bridge color/mix. */
export function linkColor(a: NoteColor | undefined, b: NoteColor | undefined, options: ColorOptions): string | null {
  if (!a && !b) return null;
  if (!a || !b) return (a ?? b)!.color;
  const shared = a.owners.filter(owner => b.owners.includes(owner));
  if (shared.length && a.owners.length === 1 && b.owners.length === 1) return a.distance <= b.distance ? a.color : b.color;
  if (shared.length) return a.owners.length > 1 ? a.color : b.color;
  return options.bridgeMode === "mix" ? mixAll([a.color, b.color]) : options.bridgeColor;
}

/** Color & size group in the Clew graph plugin's settings (only the fields Comsift writes). */
export interface ClewGroup {
  id: string; name: string; color: string; enabled: boolean; sizeMultiplier: number | null;
  criteria: Array<{ type: "folder"; folder: string } | { type: "filename"; query: string } | { type: "tag"; tags: string[] }>;
}

export const CLEW_GROUP_PREFIX = "comsift:";
const CLEW_NOTE_GROUP_LIMIT = 400;

interface ClewNote { path: string; name: string; folder: string; color: string; own: boolean; notable: boolean; size: number | null }

/** Clew's matching: folder criterion includes subfolders, filename criterion is a case-insensitive substring. */
const clewMatches = (group: ClewNote, note: ClewNote) =>
  (!group.folder || note.folder === group.folder || note.folder.startsWith(`${group.folder}/`)) &&
  note.name.toLowerCase().includes(group.name.toLowerCase());

/**
 * Clew matches groups with AND-only criteria and the first matching group wins, so path lists become
 * one group per note (folder + file name), ordered most specific first, then one group per person folder
 * (the member shade) and tag (the person color). The person's own notes are never dropped by the group limit,
 * and a note that a shorter-named group would catch with the wrong color gets its own group.
 */
export function clewGroups(people: Array<ColorPerson & { name: string }>, notes: Map<string, NoteColor>): ClewGroup[] {
  const all: ClewNote[] = [];
  for (const [path, note] of notes) {
    if (!/\.md$/i.test(path)) continue;
    const name = path.split("/").at(-1)!.replace(/\.md$/i, "");
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (!folder && name.length < 3) continue;
    const size = note.size && note.size !== 1 ? note.size : null;
    all.push({ path, name, folder, color: note.color, own: note.distance === 0 && !note.persona && !note.member && !note.notable && !note.related,
      notable: !!(note.notable || note.persona), size });
  }
  const fallback = (note: ClewNote) => {
    const owner = ownerOf(note.path, people);
    return owner ? memberShade(owner.color).toLowerCase() : null;
  };
  const order = (a: ClewNote, b: ClewNote) => b.name.length - a.name.length || a.path.localeCompare(b.path);
  const needed = all.filter(note => fallback(note) !== note.color.toLowerCase() || note.size !== null);
  // The person's notes first, then notable/persona profiles (largest first), then the rest.
  const notable = needed.filter(note => !note.own && note.notable).sort((a, b) => (b.size ?? 1) - (a.size ?? 1) || order(a, b));
  const kept = [...needed.filter(note => note.own), ...notable, ...needed.filter(note => !note.own && !note.notable).sort(order)].slice(0, CLEW_NOTE_GROUP_LIMIT);
  const chosen = new Set(kept.map(note => note.path));
  for (let round = 0; round < 5; round++) {
    const sorted = [...kept].sort(order);
    const extra = all.filter(note => {
      if (chosen.has(note.path)) return false;
      const first = sorted.find(group => clewMatches(group, note));
      return !!first && (first.color.toLowerCase() !== note.color.toLowerCase() || first.size !== note.size);
    });
    if (!extra.length) break;
    for (const note of extra) { chosen.add(note.path); kept.push(note); }
  }
  const noteGroups: ClewGroup[] = kept.sort(order).map(note => ({ id: `${CLEW_GROUP_PREFIX}${note.path}`, name: `Comsift · ${note.name}`,
    color: note.color, enabled: true, sizeMultiplier: note.size,
    criteria: [...(note.folder ? [{ type: "folder" as const, folder: note.folder }] : []), { type: "filename" as const, query: note.name }] }));
  const sorted = [...people].sort((a, b) => b.folder.length - a.folder.length);
  return [
    ...noteGroups,
    ...sorted.map(person => ({ id: `${CLEW_GROUP_PREFIX}folder:${person.id}`, name: `Comsift · ${person.name}`, color: memberShade(person.color), enabled: true, sizeMultiplier: null,
      criteria: [{ type: "folder" as const, folder: person.folder }] })),
    ...sorted.map(person => ({ id: `${CLEW_GROUP_PREFIX}tag:${person.id}`, name: `Comsift · ${person.name} (tag)`, color: person.color, enabled: true, sizeMultiplier: null,
      criteria: [{ type: "tag" as const, tags: [`#${person.tag}`] }] })),
  ];
}

export interface PrimaryWeight { links: number; size: number }

/**
 * Each person's main note stands for everything that is theirs: it takes the link count of all notes
 * colored as the person's (and their neighbors) as its graph weight, and a Clew size multiplier relative
 * to its own links, at most 4×.
 */
export function primaryWeights(people: ColorPerson[], notes: Map<string, NoteColor>, edges: Array<[string, string]>): Map<string, PrimaryWeight> {
  const neighbors = new Map<string, Set<string>>();
  for (const [a, b] of edges) {
    if (a === b) continue;
    for (const [from, to] of [[a, b], [b, a]]) {
      const set = neighbors.get(from) ?? new Set<string>(); set.add(to); neighbors.set(from, set);
    }
  }
  const out = new Map<string, PrimaryWeight>();
  for (const person of people) {
    if (!person.primary) continue;
    const reached = new Set<string>();
    for (const [path, note] of notes) {
      if (note.owners.length !== 1 || note.owners[0] !== person.id) continue;
      reached.add(path);
      for (const other of neighbors.get(path) ?? []) reached.add(other);
    }
    reached.delete(person.primary);
    const own = neighbors.get(person.primary)?.size ?? 0;
    const links = Math.max(own, reached.size);
    out.set(person.primary, { links, size: Math.round(Math.min(4, Math.max(1, Math.sqrt((links + 1) / (own + 1)))) * 100) / 100 });
  }
  return out;
}
