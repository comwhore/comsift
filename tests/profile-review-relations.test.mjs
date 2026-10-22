import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

async function load(entry) {
  const output = await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", write: false });
  return import("data:text/javascript;base64," + Buffer.from(output.outputFiles[0].contents).toString("base64"));
}
const { reviewRelations } = await load("src/service/reviewRelations.ts");
const { visibleProfileFields, profileFieldLabel } = await load("src/service/profileFields.ts");
const { computeColors, clewGroups } = await load("src/service/graphColoring.ts");
const graphBuild = await build({ entryPoints: ["src/service/graphColors.ts"], bundle: true, platform: "node", format: "esm", write: false,
  plugins: [{ name: "obsidian", setup(b) {
    b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const normalizePath=x=>x; export class TFile {}" }));
  } }] });
const { GraphColorService } = await import("data:text/javascript;base64," + Buffer.from(graphBuild.outputFiles[0].contents).toString("base64"));

function fixture(entries) {
  const files = [{ path: "Case/Connections/a.md" }, { path: "Case/Connections/b.md" }, { path: "Case/Analysis/reviews.json" }];
  const profile = id => ({ comsift_profile_data: JSON.stringify([{ id }]) });
  return { app: { vault: { getMarkdownFiles: () => files.slice(0, 2), getFiles: () => files, cachedRead: async () => JSON.stringify(entries) },
    metadataCache: { getFileCache: file => ({ frontmatter: profile(file === files[0] ? "a" : "b") }) } } };
}

test("committed analysis choices resolve to current profile paths and ignore uncommitted edits", async () => {
  const plugin = fixture({ "a → b": { pending: true, status: "rejected", committedReview: { status: "related" } } });
  assert.deepEqual(await reviewRelations(plugin), [{ source: "Case/Connections/a.md", target: "Case/Connections/b.md", type: "related" }]);
  assert.deepEqual(await reviewRelations(fixture({ "a → b": { pending: true, status: "related" } })), []);
});

test("a later opposite-direction rejection removes the old relationship", async () => {
  assert.deepEqual(await reviewRelations(fixture({ "a → b": { status: "related", updatedAt: "2026-10-20" }, "b → a": { status: "rejected", updatedAt: "2026-10-21" } })), []);
});

test("profile facts hide all-disabled columns while retaining fields enabled for any use", () => {
  const record = { id: "a", dataset: "Case/input.sheet.md#Sheet1", row: 1,
    fields: { username: "example", "note:user_id": "private-id", "note:website": "https://example.test/u" } };
  const mapping = { "Case/input.sheet.md": { username: "username", user_id: "account_id", website: "profile_url", _noidentity: "account_id\nprofile_url", _nomatch: "account_id\nprofile_url" } };
  const settings = { columnMapping: JSON.stringify(mapping), decisionIgnoredFields: "user_id" };
  assert.deepEqual(visibleProfileFields([record], settings), { username: "example", "note:website": "https://example.test/u" });
  assert.equal(profileFieldLabel("note:user_id"), "user id");
  assert.equal(profileFieldLabel("column:biography"), "biography");
  assert.equal(record.fields["note:user_id"], "private-id", "source data remains intact");
});

test("related profiles and same-person aliases use a distinct shade in Graph and Clew", () => {
  const people = [{ id: "p", folder: "Case", color: "#7f6df2", tag: "comsift/case", name: "Case" }];
  const paths = ["Case/Case.md", "Case/Connections/a.md", "Case/Connections/alt.md", "Case/Connections/b.md", "Case/Connections/other.md"];
  const options = { depth: 2, fade: 0.2, bridgeMode: "neutral", bridgeColor: "#888888", personaMix: 0.5 };
  const { notes, groups } = computeColors(people, paths, [], options, [], [[paths[1], paths[2]]], paths.slice(1), new Map(), [[paths[1], paths[3]]]);
  assert.equal(notes.get(paths[1]).related, true);
  assert.equal(notes.get(paths[2]).color, notes.get(paths[1]).color);
  assert.equal(notes.get(paths[3]).color, notes.get(paths[1]).color);
  assert.notEqual(notes.get(paths[1]).color, notes.get(paths[4]).color);
  assert.notEqual(notes.get(paths[1]).color, notes.get(paths[0]).color);
  assert.ok(groups.some(group => group.color === notes.get(paths[1]).color));
  assert.ok(clewGroups(people, notes).some(group => group.color === notes.get(paths[1]).color));
});

test("focus uses Clew's current applyFocus API and opens a centered local graph as fallback", async () => {
  const file = { path: "Case/Connections/a.md" };
  const called = [];
  const clew = { view: { pane: { applyFocus: (...args) => called.push(args) } } };
  const workspace = { getLeavesOfType: type => type === "clew-standalone-graph" ? [clew] : [], revealLeaf: async leaf => called.push(leaf) };
  await new GraphColorService({ app: { workspace } }).focus(file);
  assert.deepEqual(called[0], [file, 1, { highlightCenter: true, fitCamera: true }]);
  assert.equal(called[1], clew);
  workspace.getLeavesOfType = () => [];
  const fallback = { setViewState: async state => called.push(state) };
  workspace.getLeaf = () => fallback;
  await new GraphColorService({ app: { workspace } }).focus(file);
  assert.deepEqual(called[2], { type: "localgraph", state: { file: file.path }, active: true });
  assert.equal(called[3], fallback);
});
