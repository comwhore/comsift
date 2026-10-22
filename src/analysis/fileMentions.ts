/** Explicit references remain readable in saved conversations. */
export function mentionedPaths(text: string): string[] {
  const paths: string[] = [];
  const pattern = /@\[\[([^\]\n]+)\]\]|@"([^"\n]+)"|(?:^|\s)@([^\s@"[\]]+\.[a-zA-Z0-9]+)/g;
  for (const match of text.matchAll(pattern)) {
    const path = (match[1] ?? match[2] ?? match[3]).trim();
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

/** Folders are mentioned as `@[[Folder/]]` (trailing slash); returns them without the slash. */
export function mentionedFolders(text: string): string[] {
  return mentionedPaths(text).filter(path => path.endsWith("/") && path.length > 1).map(path => path.replace(/\/+$/, ""));
}

/** Empty picker queries keep the selected person's files ahead of the rest of the vault. */
export function prioritizeMentionFiles<T extends { path: string }>(files: T[], folder: string): T[] {
  const scope = folder.replace(/\/+$/, "");
  const inside = (path: string) => !!scope && path.startsWith(`${scope}/`);
  return [...files].sort((a, b) => Number(inside(b.path)) - Number(inside(a.path)) || a.path.localeCompare(b.path));
}

/** A file counts as mentioned when the user typed an @ reference, its full path or a [[wiki link]] to it. */
export function fileMentioned(text: string, path: string): boolean {
  const mentions = mentionedPaths(text);
  if (mentions.includes(path) || mentions.some(mention => mention.endsWith("/") && path.startsWith(mention))) return true;
  const lower = text.toLowerCase();
  if (lower.includes(path.toLowerCase())) return true;
  const base = (path.split("/").pop() ?? path).replace(/\.[^.]+$/, "").toLowerCase();
  return !!base && [...lower.matchAll(/\[\[([^\]|#\n]+)/g)].some(link => {
    const target = link[1].trim().replace(/\.[^./]+$/, "");
    return target === base || target === path.toLowerCase().replace(/\.[^./]+$/, "");
  });
}
