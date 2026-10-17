// Pure computation of Graph View colors: who owns which note, at what distance, in what color.
import { hashColor, mix, mixAll, shade } from "./colors";

export interface ColorPerson { id: string; folder: string; color: string; tag: string }
export interface ColorOptions { depth: number; fade: number; bridgeMode: "neutral" | "mix"; bridgeColor: string; personaMix: number }
export interface NoteColor { color: string; owners: string[]; distance: number; persona?: boolean }
export interface ColorGroup { query: string; color: string }

const PATHS_PER_GROUP = 40;

function quote(path: string): string { return `path:"${path.replace(/"/g, '\\"')}"`; }

export function ownerOf(path: string, people: ColorPerson[]): ColorPerson | null {
  let best: ColorPerson | null = null;
  for (const person of people) {
    if (!path.startsWith(person.folder + "/")) continue;
    if (!best || person.folder.length > best.folder.length) best = person;
  }
  return best;
}

/** Connected groups (two or more) of profile notes linked to each other inside one person's Analysis/Profiles. */
export function personaClusters(paths: string[], edges: Array<[string, string]>, person: ColorPerson): string[][] {
  const prefix = `${person.folder}/Analysis/Profiles/`;
  const members = new Set(paths.filter(path => path.startsWith(prefix)));
  const parent = new Map<string, string>([...members].map(path => [path, path]));
  const find = (path: string): string => {
    let root = path;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(path, root);
    return root;
  };
  for (const [a, b] of edges) if (members.has(a) && members.has(b)) parent.set(find(a), find(b));
  const groups = new Map<string, string[]>();
  for (const path of members) groups.set(find(path), [...(groups.get(find(path)) ?? []), path]);
  return [...groups.values()].filter(group => group.length >= 2).map(group => group.sort());
}

/**
 * `claimed` marks notes outside a person's folder as theirs (Canvas arrows of type "same person");
 * they get the person's color and count as the person's own notes for distances.
 */
export function computeColors(people: ColorPerson[], paths: string[], edges: Array<[string, string]>,
  options: ColorOptions, claimed: Array<[string, string]> = []): { notes: Map<string, NoteColor>; groups: ColorGroup[] } {
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

  const personaGroups: ColorGroup[] = [];
  for (const person of people) {
    for (const cluster of personaClusters(paths, edges, person)) {
      const color = mix(hashColor(cluster[0]), person.color, options.personaMix);
      cluster.forEach(path => notes.set(path, { color, owners: [person.id], distance: 0, persona: true }));
      for (let index = 0; index < cluster.length; index += PATHS_PER_GROUP) {
        personaGroups.push({ query: cluster.slice(index, index + PATHS_PER_GROUP).map(quote).join(" OR "), color });
      }
    }
  }

  const all = new Set([...paths, ...adjacency.keys()]);
  const owned = new Map<string, ColorPerson>();
  const byIdEarly = new Map(people.map(person => [person.id, person]));
  const claimedGroups = new Map<string, string[]>();
  for (const path of all) {
    const owner = ownerOf(path, people);
    if (!owner) continue;
    owned.set(path, owner);
    if (!notes.has(path)) notes.set(path, { color: owner.color, owners: [owner.id], distance: 0 });
  }
  for (const [path, id] of claimed) {
    const person = byIdEarly.get(id);
    if (!person || owned.has(path)) continue;
    owned.set(path, person);
    notes.set(path, { color: person.color, owners: [person.id], distance: 0 });
    claimedGroups.set(person.color, [...(claimedGroups.get(person.color) ?? []), path]);
  }

  // Breadth-first from each person's own notes through notes nobody owns.
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

  const byId = new Map(people.map(person => [person.id, person]));
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

  const groups: ColorGroup[] = [...personaGroups];
  for (const [color, members] of claimedGroups) {
    for (let index = 0; index < members.length; index += PATHS_PER_GROUP) {
      groups.push({ query: members.slice(index, index + PATHS_PER_GROUP).map(quote).join(" OR "), color });
    }
  }
  for (const [color, members] of shaded) {
    const sorted = members.sort();
    for (let index = 0; index < sorted.length; index += PATHS_PER_GROUP) {
      groups.push({ query: sorted.slice(index, index + PATHS_PER_GROUP).map(quote).join(" OR "), color });
    }
  }
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
