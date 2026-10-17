import { debounce, uuid } from "../tool";
import WhereAmIPlugin from "../main";
import autobind from "autobind-decorator";
import type { ArrowType } from "../service/canvasModel";

@autobind
class Node {
  main: WhereAmIPlugin;

  constructor(main: WhereAmIPlugin) {
    this.main = main;
  }

  getNavigationNode(): M.Node | null {
    const node = this.getSingleSelection();
    if (!node || !node.isFocused || node.isEditing) return null;
    return node;
  }

  getSelection(): Set<M.Node> {
    return this.main.canvas?.selection ?? new Set<M.Node>();
  }

  getSingleSelection(): M.Node | null {
    if (!this.main.canvas?.selection) return null;
    const selections = this.main.canvas.selection;
    if (selections.size === 0 || selections.size > 1) return null;
    const [first] = selections;
    return first ?? null;
  }

  getFromNodes(node: M.Node): M.Node[] {
    return (this.main.canvas?.getEdgesForNode(node) ?? [])
      .filter(edge => edge.to.node.id === node.id)
      .map(edge => edge.from.node);
  }

  getToNodes(node: M.Node): M.Node[] {
    return (this.main.canvas?.getEdgesForNode(node) ?? [])
      .filter(edge => edge.from.node.id === node.id)
      .map(edge => edge.to.node);
  }

  @debounce()
  createChildren() {
    this.createChildHelper("normal");
  }

  @debounce()
  createSameChild() {
    this.createChildHelper("same");
  }

  @debounce()
  createRelatedChild() {
    this.createChildHelper("related");
  }

  private createChildHelper(type: ArrowType) {
    const selection = this.getNavigationNode();
    if (!selection || !this.main.canvas) return;

    const { x, y, width, height } = selection;
    const rightSideNodeFilter = (node: M.Edge) => node?.to?.side === "left" && selection.id !== node?.to?.node?.id;

    const sibNodes = this.main.canvas
      .getEdgesForNode(selection)
      .filter(rightSideNodeFilter)
      .map(node => node.to.node);

    const nextNodeY = sibNodes.length > 0 ? Math.max(...sibNodes.map(node => node.y)) + this.main.setting.EPSILON : y;

    const childNode = this.main.canvas.createTextNode({
      pos: { x: x + width + 200, y: nextNodeY },
      size: { height, width },
      text: "",
      focus: false,
      save: true,
    });

    const data = this.main.canvas.getData();
    const edge = this.main.canvasTools.typedEdge({
      id: uuid(),
      fromNode: selection.id,
      fromSide: "right",
      toNode: childNode.id,
      toSide: "left",
    }, type, this.main.getActiveCanvasFile()?.path);
    this.main.canvas.importData({
      edges: [...data.edges, edge],
      nodes: data.nodes,
    });

    this.main.layout.useSide(selection, sibNodes.concat(childNode));
    this.main.view.zoomToNode(childNode);
  }

  @debounce()
  createBeforeSibNode() {
    this.createSibNodeHelper(true);
  }

  @debounce()
  createAfterSibNode() {
    this.createSibNodeHelper(false);
  }

  private createSibNodeHelper(isBefore: boolean) {
    const selection = this.getNavigationNode();
    if (!selection || !this.main.canvas) return;

    const { x, y, width, height } = selection;
    const { EPSILON } = this.main.setting;
    const fromNode = this.getFromNodes(selection)[0];
    if (!fromNode) return;
    const toNodes = this.getToNodes(fromNode);

    const insertedNode = this.main.canvas.createTextNode({
      pos: { x, y: isBefore ? y - EPSILON : y + EPSILON },
      size: { height, width },
      text: "",
      focus: false,
      save: true,
    });

    const data = this.main.canvas.getData();
    this.main.canvas.importData({
      edges: [
        ...data.edges,
        {
          id: uuid(),
          fromNode: fromNode.id,
          fromSide: "right",
          toNode: insertedNode.id,
          toSide: "left",
        },
      ],
      nodes: data.nodes,
    });

    this.main.layout.useSide(fromNode, toNodes.concat(insertedNode));
    this.main.view.zoomToNode(insertedNode);
  }
}

export { Node };
