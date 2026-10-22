// What a person's own Canvas says about other files: typed arrows from the main node, followed through
// "same person" chains. Used so profiles made from a file (e.g. a Maigret result) inherit the arrow's type.
import type ComsiftPlugin from "../main";
import type { Investigation } from "./investigation";
import { arrowType, canvasLinks, MAIN_NODE_IDS, parseCanvas, type CanvasData, type CanvasEdge, type TypedLink } from "./canvasModel";
import type { SetMarkType } from "./personMarks";

/** Path → relation to the person. Anything joined to the main node by same-person arrows is "same". */
export function canvasRelationMap(links: TypedLink[], primary: string): Map<string, SetMarkType> {
  const same = new Set([primary]);
  const queue = [primary];
  for (let index = 0; index < queue.length; index++) {
    for (const link of links) {
      if (link.type !== "same") continue;
      const other = link.from === queue[index] ? link.to : link.to === queue[index] ? link.from : null;
      if (other && !same.has(other)) { same.add(other); queue.push(other); }
    }
  }
  const out = new Map<string, SetMarkType>();
  for (const path of same) if (path !== primary) out.set(path, "same");
  for (const link of links) {
    if (link.type !== "related" && link.type !== "uncertain") continue;
    const other = same.has(link.from) ? link.to : same.has(link.to) ? link.from : null;
    if (!other || same.has(other)) continue;
    if (out.get(other) !== "related") out.set(other, link.type);
  }
  return out;
}

export async function personCanvasRelations(plugin: ComsiftPlugin, item: Investigation): Promise<Map<string, SetMarkType>> {
  const canvas = plugin.app.vault.getFileByPath(plugin.investigations.canvasPath(item));
  if (!canvas) return new Map();
  try {
    const primary = plugin.investigations.mdPath(item);
    return canvasRelationMap(canvasLinks(parseCanvas(await plugin.app.vault.cachedRead(canvas)), primary, item.folderPath.split("/").at(-1)), primary);
  } catch { return new Map(); }
}

/** Only explicit account arrows establish an account relationship.
 * A sheet/report can contain many unrelated people; its relation must never identify every row.
 * `sources` remains an argument for callers that also track provenance.
 */
export function inheritedRelation(map: Map<string, SetMarkType>, path: string, _sources: string[]): SetMarkType | null {
  return map.get(path) ?? null;
}

/** Clear the typed paths that establish a displayed relationship, retaining layout and plain links. */
export function clearCanvasRelation(data: CanvasData, primary: string, left: string, right: string, personName?: string): boolean {
  const relationMap = canvasRelationMap(canvasLinks(data, primary, personName), primary);
  const account = left === primary ? right : right === primary ? left : null;
  const endpoints = new Set([account ? primary : right]);
  // A main-person relationship can be established through an explicitly same-person account.
  if (account && relationMap.has(account)) {
    for (const [path, type] of relationMap) if (type === "same" && path !== account) endpoints.add(path);
  }
  const startPath = account ?? left;
  const fileOf = new Map<string, string>();
  for (const node of data.nodes) {
    if (node.type === "file" && node.file) fileOf.set(node.id, node.file);
    else if (MAIN_NODE_IDS.includes(node.id)) fileOf.set(node.id, primary);
  }
  const adjacency = new Map<string, Array<{ node: string; edge: CanvasEdge }>>();
  for (const edge of data.edges) {
    for (const [from, to] of [[edge.fromNode, edge.toNode], [edge.toNode, edge.fromNode]]) {
      const next = adjacency.get(from) ?? [];
      next.push({ node: to, edge }); adjacency.set(from, next);
    }
  }
  const cleared = new Set<CanvasEdge>();
  const seek = (id: string, path: CanvasEdge[], seen: Set<string>) => {
    const endpoint = fileOf.get(id);
    if (endpoint && path.length) {
      if (endpoints.has(endpoint)) for (const edge of path) if (arrowType(edge, personName) !== "normal") cleared.add(edge);
      return;
    }
    for (const next of adjacency.get(id) ?? []) {
      if (seen.has(next.node)) continue;
      seek(next.node, [...path, next.edge], new Set([...seen, next.node]));
    }
  };
  for (const [id, path] of fileOf) if (path === startPath) seek(id, [], new Set([id]));
  for (const edge of cleared) { edge.comsift_type = "normal"; delete edge.label; }
  return cleared.size > 0;
}
