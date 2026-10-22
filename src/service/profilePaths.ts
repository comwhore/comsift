/** Current connection notes and the previous generated-profile layout. */
export function connectionScope(path: string): string | null {
  const match = path.match(/^(.*)\/(?:Analysis\/Profiles|Connections)\/[^/]+\.md$/i);
  return match?.[1] ?? null;
}
export function isConnectionProfile(path: string): boolean { return connectionScope(path) !== null; }

/** Breadth-first connection traversal; depth 1 is the selected person's immediate neighbors. */
export function connectionNeighborhood(source: string, links: Array<[string, string]>, depth: number): Map<string, number> {
  const adjacency = new Map<string, Set<string>>();
  for (const [a, b] of links) {
    if (a === b) continue;
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a)!.add(b); adjacency.get(b)!.add(a);
  }
  const found = new Map([[source, 0]]), queue = [source];
  const limit = Math.max(0, Math.min(10, Math.floor(Number.isFinite(depth) ? depth : 1)));
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index], distance = found.get(current)!;
    if (distance >= limit) continue;
    for (const next of adjacency.get(current) ?? []) if (!found.has(next)) { found.set(next, distance + 1); queue.push(next); }
  }
  return found;
}
