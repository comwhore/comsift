import { replaceLiveCanvas } from "./canvasLive";
import { uuid } from "../tool";

export interface ToolChildrenState {
  rootId: string;
  childIds: string[];
}

type ToolStateBucket = Record<string, Record<string, unknown>>;

type CanvasTextNodeData = M.NodeData;

export function readToolState(bucket: ToolStateBucket, canvasPath: string, sourceNodeId: string): ToolChildrenState {
  const raw = bucket[canvasPath]?.[sourceNodeId] as { rootId?: unknown; childIds?: unknown } | string[] | undefined;
  if (Array.isArray(raw)) {
    return { rootId: "", childIds: raw.filter((id): id is string => typeof id === "string") };
  }
  return {
    rootId: typeof raw?.rootId === "string" ? raw.rootId : "",
    childIds: Array.isArray(raw?.childIds) ? raw.childIds.filter((id): id is string => typeof id === "string") : [],
  };
}

export function writeToolState(
  bucket: ToolStateBucket,
  canvasPath: string,
  sourceNodeId: string,
  state: ToolChildrenState,
) {
  bucket[canvasPath] ??= {};
  bucket[canvasPath][sourceNodeId] = {
    rootId: state.rootId,
    childIds: [...state.childIds],
  };
}

export function findNodeById(canvas: M.Canvas, id: string): M.Node | CanvasTextNodeData | null {
  if (!id) return null;
  if (canvas.nodes instanceof Map) {
    const loaded = canvas.nodes.get(id);
    if (loaded) return loaded;
  } else if (canvas.nodes?.[id]) {
    return canvas.nodes[id];
  }
  const data = canvas.getData?.();
  return (data?.nodes ?? []).find(node => node.id === id) ?? null;
}

export function findRootByTitle(canvas: M.Canvas, sourceNodeId: string, title: string): M.Node | CanvasTextNodeData | null {
  const data = canvas.getData?.();
  const nodes = data?.nodes ?? [];
  const edges = data?.edges ?? [];
  const candidate = nodes.find((node) => {
    const firstLine = String(node.text ?? "").split("\n")[0]?.trim();
    if (firstLine !== title) return false;
    return edges.some((edge) => edge.fromNode === sourceNodeId && edge.toNode === node.id);
  });
  return candidate ? findNodeById(canvas, candidate.id) : null;
}

export function setNodeText(canvas: M.Canvas, node: M.Node | CanvasTextNodeData, text: string): M.Node | CanvasTextNodeData {
  const live = node as M.Node;
  if (typeof live.setText === "function") live.setText(text);

  const data = canvas.getData?.();
  if (!data) return node;
  const nodes = data.nodes ?? [];
  const existing = nodes.find((candidate) => candidate.id === node.id);
  if (!existing || existing.text === text) return findNodeById(canvas, node.id) ?? node;

  canvas.importData({
    nodes: nodes.map((candidate) => (candidate.id === node.id ? { ...candidate, text } : candidate)),
    edges: data.edges ?? [],
  });
  return findNodeById(canvas, node.id) ?? { ...node, text };
}

export function createRootTextNode(
  canvas: M.Canvas,
  sourceNode: M.Node,
  pos: { x: number; y: number },
  text: string,
): M.Node | CanvasTextNodeData {
  const created = canvas.createTextNode({
    pos,
    size: {
      width: sourceNode.width,
      height: sourceNode.height,
    },
    text,
    focus: false,
    save: true,
  });

  const data = canvas.getData?.();
  if (!data) return created;
  const nodes = data.nodes ?? [];
  if (!nodes.some((node) => node.id === created.id)) {
    canvas.importData({
      nodes: [
        ...nodes,
        {
          id: created.id,
          type: "text",
          x: pos.x,
          y: pos.y,
          width: sourceNode.width,
          height: sourceNode.height,
          text,
        },
      ],
      edges: data.edges ?? [],
    });
  }
  return findNodeById(canvas, created.id) ?? created;
}

export function ensureEdge(
  canvas: M.Canvas,
  edge: { fromNode: string; toNode: string; fromSide?: string; toSide?: string },
) {
  const data = canvas.getData?.();
  if (!data) return;
  const edges = data.edges ?? [];
  const existing = edges.find((candidate) => candidate.fromNode === edge.fromNode && candidate.toNode === edge.toNode);
  if (existing && existing.fromSide === edge.fromSide && existing.toSide === edge.toSide) {
    return;
  }
  if (existing) {
    const existingId = existing.id;
    canvas.importData({
      nodes: data.nodes ?? [],
      edges: edges.map((candidate) => (candidate.id === existingId ? { ...candidate, ...edge } : candidate)),
    });
    return;
  }
  canvas.importData({
    nodes: data.nodes ?? [],
    edges: [
      ...edges,
      {
        ...edge,
        id: uuid(),
      },
    ],
  });
}

export function removeTrackedChildren(canvas: M.Canvas, childIds: string[]) {
  if (!childIds.length) return;
  const current = canvas.getData?.();
  if (!current) return;
  const removeSet = new Set(childIds);
  replaceLiveCanvas(canvas, {
    nodes: (current.nodes ?? []).filter(node => !removeSet.has(node.id)),
    edges: (current.edges ?? []).filter(edge => !removeSet.has(edge.fromNode) && !removeSet.has(edge.toNode)),
  });
}
