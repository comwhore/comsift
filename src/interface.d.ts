declare namespace M {
  type Position = [x: number, y: number];

  interface BBox {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  }

  interface Rect {
    height: number;
    width: number;
    x: number;
    y: number;
  }

  interface Node extends Rect {
    alwaysKeepLoaded: boolean;
    app: unknown;
    aspectRadio: number;
    bbox: BBox;
    canvas: unknown;
    color: string;
    containerEl: HTMLDivElement;
    contentBlockerEl: HTMLDivElement;
    contentEl: HTMLDivElement;
    destroyed: boolean;
    id: string;
    initialized: boolean;
    isContentMounted: boolean;
    isEditing: boolean;
    nodeEl: HTMLDivElement;
    placeholderEl: HTMLDivElement;
    renderedZIndex: number;
    resizeDirty: boolean;
    text: string;
    unknownData: unknown;
    zIndex: number;
    isAttached: boolean;
    isFocused: boolean;
    rect: Rect;
    child?: { editor?: EditorLike };
    editor?: EditorLike;
    startEditing(): void;
    blur(): void;
    focus(): void;
    moveTo(pos: { x: number; y: number }): void;
    setText?(text: string): void;
    [key: string]: unknown;
  }

  interface EditorLike {
    setValue?(value: string): void;
    lastLine?(): number;
    setCursor?(line: number, ch: number): void;
    dispatch?(transaction: unknown): void;
    state?: { doc: { length: number }; update(spec: unknown): unknown };
  }

  interface NodeData {
    id: string;
    type?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    text?: string;
    file?: string;
    [key: string]: unknown;
  }

  interface EdgeData {
    id: string;
    fromNode: string;
    fromSide?: string;
    toNode: string;
    toSide?: string;
    [key: string]: unknown;
  }

  interface Data {
    nodes: NodeData[];
    edges: EdgeData[];
  }

  interface Canvas {
    nodes: Map<string, Node> | Record<string, Node>;
    selection: Set<Node>;
    getData(): Data;
    importData(data: Data, replace?: boolean): void;
    pushHistory?(data: Data): void;
    requestPushHistory?: { run(): void };
    createTextNode(options: { pos: { x: number; y: number }; size: { width: number; height: number }; text: string; focus: boolean; save: boolean }): Node;
    getEdgesForNode(node: Node): Edge[];
    getViewportNodes(): Node[];
    getViewportBBox(): BBox;
    requestSave?(history?: boolean): void;
    deselectAll?(): void;
    selectOnly?(node: Node): void;
    zoomToSelection?(): void;
    [key: string]: unknown;
  }

  type Sign = "none" | "arrow";
  type Side = "top" | "right" | "bottom" | "left";

  interface NodeDirection {
    end: Sign;
    node: Node;
    side: Side;
  }

  interface Edge {
    bbox: BBox;
    bezier: unknown;
    canvas: unknown;
    color: string;
    from: NodeDirection;
    fromLineEnd: unknown;
    id: string;
    initialized: boolean;
    label: unknown;
    lineEndGroupEl: HTMLOrSVGElement;
    lineGroupEl: HTMLOrSVGElement;
    path: unknown;
    to: NodeDirection;
    toLineEnd: { el: HTMLOrSVGElement; type: "arrow" };
    unknownData: unknown;
    isAttached: boolean;
    [key: string]: unknown;
  }

  type NodeActionName =
    | "Focus"
    | "CreateBeforeSib"
    | "CreateAfterSib"
    | "CreateChild"
    | "CreateChildSame"
    | "CreateChildRelated"
    | "RunSherlock"
    | "ArrowUp"
    | "ArrowDown"
    | "ArrowLeft"
    | "ArrowRight";
}
