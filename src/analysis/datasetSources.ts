/** A linked CSV and spreadsheet are one analysis source. Prefer the spreadsheet. */
export function chooseDatasetSources<T extends { path: string }>(files: T[], links: Map<string, string | null>): { files: T[]; aliases: Map<string, string> } {
  const sorted = [...files].sort((a,b) => a.path.localeCompare(b.path));
  const aliases = new Map<string, string>(), bySource = new Map<string, string>();
  for (const file of sorted) {
    const source = links.get(file.path);
    if (!source) continue;
    const canonical = bySource.get(source) ?? file.path;
    bySource.set(source, canonical);
    aliases.set(source, canonical);
    if (file.path !== canonical) aliases.set(file.path, canonical);
  }
  return { files: sorted.filter(file => !aliases.has(file.path)), aliases };
}
export function canonicalDatasetPaths(paths: string[], aliases: Map<string, string>): string[] {
  return [...new Set(paths.map(path => {
    const index = path.indexOf("#");
    const base = index < 0 ? path : path.slice(0,index), tab = index < 0 ? "" : path.slice(index);
    return (aliases.get(base) ?? base) + tab;
  }))].sort();
}
