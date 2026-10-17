// Pure Canvas JSON helpers: arrow types, graph relationships through text nodes,
// removal of legacy Sherlock/Maigret group nodes, and a compact digest + edit operations for AI.
import { placeGroup } from "./placement";
import type { CanvasDirection as Direction } from "../module";

export type ArrowType = "normal" | "same" | "related" | "uncertain";
export interface CanvasNode {
  id: string; type?: string; x: number; y: number; width: number; height: number;
  text?: string; file?: string; color?: string; [key: string]: unknown;
}
export interface CanvasEdge {
  id: string; fromNode: string; toNode: string; fromSide?: string; toSide?: string;
  label?: string; color?: string; comsift_type?: ArrowType; [key: string]: unknown;
}
export interface CanvasData { nodes: CanvasNode[]; edges: CanvasEdge[]; [key: string]: unknown }

export const MAIN_NODE_IDS = ["comsift-main", "whereami-main"];
export const RELATED_LABEL = "related";
export const UNCERTAIN_LABEL = "uncertain";

export function parseCanvas(raw: string): CanvasData {
  try {
    const value = JSON.parse(raw) as Partial<CanvasData>;
    return { ...value, nodes: Array.isArray(value.nodes) ? value.nodes : [], edges: Array.isArray(value.edges) ? value.edges : [] };
  } catch { return { nodes: [], edges: [] }; }
}

/** Arrow type: explicit marker first, then the label. */
export function arrowType(edge: CanvasEdge, personName?: string): ArrowType {
  if (edge.comsift_type === "same" || edge.comsift_type === "related" || edge.comsift_type === "uncertain") return edge.comsift_type;
  const label = (edge.label ?? "").trim().toLowerCase();
  if (label === RELATED_LABEL) return "related";
  if (label === UNCERTAIN_LABEL) return "uncertain";
  if (personName && label === personName.trim().toLowerCase()) return "same";
  return "normal";
}

/** Return a copy of the edge with the given type; labels show the person's name or type. */
export function withArrowType(edge: CanvasEdge, type: ArrowType, personName: string, colors: { same: string; related: string; uncertain: string }): CanvasEdge {
  const next: CanvasEdge = { ...edge };
  delete next.comsift_type;
  const previous = arrowType(edge, personName);
  if (previous !== "normal") { delete next.label; delete next.color; }
  if (type === "same") Object.assign(next, { comsift_type: "same", label: personName, color: colors.same });
  if (type === "related") Object.assign(next, { comsift_type: "related", label: RELATED_LABEL, color: colors.related });
  if (type === "uncertain") Object.assign(next, { comsift_type: "uncertain", label: UNCERTAIN_LABEL, color: colors.uncertain });
  return next;
}

export interface TypedLink { from: string; to: string; type: ArrowType }

/**
 * File-to-file relationships, following arrows through text/group/link nodes so a chain
 * file → text → file still connects. The main node stands for the person's note.
 */
export function canvasLinks(data: CanvasData, primaryPath: string | null, personName?: string): TypedLink[] {
  const fileOf = new Map<string, string>();
  for (const node of data.nodes) {
    if (node.type === "file" && typeof node.file === "string") fileOf.set(node.id, node.file);
    else if (primaryPath && MAIN_NODE_IDS.includes(node.id)) fileOf.set(node.id, primaryPath);
  }
  const out = new Map<string, Array<{ to: string; type: ArrowType }>>();
  for (const edge of data.edges) {
    const list = out.get(edge.fromNode) ?? [];
    list.push({ to: edge.toNode, type: arrowType(edge, personName) });
    out.set(edge.fromNode, list);
  }
  const strongest = (a: ArrowType, b: ArrowType): ArrowType => a === "same" || b === "same" ? "same"
    : a === "related" || b === "related" ? "related"
    : a === "uncertain" || b === "uncertain" ? "uncertain" : "normal";
  const links = new Map<string, TypedLink>();
  for (const [start, from] of fileOf) {
    const stack: Array<{ id: string; type: ArrowType }> = (out.get(start) ?? []).map(next => ({ id: next.to, type: next.type }));
    const seen = new Set<string>([start]);
    while (stack.length) {
      const { id, type } = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const target = fileOf.get(id);
      if (target) {
        if (target !== from) {
          const key = `${from}\n${target}`;
          const prior = links.get(key);
          links.set(key, { from, to: target, type: prior ? strongest(prior.type, type) : type });
        }
        continue;
      }
      for (const next of out.get(id) ?? []) stack.push({ id: next.to, type: strongest(type, next.type) });
    }
  }
  return [...links.values()];
}

/** Every file placed on the Canvas. */
export function canvasFiles(data: CanvasData): string[] {
  return [...new Set(data.nodes.filter(node => node.type === "file" && typeof node.file === "string").map(node => node.file!))];
}

const TOOL_TITLES = ["Sherlock", "Maigret"];

/**
 * Old versions put a "Sherlock\nquery" / "Maigret\nquery" text node between the source and its results.
 * Remove those nodes and attach their results straight to the source node.
 */
export function flattenToolGroups(data: CanvasData): { data: CanvasData; removed: string[] } {
  const removed: string[] = [];
  let edges = [...data.edges];
  for (const node of data.nodes) {
    if (node.type !== "text" || typeof node.text !== "string") continue;
    const title = node.text.split("\n")[0]?.trim();
    if (!TOOL_TITLES.includes(title)) continue;
    const incoming = edges.filter(edge => edge.toNode === node.id);
    if (incoming.length !== 1) continue;
    const parent = incoming[0];
    edges = edges.filter(edge => edge.id !== parent.id).map(edge => edge.fromNode === node.id
      ? { ...edge, fromNode: parent.fromNode, fromSide: parent.fromSide ?? edge.fromSide } : edge)
      .filter(edge => edge.toNode !== node.id && edge.fromNode !== edge.toNode);
    removed.push(node.id);
  }
  if (!removed.length) return { data, removed };
  const unique = new Map<string, CanvasEdge>();
  for (const edge of edges) {
    const key = `${edge.fromNode}\n${edge.toNode}`;
    if (!unique.has(key)) unique.set(key, edge);
  }
  return { data: { ...data, nodes: data.nodes.filter(node => !removed.includes(node.id)), edges: [...unique.values()] }, removed };
}

// ------------------------------------------------------------------ AI digest and operations

export interface Digest { text: string; ids: Map<number, string>; edgeIds: Map<string, string> }

/** Compact text form of a Canvas for language models: small numeric ids instead of random ones. */
export function canvasDigest(data: CanvasData, options: { personName?: string; selected?: string[]; onlySelected?: boolean; maxText?: number } = {}): Digest {
  const selected = new Set(options.selected ?? []);
  let nodes = data.nodes;
  if (options.onlySelected) nodes = nodes.filter(node => selected.has(node.id));
  const ids = new Map<number, string>();
  const short = new Map<string, number>();
  nodes.forEach((node, index) => { ids.set(index + 1, node.id); short.set(node.id, index + 1); });
  const max = options.maxText ?? 160;
  const lines = nodes.map(node => {
    const n = short.get(node.id)!;
    const what = node.type === "file" ? `file="${node.file ?? ""}"`
      : node.type === "link" ? `link="${typeof node.url === "string" ? node.url : ""}"`
      : node.type === "group" ? `group="${typeof node.label === "string" ? node.label : ""}"`
      : `text=${JSON.stringify((node.text ?? "").replace(/\s+/g, " ").slice(0, max))}`;
    const flags = [MAIN_NODE_IDS.includes(node.id) ? "main" : "", selected.has(node.id) ? "selected" : ""].filter(Boolean).join(",");
    return `node ${n}${flags ? ` [${flags}]` : ""} ${what} x=${Math.round(node.x)} y=${Math.round(node.y)} w=${Math.round(node.width)} h=${Math.round(node.height)}`;
  });
  const edgeIds = new Map<string, string>();
  let count = 0;
  for (const edge of data.edges) {
    const from = short.get(edge.fromNode), to = short.get(edge.toNode);
    if (!from || !to) continue;
    const id = `e${++count}`;
    edgeIds.set(id, edge.id);
    const type = arrowType(edge, options.personName);
    lines.push(`edge ${id}: ${from} -> ${to} fromSide=${edge.fromSide ?? "auto"} toSide=${edge.toSide ?? "auto"} type=${type}${edge.label && type === "normal" ? ` label=${JSON.stringify(edge.label)}` : ""}`);
  }
  return { text: lines.join("\n"), ids, edgeIds };
}

export type CanvasOp =
  | { op: "add"; ref?: string; text?: string; file?: string; near?: number | string; direction?: Direction; type?: ArrowType; connect?: boolean; width?: number; height?: number }
  | { op: "move"; node: number | string; x?: number; y?: number; near?: number | string; direction?: Direction }
  | { op: "connect"; from: number | string; to: number | string; type?: ArrowType; fromSide?: string; toSide?: string }
  | { op: "disconnect"; edge?: string; from?: number | string; to?: number | string }
  | { op: "text"; node: number | string; text: string }
  | { op: "type"; edge?: string; edges?: string[]; from?: number | string; to?: number | string; type: ArrowType }
  | { op: "delete"; node: number | string }
  | { op: "arrange"; node: number | string; direction: Direction }
  | { op: "color"; node: number | string; color: string };

export interface OpContext {
  digest: Digest;
  personName: string;
  colors: { same: string; related: string; uncertain: string };
  newId: () => string;
  /** When set, operations may only touch these real node ids (plus nodes they create). */
  allowed?: Set<string>;
  gap?: number;
}

const OPPOSITE: Record<Direction, Direction> = { top: "bottom", bottom: "top", left: "right", right: "left" };
const DIRECTIONS: Direction[] = ["top", "bottom", "left", "right"];

/** Apply model-proposed operations to a copy of the Canvas; returns the result and a readable summary. */
export function applyCanvasOps(data: CanvasData, ops: CanvasOp[], context: OpContext): { data: CanvasData; summary: string[] } {
  const nodes = data.nodes.map(node => ({ ...node }));
  let edges = data.edges.map(edge => ({ ...edge }));
  const refs = new Map<string, string>();
  const visibleIds = new Set(context.digest.ids.values());
  const created = new Set<string>();
  const summary: string[] = [];
  const gap = context.gap ?? 80;
  const label = (id: string) => {
    const node = nodes.find(entry => entry.id === id);
    const text = node?.file ?? node?.text ?? id;
    return `“${text.split("\n")[0].slice(0, 40)}”`;
  };
  const resolve = (value: number | string | undefined, what: string): string => {
    if (value === undefined || value === null || value === "") throw new Error(`Missing ${what}.`);
    const raw = String(value).trim();
    // Literal aliases (including "node1") take priority; only human-readable "node 1" is normalized.
    const key = raw.replace(/^node\s+/i, "");
    const real = refs.get(raw) ?? (visibleIds.has(raw) ? raw : undefined) ?? refs.get(key)
      ?? context.digest.ids.get(Number(key)) ?? (visibleIds.has(key) ? key : undefined);
    if (!real || !nodes.some(node => node.id === real)) throw new Error(`Unknown node ${key}.`);
    if (context.allowed && !context.allowed.has(real) && !created.has(real)) throw new Error(`Node ${key} is outside the selection.`);
    return real;
  };
  const edgeOf = (value: string) => {
    const real = context.digest.edgeIds.get(value) ?? value;
    const edge = edges.find(entry => entry.id === real);
    if (!edge) throw new Error(`Unknown edge ${value}.`);
    return edge;
  };
  const direction = (value: unknown, fallback: Direction): Direction => DIRECTIONS.includes(value as Direction) ? value as Direction : fallback;
  const connect = (from: string, to: string, type: ArrowType, fromSide?: string, toSide?: string) => {
    if (from === to) throw new Error("A node cannot connect to itself.");
    const existing = edges.find(edge => edge.fromNode === from && edge.toNode === to);
    const base: CanvasEdge = existing ?? { id: context.newId(), fromNode: from, toNode: to };
    if (fromSide) base.fromSide = fromSide;
    if (toSide) base.toSide = toSide;
    const typed = withArrowType(base, type, context.personName, context.colors);
    edges = existing ? edges.map(edge => edge.id === existing.id ? typed : edge) : [...edges, typed];
  };

  for (const op of ops) {
    switch (op.op) {
      case "add": {
        if (!op.text && !op.file) throw new Error("New nodes need text or a file.");
        const anchorId = op.near !== undefined ? resolve(op.near, "anchor") : undefined;
        const anchor = nodes.find(node => node.id === anchorId);
        const size = { width: op.width ?? (op.file ? 400 : 260), height: op.height ?? (op.file ? 400 : 80) };
        const side = direction(op.direction, "right");
        const position = anchor ? placeGroup(anchor, size, side, gap, nodes) : { x: 0, y: 0 };
        const id = context.newId();
        nodes.push({ id, type: op.file ? "file" : "text", ...(op.file ? { file: op.file } : { text: op.text }), ...position, ...size });
        created.add(id);
        if (op.ref) {
          const ref = String(op.ref).trim();
          if (refs.has(ref) || visibleIds.has(ref) || context.digest.ids.has(Number(ref))) throw new Error(`Node reference ${ref} is already in use.`);
          refs.set(ref, id);
        }
        if (anchorId && op.connect !== false) connect(anchorId, id, op.type ?? "normal", side, OPPOSITE[side]);
        summary.push(`Add ${op.file ? `file ${op.file}` : `node “${(op.text ?? "").slice(0, 40)}”`}${anchor ? ` ${side} of ${label(anchor.id)}` : ""}`);
        break;
      }
      case "move": {
        const id = resolve(op.node, "node");
        const node = nodes.find(entry => entry.id === id)!;
        if (op.near !== undefined) {
          const anchor = nodes.find(entry => entry.id === resolve(op.near, "anchor"))!;
          Object.assign(node, placeGroup(anchor, node, direction(op.direction, "right"), gap, nodes.filter(entry => entry.id !== id)));
        } else {
          if (typeof op.x === "number") node.x = op.x;
          if (typeof op.y === "number") node.y = op.y;
        }
        summary.push(`Move ${label(id)}`);
        break;
      }
      case "connect": {
        const from = resolve(op.from, "from"), to = resolve(op.to, "to");
        connect(from, to, op.type ?? "normal", op.fromSide, op.toSide);
        summary.push(`Connect ${label(from)} → ${label(to)}${op.type && op.type !== "normal" ? ` (${op.type})` : ""}`);
        break;
      }
      case "disconnect": {
        const target = op.edge ? edgeOf(op.edge)
          : edges.find(edge => edge.fromNode === resolve(op.from, "from") && edge.toNode === resolve(op.to, "to"));
        if (!target) throw new Error("No such arrow.");
        edges = edges.filter(edge => edge.id !== target.id);
        summary.push(`Remove arrow ${label(target.fromNode)} → ${label(target.toNode)}`);
        break;
      }
      case "text": {
        const id = resolve(op.node, "node");
        const node = nodes.find(entry => entry.id === id)!;
        if (node.type === "file") throw new Error("File nodes have no text; edit the file instead.");
        node.text = op.text;
        summary.push(`Change text of ${label(id)}`);
        break;
      }
      case "type": {
        const targets = [...(op.edges ?? []), ...(op.edge ? [op.edge] : [])].map(edgeOf);
        if (op.from !== undefined && op.to !== undefined) {
          const from = resolve(op.from, "from"), to = resolve(op.to, "to");
          const found = edges.find(edge => edge.fromNode === from && edge.toNode === to);
          if (found) targets.push(found);
        }
        if (!targets.length) throw new Error("No arrow to retype.");
        for (const target of targets) {
          if (context.allowed && !context.allowed.has(target.fromNode) && !context.allowed.has(target.toNode)) throw new Error("Arrow is outside the selection.");
          edges = edges.map(edge => edge.id === target.id ? withArrowType(edge, op.type, context.personName, context.colors) : edge);
        }
        summary.push(`Set ${targets.length} arrow${targets.length === 1 ? "" : "s"} to ${op.type}`);
        break;
      }
      case "delete": {
        const id = resolve(op.node, "node");
        if (MAIN_NODE_IDS.includes(id)) throw new Error("The person's main node cannot be deleted.");
        summary.push(`Delete ${label(id)}`);
        const index = nodes.findIndex(node => node.id === id);
        nodes.splice(index, 1);
        edges = edges.filter(edge => edge.fromNode !== id && edge.toNode !== id);
        break;
      }
      case "arrange": {
        const id = resolve(op.node, "node");
        const parent = nodes.find(entry => entry.id === id)!;
        const side = direction(op.direction, "right");
        const children = edges.filter(edge => edge.fromNode === id).map(edge => nodes.find(node => node.id === edge.toNode))
          .filter((node): node is CanvasNode => !!node && !MAIN_NODE_IDS.includes(node.id));
        if (!children.length) throw new Error(`${label(id)} has no outgoing arrows to arrange.`);
        const vertical = side === "left" || side === "right";
        const total = children.reduce((sum, child) => sum + (vertical ? child.height : child.width), 0) + gap / 4 * (children.length - 1);
        const block = vertical ? { width: Math.max(...children.map(child => child.width)), height: total }
          : { width: total, height: Math.max(...children.map(child => child.height)) };
        const others = nodes.filter(node => node.id !== id && !children.includes(node));
        const origin = placeGroup(parent, block, side, gap, others);
        let offset = 0;
        for (const child of children) {
          if (vertical) { child.x = origin.x; child.y = origin.y + offset; offset += child.height + gap / 4; }
          else { child.x = origin.x + offset; child.y = origin.y; offset += child.width + gap / 4; }
        }
        edges = edges.map(edge => edge.fromNode === id && children.some(child => child.id === edge.toNode)
          ? { ...edge, fromSide: side, toSide: OPPOSITE[side] } : edge);
        summary.push(`Arrange ${children.length} node${children.length === 1 ? "" : "s"} ${side} of ${label(id)}`);
        break;
      }
      case "color": {
        const id = resolve(op.node, "node");
        nodes.find(entry => entry.id === id)!.color = op.color;
        summary.push(`Color ${label(id)}`);
        break;
      }
      default:
        throw new Error(`Unknown canvas operation ${JSON.stringify((op as { op?: unknown }).op)}.`);
    }
  }
  return { data: { ...data, nodes, edges }, summary };
}

/** Parse `<canvas path="…">[ …operations… ]</canvas>` blocks from a model answer. */
export function parseCanvasEdits(answer: string): { text: string; edits: Array<{ path: string; ops: CanvasOp[]; error?: string }> } {
  const edits: Array<{ path: string; ops: CanvasOp[]; error?: string }> = [];
  const text = answer.replace(/<canvas\s+path\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/canvas>/gi, (_all, path: string, body: string) => {
    const json = body.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
    try {
      const parsed = JSON.parse(json) as unknown;
      const ops = Array.isArray(parsed) ? parsed : (parsed as { ops?: unknown }).ops;
      if (!Array.isArray(ops)) throw new Error("Expected a JSON array of operations.");
      edits.push({ path, ops: ops as CanvasOp[] });
    } catch (error) {
      edits.push({ path, ops: [], error: (error as Error).message });
    }
    return "";
  });
  return { text: text.replace(/\n{3,}/g, "\n\n").trim(), edits };
}

export interface ReviewArrow {
  key: string;
  type: Exclude<ArrowType, "normal">;
  left: { path: string; dataset: string };
  right: { path: string; dataset: string };
}

/**
 * Mirror analysis reviews on the Canvas: profile notes become file nodes next to their dataset
 * (or the main node), joined by a same-person or related arrow. Arrows and nodes this function
 * created earlier are removed when their review no longer exists.
 */
export function syncReviewArrows(data: CanvasData, reviews: ReviewArrow[], options: {
  personName: string; colors: { same: string; related: string; uncertain: string }; newId: () => string; gap?: number;
}): { data: CanvasData; added: number; removed: number } {
  const gap = options.gap ?? 80;
  let nodes = data.nodes.map(node => ({ ...node }));
  let edges = data.edges.map(edge => ({ ...edge }));
  const wanted = new Set(reviews.map(review => review.key));
  const before = edges.length;
  edges = edges.filter(edge => typeof edge.comsift_review !== "string" || wanted.has(edge.comsift_review));
  let removed = before - edges.length;
  const main = nodes.find(node => MAIN_NODE_IDS.includes(node.id));
  const nodeFor = (path: string, dataset: string): CanvasNode => {
    const existing = nodes.find(node => node.type === "file" && node.file === path);
    if (existing) return existing;
    const anchor = nodes.find(node => node.type === "file" && node.file === dataset) ?? main ?? nodes[0];
    const size = { width: 300, height: 220 };
    const position = anchor ? placeGroup(anchor, size, "right", gap, nodes) : { x: 0, y: 0 };
    const node: CanvasNode = { id: options.newId(), type: "file", file: path, ...position, ...size, comsift_generated: true };
    nodes.push(node);
    if (anchor) edges.push({ id: options.newId(), fromNode: anchor.id, fromSide: "right", toNode: node.id, toSide: "left", comsift_review: `source:${path}` });
    return node;
  };
  let added = 0;
  for (const review of reviews) {
    const left = nodeFor(review.left.path, review.left.dataset);
    const right = nodeFor(review.right.path, review.right.dataset);
    const existing = edges.find(edge => edge.comsift_review === review.key ||
      (edge.fromNode === left.id && edge.toNode === right.id) || (edge.fromNode === right.id && edge.toNode === left.id));
    const base: CanvasEdge = existing ?? { id: options.newId(), fromNode: left.id, toNode: right.id };
    const typed = { ...withArrowType(base, review.type, options.personName, options.colors), comsift_review: review.key };
    if (existing) edges = edges.map(edge => edge.id === existing.id ? typed : edge);
    else { edges.push(typed); added++; }
  }
  // Keep "source" arrows only for generated nodes that still exist; drop generated nodes nothing points at.
  const reviewed = new Set(edges.filter(edge => typeof edge.comsift_review === "string" && !edge.comsift_review.startsWith("source:"))
    .flatMap(edge => [edge.fromNode, edge.toNode]));
  const orphans = new Set(nodes.filter(node => node.comsift_generated === true && !reviewed.has(node.id)).map(node => node.id));
  if (orphans.size) {
    nodes = nodes.filter(node => !orphans.has(node.id));
    const count = edges.length;
    edges = edges.filter(edge => !orphans.has(edge.fromNode) && !orphans.has(edge.toNode));
    removed += count - edges.length;
  }
  return { data: { ...data, nodes, edges }, added, removed };
}
