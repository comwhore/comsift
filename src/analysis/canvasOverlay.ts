import type { App } from "obsidian";
import type { CanvasData } from "../service/canvasModel";
import { canvasFingerprint } from "../service/canvasPreview";
import { canvasColor, canvasEdgeGeometry } from "./canvasEdgePreview";

/** Ephemeral DOM only. Attached to the board's transformed world layer, never its saved data. */
export class CanvasOverlay {
  constructor(private app: App) {}
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
      const svg = root.createSvg("svg");
      svg.classList.add("comsift-canvas-live-edges", ghost ? "is-previous" : "is-proposed");
      for (const edge of data.edges) {
        if (!changed.has(edge.id) && !changed.has(edge.fromNode) && !changed.has(edge.toNode)) continue;
        const geometry = canvasEdgeGeometry(this.app, data, edge);
        if (!geometry) continue;
        const group = svg.createSvg("g");
        group.style.color = canvasColor(edge.color);
        const styles = edge.styleAttributes && typeof edge.styleAttributes === "object" ? edge.styleAttributes as Record<string, unknown> : {};
        const path = svg.createSvg("path");
        path.setAttribute("d", geometry.path);
        if (["dotted", "short-dashed", "long-dashed"].includes(String(styles.path))) path.setAttribute("data-path", String(styles.path));
        group.appendChild(path);
        const end = (x: number, y: number, angle: number) => {
          const head = group.createSvg("path");
          const style = styles.arrow;
          head.setAttribute("d", style === "diamond" || style === "diamond-outline" ? "M 0 0 L -10 -5 L -20 0 L -10 5 Z" : style === "circle" || style === "circle-outline" ? "M 0 0 A 7.5 7.5 0 1 0 -15 0 A 7.5 7.5 0 1 0 0 0" : style === "blunt" ? "M -6 -10 L -6 10" : style === "thin-triangle" ? "M -10 -6.5 L 0 0 L -10 6.5" : style === "halved-triangle" ? "M 0 0 L -12 7.5 L -12 -2 Z" : "M 0 0 L -10.4 -6.5 L -10.4 6.5 Z");
          head.setAttribute("transform", `translate(${x} ${y}) rotate(${angle * 180 / Math.PI})`);
          head.classList.add("comsift-canvas-edge-end");
          head.style.fill = typeof style === "string" && (style.endsWith("outline") || style === "thin-triangle" || style === "blunt") ? "var(--background-primary)" : "currentColor";
        };
        if (edge.fromEnd === "arrow") end(geometry.a.x, geometry.a.y, geometry.fromAngle);
        if (edge.toEnd !== "none") end(geometry.b.x, geometry.b.y, geometry.toAngle);
        if (edge.label) {
          const label = group.createSvg("text"); label.setAttribute("x", String(geometry.center.x)); label.setAttribute("y", String(geometry.center.y)); label.textContent = edge.label;
        }
      }
      root.appendChild(svg);
      for (const node of data.nodes) {
        if (!changed.has(node.id)) continue;
        const el = root.createDiv({ cls: `comsift-canvas-live-node ${ghost ? "is-previous" : "is-proposed"}` });
        el.style.left = `${node.x}px`; el.style.top = `${node.y}px`; el.style.width = `${node.width}px`; el.style.height = `${node.height}px`;
        if (node.color) el.style.borderColor = canvasColor(node.color);
        const label = typeof node.label === "string" ? node.label : undefined;
        el.setText(String(node.type === "group" ? label ?? node.text ?? node.id : node.text ?? node.file ?? label ?? node.id).slice(0, 2000));
        if (node.type === "group") el.addClass("is-group");
      }
    };
    layer(before, true);
    if (!previous) layer(after, false);
  }
}
