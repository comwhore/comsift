import { canvasFingerprint } from "./canvasPreview";
import type { CanvasData, CanvasNode, CanvasEdge } from "./canvasModel";

export interface CanvasChange { label: string; before: CanvasData; after: CanvasData }
/** Apply only this operation's delta. Independent operations may be accepted in any order. */
export function applyCanvasChange(current: CanvasData, change: CanvasChange): CanvasData {
  const result = structuredClone(current);
  const patch = <T extends CanvasNode | CanvasEdge>(items: T[], before: T[], after: T[]): T[] => {
    const old = new Map(before.map(item => [item.id, item]));
    const next = new Map(after.map(item => [item.id, item]));
    const live = new Map(items.map(item => [item.id, item]));
    for (const id of new Set([...old.keys(), ...next.keys()])) {
      if (canvasFingerprint(old.get(id)) === canvasFingerprint(next.get(id))) continue;
      const previous = old.get(id), proposed = next.get(id), actual = live.get(id);
      const conflict = () => { throw new Error("This change depends on a previous change. Accept its prerequisite first or send a new request."); };
      if (!previous || !proposed) {
        // Creation/deletion needs the full prerequisite, including existence.
        if (canvasFingerprint(actual) !== canvasFingerprint(previous)) conflict();
        if (proposed) live.set(id, structuredClone(proposed)); else live.delete(id);
        continue;
      }
      if (!actual) conflict();
      const merged = structuredClone(actual!);
      for (const key of new Set([...Object.keys(previous), ...Object.keys(proposed)])) {
        const existed = Object.prototype.hasOwnProperty.call(previous, key), exists = Object.prototype.hasOwnProperty.call(proposed, key);
        if (existed === exists && canvasFingerprint(previous[key]) === canvasFingerprint(proposed[key])) continue;
        if (Object.prototype.hasOwnProperty.call(actual!, key) !== existed || canvasFingerprint(actual![key]) !== canvasFingerprint(previous[key])) conflict();
        if (exists) Object.defineProperty(merged, key, { value: structuredClone(proposed[key]), writable: true, enumerable: true, configurable: true });
        else delete merged[key];
      }
      live.set(id, merged);
    }
    return [...live.values()];
  };
  result.nodes = patch(result.nodes, change.before.nodes, change.after.nodes);
  result.edges = patch(result.edges, change.before.edges, change.after.edges);
  const ids = new Set(result.nodes.map(node => node.id));
  if (result.edges.some(edge => !ids.has(edge.fromNode) || !ids.has(edge.toNode))) throw new Error("Accept the connected nodes first.");
  return result;
}

/** Selected requests cannot alter other nodes or their arrows. Deletion necessarily removes incident arrows. */
export function assertCanvasSelection(before: CanvasData, after: CanvasData, selected: Set<string>): void {
  const originalIds = new Set(before.nodes.map(node => node.id));
  const remaining = new Map(after.nodes.map(node => [node.id, node]));
  for (const node of before.nodes) {
    if (!selected.has(node.id) && canvasFingerprint(node) !== canvasFingerprint(remaining.get(node.id))) throw new Error("Proposal changes nodes outside the captured selection.");
  }
  const allowed = (id: string) => selected.has(id) || !originalIds.has(id);
  const old = new Map(before.edges.map(edge => [edge.id, edge]));
  const next = new Map(after.edges.map(edge => [edge.id, edge]));
  for (const id of new Set([...old.keys(), ...next.keys()])) {
    const a = old.get(id), b = next.get(id);
    if (canvasFingerprint(a) === canvasFingerprint(b)) continue;
    if (a && !b && ((!remaining.has(a.fromNode) && selected.has(a.fromNode)) || (!remaining.has(a.toNode) && selected.has(a.toNode)))) continue;
    for (const edge of [a, b]) if (edge && (!allowed(edge.fromNode) || !allowed(edge.toNode))) throw new Error("Proposal changes arrows outside the captured selection.");
  }
}
