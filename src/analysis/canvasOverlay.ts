import type { CanvasData, CanvasNode } from "../service/canvasModel";
import { canvasFingerprint } from "../service/canvasPreview";

/** Ephemeral DOM only. Attached to the board's transformed world layer, never its saved data. */
export class CanvasOverlay {
  private root: HTMLElement | null = null;
  private dimmed: Element[] = [];
  clear() {
    this.root?.remove(); this.root = null;
    for (const el of this.dimmed) el.classList.remove("comsift-canvas-preview-original");
    this.dimmed = [];
  }
  private dim(el: Element | undefined) {
    if (!el || el.classList.contains("comsift-canvas-preview-original")) return;
    el.classList.add("comsift-canvas-preview-original");
    this.dimmed.push(el);
  }
  draw(canvas: M.Canvas, before: CanvasData, after: CanvasData, previous = false) {
    this.clear();
    // Previous means the actual untouched board, with its full native rendering.
    if (previous) return;
    const wrapper = canvas.wrapperEl as HTMLElement | undefined;
    const realm = wrapper?.ownerDocument?.defaultView;
    // The constructor comes from this board’s own window; the global realm would reject popouts.
    const host = realm && wrapper?.instanceOf(realm.HTMLElement) ? wrapper : null;
    const board = canvas.canvasEl as HTMLElement | undefined;
    const world = realm && board?.instanceOf(realm.HTMLElement) ? board : host?.querySelector<HTMLElement>(".canvas");
    if (!world) throw new Error("Canvas preview layer is unavailable. Keep the board open.");
    const root = world.createDiv({ cls: "comsift-canvas-live-overlay" });
    this.root = root;
    const changed = new Set<string>();
    for (const item of [...before.nodes, ...before.edges, ...after.nodes, ...after.edges]) {
      const a = [...before.nodes, ...before.edges].find(node => node.id === item.id);
      const b = [...after.nodes, ...after.edges].find(node => node.id === item.id);
      if (canvasFingerprint(a) !== canvasFingerprint(b)) changed.add(item.id);
    }
    // Dim only native objects affected by this proposal; no saved Canvas data changes.
    const liveNodes = canvas.nodes instanceof Map ? canvas.nodes : new Map(Object.entries(canvas.nodes));
    for (const node of before.nodes) if (changed.has(node.id)) this.dim(liveNodes.get(node.id)?.nodeEl);
    const liveEdges = canvas.edges as Map<string, M.Edge> | undefined;
    for (const edge of before.edges) {
      if (!changed.has(edge.id) && !changed.has(edge.fromNode) && !changed.has(edge.toNode)) continue;
      const live = liveEdges?.get(edge.id);
      this.dim(live?.lineGroupEl as SVGElement | undefined); this.dim(live?.lineEndGroupEl as SVGElement | undefined);
    }
    const layer = (data: CanvasData, ghost: boolean) => {
      const nodes = new Map(data.nodes.map(node => [node.id, node]));
      const svg = root.createSvg("svg");
      svg.classList.add("comsift-canvas-live-edges", ghost ? "is-previous" : "is-proposed");
      const center = (node: CanvasNode) => [node.x + node.width / 2, node.y + node.height / 2];
      for (const edge of data.edges) {
        if (!changed.has(edge.id) && !changed.has(edge.fromNode) && !changed.has(edge.toNode)) continue;
        const from = nodes.get(edge.fromNode), to = nodes.get(edge.toNode);
        if (!from || !to) continue;
        const [x1, y1] = center(from), [x2, y2] = center(to);
        const path = svg.createSvg("path");
        const angle = Math.atan2(y2-y1, x2-x1), size = 15;
        path.setAttribute("d", `M${x1},${y1} L${x2},${y2} M${x2-size*Math.cos(angle-.5)},${y2-size*Math.sin(angle-.5)} L${x2},${y2} L${x2-size*Math.cos(angle+.5)},${y2-size*Math.sin(angle+.5)}`);
        svg.appendChild(path);
      }
      root.appendChild(svg);
      for (const node of data.nodes) {
        if (!changed.has(node.id)) continue;
        const el = root.createDiv({ cls: `comsift-canvas-live-node ${ghost ? "is-previous" : "is-proposed"}` });
        el.style.left = `${node.x}px`; el.style.top = `${node.y}px`; el.style.width = `${node.width}px`; el.style.height = `${node.height}px`;
        el.setText((node.text ?? node.file ?? node.id).slice(0, 2000));
      }
    };
    layer(before, true);
    if (!previous) layer(after, false);
  }
}
