import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const built = await build({ entryPoints: ["src/analysis/canvasOverlay.ts"], bundle: true, platform: "node", format: "esm", write: false });
const { CanvasOverlay } = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].contents).toString("base64"));
// A second window's HTMLElement, deliberately unrelated to the global window.
class OtherWindowElement {
  constructor() {
    this.classes = new Set();
    this.classList = { add: (...v) => v.forEach(c => this.classes.add(c)), remove: c => this.classes.delete(c), contains: c => this.classes.has(c) };
    this.style = {}; this.children = []; this.ownerDocument = { defaultView: { HTMLElement: OtherWindowElement } };
  }
  instanceOf(type) { return this instanceof type; }
  createDiv() { const el = new OtherWindowElement(); this.children.push(el); return el; }
  createSvg() { return this.createDiv(); }
  appendChild() {}
  setAttribute() {}
  setText() {}
  remove() { this.removed = true; }
}
const n = (id, x = 0) => ({ id, type: "text", text: id, x, y: 0, width: 100, height: 100 });
test("world preview dims affected native objects, restores them on previous/clear, and supports another window", () => {
  const a = new OtherWindowElement(), b = new OtherWindowElement();
  const line = new OtherWindowElement(), end = new OtherWindowElement();
  const world = new OtherWindowElement();
  const before = { nodes: [n("a"), n("b")], edges: [{ id: "e", fromNode: "a", toNode: "b" }] };
  const after = { ...before, nodes: [n("a", 200), n("b")] };
  const canvas = { wrapperEl: new OtherWindowElement(), canvasEl: world, nodes: new Map([["a", { nodeEl: a }], ["b", { nodeEl: b }]]), edges: new Map([["e", { lineGroupEl: line, lineEndGroupEl: end }]]) };
  const original = JSON.stringify(before);
  const overlay = new CanvasOverlay();
  overlay.draw(canvas, before, after);
  assert.ok(a.classes.has("comsift-canvas-preview-original"));
  assert.ok(!b.classes.has("comsift-canvas-preview-original"));
  assert.ok(line.classes.has("comsift-canvas-preview-original"));
  assert.ok(end.classes.has("comsift-canvas-preview-original"));
  overlay.draw(canvas, before, after, true);
  assert.equal(a.classes.size, 0); assert.equal(line.classes.size, 0); assert.equal(end.classes.size, 0);
  assert.ok(world.children[0].removed);
  overlay.draw(canvas, before, after); overlay.clear();
  assert.equal(a.classes.size, 0);
  assert.equal(JSON.stringify(before), original);
});
