import { KeymapContext, KeymapEventHandler, KeymapEventListener, Modifier } from "obsidian";
import { Node } from "./node";
import ComsiftPlugin from "../main";
import autobind from "autobind-decorator";
import { convertHotkey2Array, debounce } from "../tool";

@autobind
class Keymap {
  hotkeys: KeymapEventHandler[] = [];
  main: ComsiftPlugin;
  node: Node;

  constructor(main: ComsiftPlugin) {
    this.main = main;
    this.node = main.node;
  }

  @debounce()
  help() {
    if (this.main.view.isCreating()) return;
    console.debug("comsift keymap", this.main.canvas);
  }

  nodeNavigation(_: unknown, context: KeymapContext) {
    type Key = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";
    const { key } = context as Omit<KeymapContext, "key"> & { key: Key };
    const selection = this.node.getSingleSelection();
    if (!selection || selection.isEditing || !this.main.canvas) return;

    const { OFFSET_WEIGHT } = this.main.setting;
    const data = this.main.canvas.getViewportNodes();
    const offsetX = (a: M.Node, b: M.Node) => Math.abs(b.x - a.x);
    const offsetY = (a: M.Node, b: M.Node) => Math.abs(b.y - a.y);
    const endpointOffset = (a: M.Node, b: M.Node) =>
      Math.min(
        Math.abs(b.y - a.y + 2 / a.height),
        Math.abs(b.y + b.height - a.y - 2 / a.height),
        Math.abs(b.x - a.x + 2 / a.width),
        Math.abs(b.x + b.width - a.x + 2 / a.width),
      );
    const calcDistance = (a: M.Node, b: M.Node) =>
      key === "ArrowLeft" || key === "ArrowRight"
        ? offsetX(a, b) + endpointOffset(a, b) ** OFFSET_WEIGHT
        : offsetY(a, b) + endpointOffset(a, b) ** OFFSET_WEIGHT;

    const isSameDirection = (node: M.Node) => {
      const notSelf = node.id !== selection.id;
      const strategies = {
        ArrowRight: notSelf && node.x > selection.x + selection.width,
        ArrowLeft: notSelf && node.x + node.width < selection.x,
        ArrowUp: notSelf && node.y + node.height < selection.y,
        ArrowDown: notSelf && node.y > selection.y + selection.height,
      };
      return strategies[key];
    };

    const midpoints = data
      .filter(isSameDirection)
      .map(node => ({
        node,
        distance: calcDistance(selection, node),
      }))
      .sort((a, b) => a.distance - b.distance);

    if (midpoints.length > 0) {
      this.main.view.zoomToNode(midpoints[0].node);
    }
  }

  blurNode() {
    if (this.main.view.isCreating()) {
      this.main.view.creation2Navigation();
      return;
    }
    if (this.main.view.isNavigating()) {
      this.main.view.useTouch();
    }
  }

  focusNode() {
    if (this.main.view.isTouching()) {
      this.main.view.touch2Navigation();
      return;
    }
    const navigationNode = this.main.node.getNavigationNode();
    if (navigationNode) {
      this.main.view.useCreation(navigationNode);
    }
  }

  register(modifiers: Modifier[], key: string | null, func: KeymapEventListener): KeymapEventHandler {
    return this.main.app.scope.register(modifiers, key, func);
  }

  registerAll(options?: { [key in M.NodeActionName]?: () => KeymapEventHandler }) {
    const { hotkeys } = this.main.setting;
    const registerHotkey = (action: M.NodeActionName, callback: KeymapEventListener) => {
      const custom = options?.[action];
      if (custom) {
        this.hotkeys.push(custom());
        return;
      }
      const [modifier, key] = convertHotkey2Array(hotkeys[action]);
      this.hotkeys.push(this.register(modifier, key, callback));
    };

    const node = this.main.node;
    const navigate: KeymapEventListener = (event, context) => this.nodeNavigation(event, context);
    registerHotkey("Focus", () => this.focusNode());
    registerHotkey("CreateChild", () => node.createChildren());
    registerHotkey("CreateChildSame", () => node.createSameChild());
    registerHotkey("CreateChildRelated", () => node.createRelatedChild());
    registerHotkey("CreateBeforeSib", () => node.createBeforeSibNode());
    registerHotkey("CreateAfterSib", () => node.createAfterSibNode());
    registerHotkey("RunSherlock", () => this.main.runSherlockFromSelection());
    registerHotkey("RunMaigret", () => this.main.runMaigretFromSelection());
    registerHotkey("ArrowLeft", navigate);
    registerHotkey("ArrowRight", navigate);
    registerHotkey("ArrowUp", navigate);
    registerHotkey("ArrowDown", navigate);
  }

  unregisterAll() {
    this.hotkeys.forEach((key) => this.main.app.scope.unregister(key));
    this.hotkeys = [];
  }
}

export { Keymap };
