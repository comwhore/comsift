const LEGACY_BLOCKS = [
  ["<!-- whereami:graph:start -->", "<!-- whereami:graph:end -->", "graph"],
  ["<!-- whereami:preserve:start -->", "<!-- whereami:preserve:end -->", "preserve"],
] as const;

export function safeName(value: string): string {
  const name = value.trim();
  const hasControl = [...name].some(char => char.charCodeAt(0) < 0x20);
  if (!name || name === "." || name === ".." || hasControl || /[\\/:*?"<>|]/.test(name) || /[. ]$/.test(name)) {
    throw new Error("Name is empty or contains characters invalid in a vault path.");
  }
  return name;
}

export function legacyPairId(content: string): string | null {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const id = frontmatter?.[1].match(/(?:^|\n)\s*id:\s*["']?([^"'\r\n]+)["']?/);
  return frontmatter?.[1].includes("whereami:") ? id?.[1]?.trim() ?? null : null;
}

/** Remove a legacy block only when its contents are confirmed present in the Canvas snapshot. */
export function stripLegacyBlocks(content: string, canvasRaw: string): string {
  let canvas: { nodes?: Array<{ id: string; text?: string }>; edges?: Array<{ id: string }> };
  try { canvas = JSON.parse(canvasRaw) as typeof canvas; } catch { return content; }
  if (!Array.isArray(canvas.nodes) || !Array.isArray(canvas.edges)) return content;
  let result = content;
  for (const [start, end, kind] of LEGACY_BLOCKS) {
    const begin = result.indexOf(start);
    const finish = result.indexOf(end, begin + start.length);
    if (begin < 0 || finish < 0) continue;
    const section = result.slice(begin + start.length, finish).trim();
    const json = section.match(/^```json\s*([\s\S]*?)\s*```$/);
    if (!json) continue;
    try {
      const parsed = JSON.parse(json[1]) as { nodes?: unknown; edges?: unknown; unsupportedNodes?: unknown; unsupportedEdges?: unknown };
      const nodes = kind === "graph" ? parsed.nodes : parsed.unsupportedNodes;
      const edges = kind === "graph" ? parsed.edges : parsed.unsupportedEdges;
      if (!Array.isArray(nodes) || !Array.isArray(edges)) continue;
      const nodesSafe = (nodes as Array<{ id?: string; text?: string }>).every(node => {
        const current = canvas.nodes!.find(candidate => candidate.id === node.id);
        return current && (node.text === undefined || current.text === node.text);
      });
      const edgesSafe = (edges as Array<{ id?: string }>).every(edge => canvas.edges!.some(candidate => candidate.id === edge.id));
      if (!nodesSafe || !edgesSafe) continue;
      result = result.slice(0, begin) + result.slice(finish + end.length);
    } catch { /* Unrecognized content remains in the note. */ }
  }
  return result;
}
