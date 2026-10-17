import WhereAmIPlugin from "../main";
import { findClosestNodeByBbox } from "../tool";

class View {
  main: WhereAmIPlugin;

  constructor(main: WhereAmIPlugin) {
    this.main = main;
  }

  isTouching() {
    return this.main.node.getSelection().size === 0;
  }

  isNavigating() {
    const node = this.main.node.getSingleSelection();
    if (!node) return false;
    return node.isFocused && !node.isEditing;
  }

  isCreating() {
    const node = this.main.node.getSingleSelection();
    if (!node) return false;
    return node.isFocused && node.isEditing;
  }

  useTouch() {
    this.main.canvas?.deselectAll?.();
  }

  useCreation(node: M.Node) {
    window.setTimeout(() => node.startEditing(), this.main.setting.MACRO_TASK_DELAY);
  }

  creation2Navigation() {
    const selection = this.main.node.getSingleSelection();
    if (!selection || !this.isCreating()) return;
    selection.blur();
    selection.focus();
  }

  touch2Navigation() {
    if (!this.main.canvas) return;
    const viewportBBox = this.main.canvas.getViewportBBox();
    const centerPoint: M.Position = [
      (viewportBBox.minX + viewportBBox.maxX) / 2,
      (viewportBBox.minY + viewportBBox.maxY) / 2,
    ];
    const viewportNodes = this.main.canvas.getViewportNodes();
    if (!viewportNodes.length) return;
    const res = findClosestNodeByBbox(centerPoint, viewportNodes);
    this.zoomToNode(res.node);
  }

  zoomToNode(node: M.Node) {
    this.main.canvas?.selectOnly?.(node);
    this.main.canvas?.zoomToSelection?.();
    if (this.main.setting.autoFocus) {
      this.useCreation(node);
    }
  }
}

export { View };
