/** Stable GitHub releases only. Never treat a prerelease as a newer stable version. */
export const RELEASES_URL = "https://github.com/comwhore/comsift/releases";
export const RELEASE_API = "https://api.github.com/repos/comwhore/comsift/releases/latest";

export function newerVersion(installed: string, available: string): boolean {
  const parse = (value: string) => /^v?(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/.exec(value.trim())?.slice(1).map(Number);
  const next = parse(available);
  // A stable release supersedes the same version's prerelease.
  const current = parse(installed.replace(/-[\w.-]+(?:\+[\w.-]+)?$/, ""));
  if (!current || !next) return false;
  for (let index = 0; index < 3; index++) {
    if (next[index] !== current[index]) return next[index] > current[index];
  }
  return installed.includes("-");
}

export function releaseVersion(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const release = value as { tag_name?: unknown; prerelease?: unknown; draft?: unknown };
  if (release.prerelease || release.draft || typeof release.tag_name !== "string") return null;
  return /^v?\d+\.\d+\.\d+(?:\+[\w.-]+)?$/.test(release.tag_name) ? release.tag_name.replace(/^v/, "") : null;
}
