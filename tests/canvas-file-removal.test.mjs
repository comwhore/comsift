import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const built = await build({ entryPoints: ["src/service/canvasFileRemoval.ts"], bundle: true, platform: "node", format: "esm", write: false,
  plugins: [{ name: "obsidian-stub", setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export class Notice {}" }));
  } }],
});
const { matchesCanvasShortcut, removeCanvasFiles, addRemoveCanvasFileItem } = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].contents).toString("base64"));

const key = (name, extra = {}) => ({ key: name, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra });
test("Canvas file shortcut respects configured key and exact modifiers", () => {
  assert.equal(matchesCanvasShortcut(key("Delete"), "Delete"), true);
  assert.equal(matchesCanvasShortcut(key("Delete", { shiftKey: true }), "Delete"), false);
  assert.equal(matchesCanvasShortcut(key("d", { ctrlKey: true, shiftKey: true }), "Ctrl+Shift+D"), true);
  assert.equal(matchesCanvasShortcut(key("Delete", { metaKey: true }), "Mod+Delete"), true);
  assert.equal(matchesCanvasShortcut(key("Delete"), ""), false);
});

function fixture(fail = false) {
  let data = { nodes: [{ id: "comsift-main", type: "file", file: "person.md" }, { id: "one", type: "file", file: "profile.md" }, { id: "two", type: "file", file: "profile.md" }, { id: "text", type: "text", text: "hi" }], edges: [{ id: "edge", fromNode: "one", toNode: "text" }] };
  const trashed = [];
  const plugin = { app: { vault: { getFileByPath: path => ({ path }) }, fileManager: { trashFile: async file => { if (fail) throw new Error("trash failed"); trashed.push(file.path); } } } };
  const canvas = { getData: () => data, importData: next => { data = next; }, requestSave() {}, deselectAll() {} };
  return { plugin, canvas, trashed };
}
test("Canvas file removal trashes each referenced file once, removes arrows, preserves protected main node", async () => {
  const { plugin, canvas, trashed } = fixture();
  await removeCanvasFiles(plugin, canvas, ["comsift-main", "one", "two", "text"]);
  assert.deepEqual(trashed, ["profile.md"]);
  assert.deepEqual(canvas.getData().nodes.map(node => node.id), ["comsift-main"]);
  assert.deepEqual(canvas.getData().edges, []);
});
test("Canvas retains its nodes when file trash fails", async () => {
  const { plugin, canvas } = fixture(true);
  await assert.rejects(removeCanvasFiles(plugin, canvas, ["one"]), /trash failed/);
  assert.equal(canvas.getData().nodes.length, 4);
});
test("Remove file appears immediately below native Remove without changing other items", () => {
  const { plugin, canvas } = fixture();
  const menu = { items: [{ title: "Edit" }, { title: "Remove" }, { title: "Other" }], addItem(callback) {
    const item = { setTitle(title) { this.title = title; return this; }, setIcon() { return this; }, onClick() { return this; } };
    callback(item); this.items.push(item);
  } };
  addRemoveCanvasFileItem(plugin, menu, canvas, "one");
  assert.deepEqual(menu.items.map(item => item.title), ["Edit", "Remove", "Remove file", "Other"]);
});

test("native menu ordering reads DOM titles when Obsidian has no internal title property", () => {
  for (const native of [{ titleEl: { textContent: "Remove" } }, { dom: { querySelector: () => ({ textContent: "Remove node" }), after() {} } }]) {
    const { plugin, canvas } = fixture();
    const menu = { items: [{ title: "Edit" }, native, { title: "Other" }], addItem(callback) {
      const item = { setTitle(title) { this.title = title; return this; }, setIcon() { return this; }, onClick() { return this; } };
      callback(item); this.items.push(item);
    } };
    addRemoveCanvasFileItem(plugin, menu, canvas, "one");
    assert.equal(menu.items[1], native);
    assert.equal(menu.items[2].title, "Remove file");
    assert.equal(menu.items[3].title, "Other");
  }
});
