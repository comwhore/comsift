import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const result = await build({ entryPoints: ["src/service/canvasPreview.ts"], bundle: true, platform: "node", format: "esm", write: false });
const m = await import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].contents).toString("base64"));
const before = { nodes: [{ id: "a", x: 0, y: 0, width: 100, height: 50 }], edges: [], custom: { name: "board" } };
test("snapshot guard accepts key reordering, rejects edits and custom-field changes", () => {
  m.assertCanvasSnapshot({ edges: [], custom: { name: "board" }, nodes: [{ height: 50, width: 100, y: 0, x: 0, id: "a" }] }, before);
  assert.throws(() => m.assertCanvasSnapshot({ ...before, custom: { name: "new" } }, before), /changed/);
  assert.throws(() => m.assertCanvasSnapshot({ ...before, nodes: [] }, before), /changed/);
});
test("comparison tracks moved nodes and removed arrows without marking unchanged nodes", () => {
  const old = { nodes: [...before.nodes, { ...before.nodes[0], id: "b" }], edges: [{ id: "edge", fromNode: "a", toNode: "b" }] };
  const next = { nodes: old.nodes.map(n => n.id === "a" ? { ...n, x: 300 } : n), edges: [] };
  assert.deepEqual([...m.changedCanvasIds(old, next)].sort(), ["a", "edge"]);
  assert.equal(old.nodes[0].x, 0);
});
