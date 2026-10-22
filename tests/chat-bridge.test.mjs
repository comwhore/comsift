import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const output = await build({ entryPoints: ["src/analysis/chatBridge.ts"], bundle: true, platform: "node", format: "esm", write: false, plugins: [{ name: "canvas-boundary", setup(build) {
  build.onResolve({ filter: /^\.\/canvasAssistant$/ }, () => ({ path: "canvas", namespace: "mock" }));
  build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: "export async function openCanvasAssistant(...args) { globalThis.bridgeCanvasArgs = args; }" }));
} }] });
const bridge = await import("data:text/javascript;base64," + Buffer.from(output.outputFiles[0].contents).toString("base64"));

test("conversation snapshots are isolated, copied and contain no stale assistant actions", () => {
  const a = {}, b = {};
  const messages = [{ role: "assistant", content: 'Read this. <edit action="append" path="Note.md">stale edit</edit><canvas-handoff path="A.canvas">stale handoff</canvas-handoff>' }];
  bridge.publishConversation(a, "chat", messages, "Folder");
  assert.equal(bridge.latestConversation(b, "chat"), undefined);
  messages[0].content = "changed";
  assert.equal(bridge.latestConversation(a, "chat").messages[0].content, "Read this.");
  const snapshot = bridge.latestConversation(a, "chat"); snapshot.messages[0].content = "mutated";
  assert.equal(bridge.latestConversation(a, "chat").messages[0].content, "Read this.");
});

test("Canvas handoff opens a new tab (or reuses an open one) and sidebar with editable prompt, never sends it", async () => {
  const calls = [];
  const canvas = {};
  const leaf = { view: { canvas }, async openFile(file) { calls.push(["open", file.path]); } };
  const plugin = { app: { vault: { getFileByPath: path => ({ path, extension: "canvas" }) }, workspace: { getLeavesOfType: () => [], getLeaf: mode => { calls.push(["leaf", mode]); return leaf; } } } };
  await bridge.openCanvasConversation(plugin, "Board.canvas", [{ role: "user", content: "prior question" }], "Review this prompt");
  assert.deepEqual(calls, [["leaf", "tab"], ["open", "Board.canvas"]]);
  assert.equal(globalThis.bridgeCanvasArgs[2], canvas);
  assert.equal(globalThis.bridgeCanvasArgs[3].prompt, "Review this prompt");
  assert.equal(globalThis.bridgeCanvasArgs[3].messages[0].content, "prior question");
  leaf.view = {};
  await assert.rejects(bridge.openCanvasConversation(plugin, "Board.canvas", [], "q"), /still loading/);
});
