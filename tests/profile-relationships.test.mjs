import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const built = await build({ entryPoints: ["src/service/relationships.ts"], bundle: true, platform: "node", format: "esm", write: false,
  plugins: [{ name: "obsidian-stub", setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: `
      export class Notice {}
      export class TFile {}
      export class FuzzySuggestModal { setPlaceholder() {} open() { globalThis.relationshipPicks.push(this); } }
      export class Modal { constructor() { this.contentEl = { createEl(tag, options) { const el = { ...options }; if (tag === 'button') globalThis.relationshipButtons.push(el); return el; }, querySelectorAll() { return []; } }; } setTitle() {} open() {} close() {} }
    ` }));
  } }],
});
const { registerRelationshipCommands } = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].contents).toString("base64"));
const flush = () => new Promise(resolve => setImmediate(resolve));
const record = id => ({ id, dataset: "people.csv", row: 1, fields: { username: id, platform: "instagram" } });
const encode = records => `comsift_profile_data: ${JSON.stringify(JSON.stringify(records))}\n`;

test("profile relationship control selects merged accounts, reuses reversed stored review scope, and persists new status", async () => {
  globalThis.relationshipPicks = [];
  globalThis.relationshipButtons = [];
  const source = { path: "Person/Analysis/Profiles/merged.md", extension: "md" };
  const target = { path: "Other/Analysis/Profiles/other.md", extension: "md" };
  const review = { path: "Comsift/Comparisons/hash/Analysis/reviews.json" };
  const contents = new Map([[source.path, encode([record("a"), record("b")])], [target.path, encode([record("c")])], [review.path, JSON.stringify({ "c → a": { status: "confirmed" } })]]);
  const commands = [];
  const calls = [];
  const reopened = [];
  const plugin = {
    app: { workspace: { getActiveFile: () => source, getLeavesOfType: () => [], on: () => ({}), onLayoutReady() {} },
      vault: { getMarkdownFiles: () => [source, target], getFiles: () => [source, target, review], read: async file => contents.get(file.path) } },
    investigations: { forPath: () => null },
    analysis: { reviews: async () => ({ "c → a": { status: "confirmed" } }), review: async (...args) => calls.push(args), unreview: async (...args) => reopened.push(args), syncCanvasArrows: async () => {} },
    addCommand: command => commands.push(command), registerEvent() {}, register() {},
  };
  registerRelationshipCommands(plugin);
  assert.equal(commands.find(command => command.id === "edit-profile-relationship").checkCallback(false), true);
  await flush();
  const accounts = globalThis.relationshipPicks.shift();
  assert.deepEqual(accounts.getItems().map(item => item.id), ["a", "b"]);
  accounts.onChooseItem(accounts.getItems()[0]);
  await flush();
  const targets = globalThis.relationshipPicks.shift();
  assert.ok(targets.getItems().some(item => item.record.id === "b"), "merged account remains available for splitting");
  targets.onChooseItem(targets.getItems().find(item => item.record.id === "c"));
  await flush();
  globalThis.relationshipButtons.find(button => button.text === "Uncertain").onclick();
  await flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], { id: "comparison:hash", folderPath: "Comsift/Comparisons/hash" });
  assert.equal(calls[0][1].id, "c");
  assert.equal(calls[0][2].id, "a");
  assert.equal(calls[0][3], "uncertain");
  globalThis.relationshipButtons.find(button => button.text === "Neutral / clear choice").onclick();
  await flush();
  assert.equal(reopened.length, 2, "Neutral clears the draft and the restored committed choice");
  assert.deepEqual(reopened.map(args => args.slice(1)), [["c", "a"], ["c", "a"]]);
});
