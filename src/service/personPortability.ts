/** Rewrite vault-relative links while moving a person's folder between vaults. */
export function relocatePersonText(text: string, source: string, destination: string): string {
  if (!source || source === destination) return text;
  return text.split(`${source}/`).join(`${destination}/`);
}

export function safeRelativePath(value: string): string {
  const path = value.replace(/\\/g, "/");
  if (!path || path.startsWith("/") || /^[a-z]:/i.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Invalid file path in person folder.");
  return path;
}
