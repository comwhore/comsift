// Pure Canvas JSON helpers: arrow types, graph relationships through text nodes,
// removal of legacy Sherlock/Maigret group nodes, and a compact digest + edit operations for AI.
import { connectionSides, placeGroup } from "./placement";
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
export interface CanvasEdgeStyle { path?: "solid" | "long-dashed" | "short-dashed" | "dotted"; arrow?: "triangle" | "triangle-outline" | "thin-triangle" | "halved-triangle" | "diamond" | "diamond-outline" | "circle" | "circle-outline" | "blunt"; pathfindingMethod?: "bezier" | "direct" | "square" | "a-star" }
type EdgeOptions = { label?: string; color?: string; fromSide?: string; toSide?: string; fromEnd?: "none" | "arrow"; toEnd?: "none" | "arrow"; styleAttributes?: CanvasEdgeStyle };

const STYLE_ALIASES: Record<string, Record<string, string>> = {
  path: { dashed: "short-dashed", dash: "short-dashed", dashes: "short-dashed", "short-dash": "short-dashed", "short-dashed": "short-dashed", "long-dash": "long-dashed", "long-dashed": "long-dashed", dotted: "dotted", dot: "dotted", dots: "dotted", solid: "solid", line: "solid", plain: "solid", normal: "solid", default: "solid" },
  pathfindingMethod: { bezier: "bezier", curved: "bezier", curve: "bezier", straight: "direct", direct: "direct", square: "square", elbow: "square", orthogonal: "square", "right-angle": "square", "a-star": "a-star", astar: "a-star" },
};
const slug = (value: unknown) => String(value).trim().toLowerCase().replace(/[\s_]+/g, "-");

/** Models name arrow styles and directions many ways; map the common ones to the supported options. */
function normalizeEdgeOptions(input: EdgeOptions): EdgeOptions {
  const op = { ...input } as Record<string, unknown>;
  const styles: Record<string, unknown> = op.styleAttributes && typeof op.styleAttributes === "object" && !Array.isArray(op.styleAttributes) ? { ...op.styleAttributes as Record<string, unknown> } : {};
  for (const [from, to] of [["style", "path"], ["lineStyle", "path"], ["line", "path"], ["pathStyle", "path"], ["routing", "pathfindingMethod"], ["pathfinding", "pathfindingMethod"], ["arrowhead", "arrow"], ["head", "arrow"]] as const) {
    if (typeof op[from] === "string" && styles[to] === undefined) styles[to] = op[from];
    delete op[from];
  }
  if (op.dashed === true && styles.path === undefined) styles.path = "short-dashed";
  if (op.dotted === true && styles.path === undefined) styles.path = "dotted";
  delete op.dashed; delete op.dotted;
  for (const key of Object.keys(styles)) {
    const aliases = STYLE_ALIASES[key];
    if (aliases && typeof styles[key] === "string") styles[key] = aliases[slug(styles[key])] ?? styles[key];
    else if (key === "arrow" && typeof styles[key] === "string") styles[key] = slug(styles[key]);
  }
  if (Object.keys(styles).length) op.styleAttributes = styles;
  const mode = typeof op.arrows === "string" ? slug(op.arrows) : typeof op.direction === "string" ? slug(op.direction) : op.bidirectional === true ? "both" : op.reverse === true ? "reverse" : "";
  const ends: Record<string, ["none" | "arrow", "none" | "arrow"]> = { both: ["arrow", "arrow"], bidirectional: ["arrow", "arrow"], reverse: ["arrow", "none"], backward: ["arrow", "none"], reversed: ["arrow", "none"], forward: ["none", "arrow"], none: ["none", "none"], line: ["none", "none"] };
  if (ends[mode]) { if (op.fromEnd === undefined) op.fromEnd = ends[mode][0]; if (op.toEnd === undefined) op.toEnd = ends[mode][1]; }
  delete op.arrows; delete op.bidirectional; delete op.reverse;
  if (["both", "bidirectional", "reverse", "backward", "reversed", "forward", "none", "line"].includes(slug(op.direction ?? ""))) delete op.direction;
  return op;
}

function applyEdgeOptions(edge: CanvasEdge, input: EdgeOptions): void {
  const op = normalizeEdgeOptions(input);
  for (const key of ["label", "color"] as const) if (op[key] !== undefined) {
    if (typeof op[key] !== "string") throw new Error(`Invalid arrow ${key}.`);
    edge[key] = op[key];
  }
  for (const key of ["fromSide", "toSide"] as const) if (op[key] !== undefined) {
    if (!["top", "right", "bottom", "left"].includes(op[key])) throw new Error("Invalid arrow side.");
    edge[key] = op[key];
  }
  for (const key of ["fromEnd", "toEnd"] as const) if (op[key] !== undefined) {
    if (op[key] !== "none" && op[key] !== "arrow") throw new Error("Invalid arrow end.");
    edge[key] = op[key];
  }
  if (op.styleAttributes !== undefined) {
    if (!op.styleAttributes || typeof op.styleAttributes !== "object" || Array.isArray(op.styleAttributes)) throw new Error("Invalid arrow styles.");
    const allowed = { path: ["solid", "long-dashed", "short-dashed", "dotted"], arrow: ["triangle", "triangle-outline", "thin-triangle", "halved-triangle", "diamond", "diamond-outline", "circle", "circle-outline", "blunt"], pathfindingMethod: ["bezier", "direct", "square", "a-star"] };
    const styles = edge.styleAttributes && typeof edge.styleAttributes === "object" && !Array.isArray(edge.styleAttributes) ? { ...edge.styleAttributes } : {};
    for (const [key, value] of Object.entries(op.styleAttributes)) {
      if (!Object.prototype.hasOwnProperty.call(allowed, key) || typeof value !== "string" || !allowed[key as keyof typeof allowed].includes(value)) throw new Error(`Invalid arrow style: ${key}.`);
      Object.defineProperty(styles, key, { value, writable: true, configurable: true, enumerable: true });
    }
    edge.styleAttributes = styles;
  }
}
export interface CanvasData { nodes: CanvasNode[]; edges: CanvasEdge[]; [key: string]: unknown }

export const MAIN_NODE_IDS = ["comsift-main", "whereami-main"];
export const RELATED_LABEL = "related";
export const UNCERTAIN_LABEL = "uncertain";

export function parseCanvas(raw: string): CanvasData {
  const value: unknown = JSON.parse(raw);
  const record = (item: unknown): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item);
  if (!record(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) throw new Error("Invalid Canvas document.");
  const ids = new Set<string>();
  const nodes = value.nodes.map((item: unknown): CanvasNode => {
    if (!record(item) || typeof item.id !== "string" || !item.id || ids.has(item.id) ||
        !["x", "y", "width", "height"].every(key => typeof item[key] === "number" && Number.isFinite(item[key])) ||
        (item.width as number) <= 0 || (item.height as number) <= 0 ||
        ["text", "file", "type", "color", "label", "url"].some(key => item[key] !== undefined && typeof item[key] !== "string")) throw new Error("Invalid Canvas node.");
    ids.add(item.id);
    return item as unknown as CanvasNode;
  });
  const edgeIds = new Set<string>();
  const edges = value.edges.map((item: unknown): CanvasEdge => {
    if (!record(item) || typeof item.id !== "string" || !item.id || edgeIds.has(item.id) ||
        typeof item.fromNode !== "string" || typeof item.toNode !== "string" || !ids.has(item.fromNode) || !ids.has(item.toNode) ||
        ["label", "color", "fromSide", "toSide", "fromEnd", "toEnd"].some(key => item[key] !== undefined && typeof item[key] !== "string") ||
        (item.comsift_type !== undefined && (typeof item.comsift_type !== "string" || !["normal", "same", "related", "uncertain"].includes(item.comsift_type)))) throw new Error("Invalid Canvas connection.");
    edgeIds.add(item.id);
    return item as unknown as CanvasEdge;
  });
  return { ...value, nodes, edges };
}

/** Arrow type: explicit marker first, then the label. */
export function arrowType(edge: CanvasEdge, personName?: string): ArrowType {
  if (edge.comsift_type === "normal" || edge.comsift_type === "same" || edge.comsift_type === "related" || edge.comsift_type === "uncertain") return edge.comsift_type;
  const label = (edge.label ?? "").trim().toLowerCase();
  if (label === RELATED_LABEL) return "related";
  if (label === UNCERTAIN_LABEL) return "uncertain";
  if (personName && label === personName.trim().toLowerCase()) return "same";
  return "normal";
}

/** Freeze legacy label-derived types before the user edits the visible label. */
export function persistArrowTypes(data: CanvasData, personName: string): CanvasData {
  return { ...data, edges: data.edges.map(edge => edge.comsift_type === undefined && arrowType(edge, personName) !== "normal"
    ? { ...edge, comsift_type: arrowType(edge, personName) } : edge) };
}

/** Relationship metadata and label are independent; changing type preserves user text. */
export function withArrowType(edge: CanvasEdge, type: ArrowType, personName: string, colors: { same: string; related: string; uncertain: string }): CanvasEdge {
  const next: CanvasEdge = { ...edge, comsift_type: type };
  if (type !== "normal") {
    next.color = colors[type];
    if (edge.label === undefined) next.label = type === "same" ? personName : type;
  }
  else if (edge.comsift_type && edge.comsift_type !== "normal") delete next.color;
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
  // Along one path the weakest typed arrow decides (same → uncertain is uncertain); plain arrows only connect.
  // Between different paths the strongest result wins.
  const rank: Record<ArrowType, number> = { normal: 0, uncertain: 1, related: 2, same: 3 };
  const chained = (a: ArrowType, b: ArrowType): ArrowType => a === "normal" ? b : b === "normal" ? a : rank[a] <= rank[b] ? a : b;
  const links = new Map<string, TypedLink>();
  for (const [start, from] of fileOf) {
    const stack: Array<{ id: string; type: ArrowType }> = (out.get(start) ?? []).map(next => ({ id: next.to, type: next.type }));
    // Best type that reached each node; a node is explored again only when a stronger path arrives.
    const seen = new Map<string, ArrowType>([[start, "same"]]);
    const better = (a: ArrowType, b: ArrowType | undefined) => b === undefined || (a !== "normal" && (b === "normal" || rank[a] > rank[b]));
    while (stack.length) {
      const { id, type } = stack.pop()!;
      if (!better(type, seen.get(id))) continue;
      seen.set(id, type);
      const target = fileOf.get(id);
      if (target) {
        if (target !== from) {
          const key = `${from}\n${target}`;
          const prior = links.get(key);
          links.set(key, { from, to: target, type: prior ? strongest(prior.type, type) : type });
        }
        continue;
      }
      for (const next of out.get(id) ?? []) stack.push({ id: next.to, type: chained(type, next.type) });
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
    return `node ${n}${flags ? ` [${flags}]` : ""} ${what} x=${Math.round(node.x)} y=${Math.round(node.y)} w=${Math.round(node.width)} h=${Math.round(node.height)} id=${JSON.stringify(node.id)}`;
  });
  const edgeIds = new Map<string, string>();
  let count = 0;
  for (const edge of data.edges) {
    const from = short.get(edge.fromNode), to = short.get(edge.toNode);
    if (!from || !to) continue;
    const id = `e${++count}`;
    edgeIds.set(id, edge.id);
    const type = arrowType(edge, options.personName);
    lines.push(`edge ${id}: ${from} -> ${to} fromSide=${edge.fromSide ?? "auto"} toSide=${edge.toSide ?? "auto"} fromEnd=${typeof edge.fromEnd === "string" ? edge.fromEnd : "none"} toEnd=${typeof edge.toEnd === "string" ? edge.toEnd : "arrow"} type=${type}${edge.label ? ` label=${JSON.stringify(edge.label)}` : ""}${edge.color ? ` color=${JSON.stringify(edge.color)}` : ""}${edge.styleAttributes ? ` styleAttributes=${JSON.stringify(edge.styleAttributes)}` : ""} id=${JSON.stringify(edge.id)}`);
  }
  return { text: lines.join("\n"), ids, edgeIds };
}

export type CanvasOp =
  | { op: "add"; ref?: string; text?: string; file?: string; near?: number | string; direction?: Direction; type?: ArrowType; connect?: boolean; width?: number; height?: number }
  | { op: "group"; ref?: string; label?: string; nodes?: Array<number | string>; x?: number; y?: number; width?: number; height?: number }
  | { op: "group-edit"; node: number | string; label?: string; color?: string; width?: number; height?: number }
  | { op: "group-add"; group: number | string; nodes: Array<number | string> }
  | ({ op: "edge"; edge: string; from?: number | string; to?: number | string; type?: ArrowType } & EdgeOptions)
  | { op: "move"; node: number | string; x?: number; y?: number; near?: number | string; direction?: Direction }
  | ({ op: "connect"; from: number | string; to: number | string; type?: ArrowType } & EdgeOptions)
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
  const moved = new Set<string>();
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
  const connect = (from: string, to: string, type: ArrowType) => {
    if (from === to) throw new Error("A node cannot connect to itself.");
    const existing = edges.find(edge => edge.fromNode === from && edge.toNode === to);
    const base: CanvasEdge = existing ?? { id: context.newId(), fromNode: from, toNode: to };
    Object.assign(base, connectionSides(nodes.find(node => node.id === from)!, nodes.find(node => node.id === to)!));
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
        if (anchorId && op.connect !== false) connect(anchorId, id, op.type ?? "normal");
        summary.push(`Add ${op.file ? `file ${op.file}` : `node “${(op.text ?? "").slice(0, 40)}”`}${anchor ? ` ${side} of ${label(anchor.id)}` : ""}`);
        break;
      }
      case "group": {
        const members = (op.nodes ?? []).map(value => nodes.find(node => node.id === resolve(value, "member"))!);
        const id = context.newId();
        const group: CanvasNode = { id, type: "group", label: op.label ?? "Group", x: op.x ?? 0, y: op.y ?? 0, width: op.width ?? 400, height: op.height ?? 300 };
        if (members.length) fitGroup(group, members);
        nodes.unshift(group); created.add(id);
        if (op.ref) {
          if (refs.has(op.ref) || visibleIds.has(op.ref) || context.digest.ids.has(Number(op.ref))) throw new Error("Group reference is already in use.");
          refs.set(op.ref, id);
        }
        summary.push(`Create group “${String(group.label)}” (${members.length} nodes)`);
        break;
      }
      case "group-edit": {
        const group = nodes.find(node => node.id === resolve(op.node, "group"))!;
        if (group.type !== "group") throw new Error("Expected a group node.");
        if (op.label !== undefined) group.label = op.label;
        if (op.color !== undefined) group.color = op.color;
        for (const key of ["width", "height"] as const) if (op[key] !== undefined) {
          const size = op[key];
          if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) throw new Error("Invalid group size.");
          group[key] = size;
        }
        summary.push(`Edit group ${label(group.id)}`);
        break;
      }
      case "group-add": {
        const group = nodes.find(node => node.id === resolve(op.group, "group"))!;
        if (group.type !== "group") throw new Error("Expected a group node.");
        const members = op.nodes.map(value => nodes.find(node => node.id === resolve(value, "member"))!);
        if (members.includes(group)) throw new Error("A group cannot contain itself.");
        const existing = nodes.filter(node => node.id !== group.id && containsNode(group, node));
        fitGroup(group, [...existing, ...members]);
        summary.push(`Add ${members.length} nodes to group ${label(group.id)}`);
        break;
      }
      case "edge": {
        const target = edgeOf(op.edge);
        resolve(target.fromNode, "from"); resolve(target.toNode, "to");
        if (op.from !== undefined) target.fromNode = resolve(op.from, "from");
        if (op.to !== undefined) target.toNode = resolve(op.to, "to");
        if (target.fromNode === target.toNode) throw new Error("A node cannot connect to itself.");
        if (op.from !== undefined || op.to !== undefined) Object.assign(target, connectionSides(nodes.find(node => node.id === target.fromNode)!, nodes.find(node => node.id === target.toNode)!));
        if (op.type) Object.assign(target, withArrowType(target, op.type, context.personName, context.colors));
        applyEdgeOptions(target, op);
        summary.push(`Edit arrow ${op.edge}`);
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
        moved.add(id);
        summary.push(`Move ${label(id)}`);
        break;
      }
      case "connect": {
        const from = resolve(op.from, "from"), to = resolve(op.to, "to");
        connect(from, to, op.type ?? "normal");
        applyEdgeOptions(edges.find(edge => edge.fromNode === from && edge.toNode === to)!, { ...op, fromSide: undefined, toSide: undefined });
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
        if (node.type === "group") node.label = op.text;
        else node.text = op.text;
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
          moved.add(child.id);
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
  edges = edges.map(edge => {
    if (![edge.fromNode, edge.toNode].some(id => created.has(id) || moved.has(id))) return edge;
    const from = nodes.find(node => node.id === edge.fromNode), to = nodes.find(node => node.id === edge.toNode);
    return from && to ? { ...edge, ...connectionSides(from, to) } : edge;
  });
  return { data: parseCanvas(JSON.stringify({ ...data, nodes, edges })), summary };
}

/** Parse `<canvas path="…">[ …operations… ]</canvas>` blocks from a model answer. */
function parseOps(raw: string): CanvasOp[] {
  const json = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim().replace(/,(\s*[\]}])/g, "$1");
  const parsed = JSON.parse(json) as unknown;
  const ops = Array.isArray(parsed) ? parsed : (parsed as { ops?: unknown; operations?: unknown })?.ops ?? (parsed as { operations?: unknown })?.operations;
  if (!Array.isArray(ops)) throw new Error("Expected a JSON array of operations.");
  return ops as CanvasOp[];
}
const isOpList = (raw: string) => /^\s*(?:```(?:json)?\s*)?\[\s*\{\s*"op"\s*:/i.test(raw);

/**
 * Pull `<canvas path="…">[ops]</canvas>` blocks out of an answer. With `defaultPath`, also accept the
 * ways models get this wrong: a bare fenced JSON array of operations, a `<canvas>` tag without a path,
 * and a block that was cut off before its closing tag.
 */
export function parseCanvasEdits(answer: string, defaultPath?: string): { text: string; edits: Array<{ path: string; ops: CanvasOp[]; error?: string }> } {
  const edits: Array<{ path: string; ops: CanvasOp[]; error?: string }> = [];
  const take = (path: string, body: string) => {
    try { edits.push({ path, ops: parseOps(body) }); } catch (error) { edits.push({ path, ops: [], error: (error as Error).message }); }
    return "";
  };
  let text = answer.replace(/<canvas\s+path\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/canvas>/gi, (_all, path: string, body: string) => take(path, body));
  if (defaultPath !== undefined && !edits.length) {
    text = text.replace(/<canvas(?:\s+path\s*=\s*"([^"]*)")?\s*>([\s\S]*?)(?:<\/canvas>|$)/gi, (_all, path: string | undefined, body: string) => take(path || defaultPath, body));
    text = text.replace(/(^|\n)(`{3,}|~{3,})(?:json)?[ \t]*\n([\s\S]*?)\n?\2[ \t]*(?=\n|$)/gi, (all: string, lead: string, _fence: string, body: string) => isOpList(body) ? (take(defaultPath, body), lead) : all);
    if (!edits.length) {
      const bare = text.match(/(^|\n)(\[\s*\{\s*"op"\s*:[\s\S]*\])\s*$/);
      if (bare && bare.index !== undefined) { take(defaultPath, bare[2]); text = text.slice(0, bare.index); }
    }
  }
  return { text: text.replace(/\n{3,}/g, "\n\n").trim(), edits };
}

/** Streaming view of an answer without Canvas operation JSON, finished or still being written. */
export function hideCanvasOps(partial: string): string {
  let text = partial.replace(/<canvas(?:\s[^>]*)?>[\s\S]*?<\/canvas>/gi, "");
  const open = text.search(/<canvas(?:\s|>|$)/i);
  if (open >= 0) text = text.slice(0, open);
  text = text.replace(/<c(?:a(?:n(?:v(?:as?)?)?)?)?$/i, "");
  const fence = /(^|\n)(`{3,}|~{3,})(?:json)?[ \t]*\n(\s*\[\s*\{\s*"op"[\s\S]*?)(?:\n\2[ \t]*(?=\n|$)|$)/gi;
  text = text.replace(fence, "$1");
  const pending = text.search(/(^|\n)(?:`{3,}|~{3,})(?:j(?:s(?:o(?:n)?)?)?)?[ \t]*\n?\s*\[?\s*\{?\s*"?o?p?"?$/i);
  if (pending >= 0 && /\[|\{|"/.test(text.slice(pending))) text = text.slice(0, pending);
  const bare = text.search(/(^|\n)\[\s*\{\s*"op"/);
  if (bare >= 0) text = text.slice(0, bare);
  return text.replace(/\n{3,}/g, "\n\n").trim();
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

/** JSON Canvas group membership is geometric, with no separate parent field. */
export function containsNode(group: CanvasNode, node: CanvasNode): boolean {
  return node.x >= group.x && node.y >= group.y && node.x + node.width <= group.x + group.width && node.y + node.height <= group.y + group.height;
}
export function fitGroup(group: CanvasNode, members: CanvasNode[], padding = 40): void {
  if (!members.length) return;
  const x = Math.min(...members.map(node => node.x)) - padding;
  const y = Math.min(...members.map(node => node.y)) - padding;
  group.width = Math.max(...members.map(node => node.x + node.width)) - x + padding;
  group.height = Math.max(...members.map(node => node.y + node.height)) - y + padding;
  group.x = x; group.y = y;
}
