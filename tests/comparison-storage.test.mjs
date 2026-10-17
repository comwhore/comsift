import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const bundled = await build({ entryPoints: ["src/analysis/service.ts"], bundle: true, platform: "node", format: "esm", write: false, loader: { ".py": "text" },
  plugins: [{ name: "mock", setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
    build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: 'export class Notice {} export class TFile {} export class TFolder {} export const normalizePath = x => x; export const requestUrl = () => {};', loader: "js" }));
  } }] });
const { AnalysisService } = await import("data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].contents).toString("base64"));

test("column discovery shares in-flight work and refreshes when source data changes", async () => {
  const service = new AnalysisService({});
  const file = { path: "a.csv", stat: { mtime: 1, size: 10 } };
  let calls = 0;
  service.listDatasets = () => [file];
  service.loadDatasets = async () => [{ name: "a.csv", csv: "name\nalice" }];
  Object.defineProperty(service, "runner", { get: () => ({ async run() { calls++; return [{ name: "a.csv", columns: ["name"] }]; } }) });
  const [a, b] = await Promise.all([service.discoverColumns(["a.csv"]), service.discoverColumns(["a.csv"])]);
  assert.deepEqual(a, b); assert.equal(calls, 1);
  file.stat.mtime++;
  await service.discoverColumns(["a.csv"]);
  assert.equal(calls, 2);
});

test("comparison scopes are stable, order independent and distinct for different sheet tabs", () => {
  const service = new AnalysisService({});
  assert.deepEqual(service.comparisonItem(["b.csv", "a.csv"]), service.comparisonItem(["a.csv", "b.csv", "a.csv"]));
  assert.notEqual(service.comparisonItem(["a.sheet.md#One", "b.csv"]).id, service.comparisonItem(["a.sheet.md#Two", "b.csv"]).id);
  assert.match(service.comparisonItem(["../../evil.csv", "b.csv"]).folderPath, /^Comsift\/Comparisons\/[a-f0-9]{64}$/);
});

test("standalone analysis persists a run and history in its scope, never in source folders", async () => {
  const writes = [];
  const plugin = { setting: { autoConfirmHighThreshold: 0 }, app: { vault: { async create(path, data) { writes.push({ path, data }); } } } };
  const service = new AnalysisService(plugin);
  const paths = ["Private/a.csv", "Other/b.csv"];
  const result = { records: [], pairs: [], jina: [] };
  service.loadDatasets = async () => paths.map(name => ({ name, csv: "username\nalice" }));
  service.runDatasets = async () => ({ result });
  service.remapReviews = async () => {};
  service.ensureFolder = async (item, relative) => `${item.folderPath}/${relative}`;
  let historyScope;
  service.recordHistory = async item => { historyScope = item; };
  assert.equal(await service.analyzeFiles(paths), result);
  assert.deepEqual(historyScope, service.comparisonItem(paths));
  assert.equal(writes.length, 1);
  assert.ok(writes[0].path.startsWith(service.comparisonItem(paths).folderPath + "/Analysis/run-"));
  assert.deepEqual(JSON.parse(writes[0].data).datasets, paths);
});

test("reruns remap persisted reviews to new row IDs without assigning old decisions to reused rows", async () => {
  const record = (id, username, dataset) => ({ id, dataset, row: 1, fields: { username }, raw: {} });
  const old = [record("a:1", "alice", "a"), record("b:1", "alice", "b")];
  const current = [record("a:1", "bob", "a"), record("b:1", "bob", "b"), record("a:2", "alice", "a"), record("b:2", "alice", "b")];
  const pair = (left_id, right_id) => ({ left_id, right_id, evidence: {} });
  let content = JSON.stringify({ "a:1 → b:1": { status: "confirmed" } });
  const file = {};
  const service = new AnalysisService({ app: { vault: { getFileByPath: () => file,
    async process(_file, update) { content = update(content); } } } });
  service.latestRun = async () => ({ records: old, pairs: [pair("a:1", "b:1")], jina: [] });
  await service.remapReviews({ id: "test", folderPath: "test" }, { records: current, pairs: [pair("a:1", "b:1"), pair("a:2", "b:2")], jina: [] });
  const reviews = JSON.parse(content);
  assert.equal(reviews["a:1 → b:1"], undefined);
  assert.equal(reviews["a:2 → b:2"].status, "confirmed");
  assert.equal(reviews["a:2 → b:2"].source_id, "a:2");
});

test("confirm then row shift then reopen removes the original graph link", async () => {
  const record = (id, dataset) => ({ id, dataset, row: 1, fields: { username: "alice" }, raw: {} });
  const old = [record("a:1", "a"), record("b:1", "b")];
  const shifted = [record("a:20", "a"), record("b:30", "b")];
  const result = records => ({ records, pairs: [{ left_id: records[0].id, right_id: records[1].id, evidence: {} }], jina: [] });
  let content = "{}";
  const file = {};
  const added = [], removed = [];
  const plugin = { app: { vault: { getFileByPath: () => file, read: async () => content,
    async process(_file, update) { content = update(content); } } }, graph: {
    async addConfirmedLink(_left, _right, key) { added.push(key); },
    async removeConfirmedLink(key) { removed.push(key); },
  } };
  const service = new AnalysisService(plugin);
  service.ensureFolder = async (item, relative) => `${item.folderPath}/${relative}`;
  service.profileNote = async (_item, record) => ({ path: record.id + ".md" });
  const item = { id: "comparison:test", folderPath: "Comsift/Comparisons/test" };
  await service.review(item, ...old, "confirmed");
  const originalKey = added[0];
  assert.equal(JSON.parse(content)["a:1 → b:1"].graph_id, originalKey);
  service.latestRun = async () => result(old);
  await service.remapReviews(item, result(shifted));
  assert.equal(JSON.parse(content)["a:20 → b:30"].graph_id, originalKey);
  await service.unreview(item, shifted[0].id, shifted[1].id);
  assert.deepEqual(removed, [originalKey]);
  assert.equal(JSON.parse(content)["a:20 → b:30"], undefined);
});

test("legacy row-based graph keys survive review remapping", async () => {
  const record = (id, dataset) => ({ id, dataset, row: 1, fields: { username: "alice" }, raw: {} });
  const old = [record("a:1", "a"), record("b:1", "b")];
  let content = JSON.stringify({ "a:1 → b:1": { status: "confirmed" } });
  const file = {};
  let removed;
  const service = new AnalysisService({ app: { vault: { getFileByPath: () => file, read: async () => content,
    async process(_file, update) { content = update(content); } } }, graph: {
    async removeConfirmedLink(key) { removed = key; }, async refreshInvestigation() {},
  } });
  service.latestRun = async () => ({ records: old, pairs: [{ left_id: "a:1", right_id: "b:1" }], jina: [] });
  const shifted = [record("a:4", "a"), record("b:9", "b")];
  const item = { id: "person", folderPath: "People/person" };
  await service.remapReviews(item, { records: shifted, pairs: [{ left_id: "a:4", right_id: "b:9" }], jina: [] });
  await service.unreview(item, "a:4", "b:9");
  assert.equal(removed, "a:1 → b:1");
});

test("a reused source row never returns the previous person's profile note", async () => {
  const old = { path: "Person/Analysis/Profiles/Alice.md" };
  const frontmatter = { comsift_account: "|alice", comsift_records: ["sheet:1"] };
  let created;
  const service = new AnalysisService({ app: { vault: {
    getMarkdownFiles: () => [old], getAbstractFileByPath: () => null,
    async create(path, body) { created = { path, body }; return created; },
  }, metadataCache: { getFileCache: () => ({ frontmatter }) }, fileManager: {} } });
  service.ensureFolder = async () => "Person/Analysis/Profiles";
  const profile = await service.profileNote({ id: "person", folderPath: "Person" }, {
    id: "sheet:1", dataset: "sheet", row: 1, fields: { username: "bob" }, raw: {},
  });
  assert.notEqual(profile, old);
  assert.equal(profile, created);
  assert.match(created.path, /bob\.md$/);
  assert.match(created.body, /comsift_account: "\|bob"/);
});

test("custom-only profiles reuse stable identity after a source row moves", async () => {
  const fields = { "column:email": "alice-at-example.test", "column:city": "City" };
  const frontmatter = { comsift_records: ["sheet:1"] };
  const old = { path: "Person/Analysis/Profiles/Account.md" };
  const service = new AnalysisService({ app: { vault: { getMarkdownFiles: () => [old] },
    metadataCache: { getFileCache: () => ({ frontmatter }) }, fileManager: {
      async processFrontMatter(_file, update) { update(frontmatter); },
    } } });
  service.ensureFolder = async () => "Person/Analysis/Profiles";
  frontmatter.comsift_account = service.accountKey(fields, "sheet:1");
  assert.equal(service.accountKey({ "column:city": "City", "column:email": "ALICE-AT-EXAMPLE.TEST" }, "sheet:90"), frontmatter.comsift_account);
  assert.equal(await service.profileNote({ id: "person", folderPath: "Person" }, {
    id: "sheet:90", dataset: "sheet", row: 90, fields, raw: {},
  }), old);
  assert.deepEqual(frontmatter.comsift_records, ["sheet:1", "sheet:90"]);
});

test("auto-confirm honors threshold, manual reviews, loaded scope and duplicate pairs", async () => {
  const plugin = { setting: { autoConfirmHighThreshold: .98 } };
  const service = new AnalysisService(plugin);
  service.reviews = async () => ({ "a → c": { status: "rejected" } });
  const calls = [];
  service.review = async (_item, source, candidate, status) => { calls.push([source.id, candidate.id, status]); };
  const records = ["a", "b", "c", "d"].map(id => ({ id, dataset: id, fields: { username: id }, raw: {}, row: 1 }));
  const pair = (left_id, right_id, evidence_score) => ({ left_id, right_id, evidence_score });
  const result = { records, pairs: [pair("a", "b", .98), pair("a", "c", 1), pair("a", "d", .97), pair("missing", "b", 1), pair("b", "a", 1), pair("c", "d", Number.NaN), pair("d", "b", Infinity)], jina: [] };
  assert.equal(await service.autoConfirm({ id: "person" }, result), 1);
  assert.deepEqual(calls, [["a", "b", "confirmed"]]);
  plugin.setting.autoConfirmHighThreshold = 0;
  assert.equal(await service.autoConfirm({ id: "person" }, result), 0);
});

test("normal chat includes read-only canvas connections and referenced profile notes", async () => {
  const canvas = { path: "Person/Person.canvas", basename: "Person", extension: "canvas", stat: { mtime: 1 } };
  const profile = { path: "Person/Analysis/Profiles/Alice.md", basename: "Alice", extension: "md", stat: { mtime: 1 } };
  const content = new Map([[canvas.path, JSON.stringify({ nodes: [
    { id: "a", type: "file", file: profile.path, x: 0, y: 0, width: 100, height: 100 },
    { id: "b", type: "text", text: "connected person", x: 100, y: 0, width: 100, height: 100 },
  ], edges: [{ id: "link", fromNode: "a", toNode: "b", label: "related" }] })], [profile.path, "# Alice\nProfile facts"]]);
  const service = new AnalysisService({ setting: { ollamaContext: 8000, chatLineNumbers: false }, app: {
    vault: { configDir: ".obsidian", getFiles: () => [canvas, profile], getFileByPath: path => [canvas, profile].find(file => file.path === path), cachedRead: async file => content.get(file.path) },
    metadataCache: { resolvedLinks: {} },
  }, investigations: { forPath: () => null } });
  const context = await service.chatContext(["Person"], "Who is connected?", null);
  assert.equal(context.canvases.length, 1);
  assert.match(context.canvases[0].digest.text, /related/);
  assert.ok(context.files.some(file => file.path === profile.path && file.content.includes("Profile facts")));
});
