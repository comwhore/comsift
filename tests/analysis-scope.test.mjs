import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const mock = `export class Component {} export class FuzzySuggestModal {} export class ItemView {}
export class Modal {} export class Notice {} export class TFile {} export class TFolder {} export class WorkspaceLeaf {}
export class MarkdownView {} export const MarkdownRenderer = {};`;
const bundled = await build({ entryPoints: ["src/analysis/view.ts"], bundle: true, platform: "node", format: "esm", write: false,
  plugins: [{ name: "obsidian-mock", setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
    build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: mock, loader: "js" }));
  } }] });
const { AnalysisView } = await import("data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].contents).toString("base64"));

function setup() {
  const plugin = { setting: { splinkThreshold: .5, analysisLowThreshold: .2 }, analysis: { comparisonItem(paths) { return { id: "comparison:test", folderPath: "Comsift/Comparisons/test" }; }, async review() {} } };
  const view = new AnalysisView({}, plugin);
  const records = ["alice", "bob", "carol"].map((name, i) => ({ id: String(i), dataset: "dataset" + i, row: 1, fields: { username: name }, raw: {} }));
  view.result = { records, pairs: [
    { left_id: "0", right_id: "1", evidence_score: .8, evidence: {} },
    { left_id: "0", right_id: "2", evidence_score: .3, evidence: {} },
    { left_id: "missing", right_id: "1", evidence_score: .9, evidence: {} }], jina: [] };
  view.selectedDatasets = ["a.csv", "b.csv"];
  return { view, records };
}

test("decision scope excludes hidden lower-score candidates, stale records, and orphans", async () => {
  const { view, records } = setup();
  assert.equal(view.visibleResult().pairs.length, 1);
  await view.reviewPair(records[0], records[1], "confirmed");
  assert.equal(view.reviews["0 → 1"].status, "confirmed");
  await assert.rejects(view.reviewPair(records[0], records[2], "confirmed"), /no longer loaded/);
  await assert.rejects(view.reviewPair({ ...records[0] }, records[1], "confirmed"), /no longer loaded/);
  view.showLow = true;
  assert.equal(view.visibleResult().pairs.length, 2);
  await view.reviewPair(records[0], records[2], "uncertain");
});

test("source list and bulk scope respect the current filter and search", () => {
  const { view } = setup();
  assert.equal(view.sourceRows(view.visibleResult()).length, 1);
  view.search = "unknown";
  assert.equal(view.sourceRows(view.visibleResult()).length, 0);
  view.search = "alice";
  view.filter = "decided";
  assert.equal(view.sourceRows(view.visibleResult()).length, 0);
  view.reviews["0 → 1"] = { status: "confirmed" };
  assert.equal(view.sourceRows(view.visibleResult()).length, 1);
});

test("loading another investigation invalidates old decisions and blocks running jobs", async () => {
  const { view, records } = setup();
  let finish;
  view.render = () => {};
  view.setStatus = () => {};
  view.plugin.analysis.latestRun = () => new Promise(resolve => { finish = resolve; });
  view.plugin.analysis.previousDecisions = async () => ({});
  view.plugin.analysis.reviews = async () => ({});
  view.plugin.analysis.history = async () => ({});
  const selecting = view.select({ id: "other", folderPath: "other" });
  assert.equal(view.loading, true);
  await assert.rejects(view.reviewPair(records[0], records[1], "confirmed"), /no longer loaded/);
  let ran = false;
  view.job("test", async () => { ran = true; }, () => {});
  assert.equal(ran, false);
  finish(null);
  await selecting;
  assert.equal(view.loading, false);
  assert.equal(view.result, null);
});


test("returning to an investigation reloads persisted results, reviews and history", async () => {
  const { view } = setup();
  const restored = { records: [], pairs: [], jina: [] };
  view.render = () => {};
  view.plugin.analysis.latestRun = async () => restored;
  view.plugin.analysis.previousDecisions = async () => ({});
  view.plugin.analysis.reviews = async () => ({ saved: { status: "related" } });
  view.plugin.analysis.history = async () => ({ saved: { runs: 4 } });
  await view.select({ id: "person", folderPath: "People/person" });
  assert.equal(view.selectedDatasets, null);
  assert.equal(view.result, restored);
  assert.equal(view.reviews.saved.status, "related");
  assert.equal(view.history.saved.runs, 4);
});

test("standalone comparison reloads saved state and ignores a stale scope response", async () => {
  const { view } = setup();
  view.render = () => {};
  let finish;
  view.plugin.analysis.latestRun = () => new Promise(resolve => { finish = resolve; });
  view.plugin.analysis.previousDecisions = async () => ({});
  view.plugin.analysis.reviews = async () => ({ saved: { status: "related" } });
  view.plugin.analysis.history = async () => ({});
  const loading = view.loadComparison();
  assert.equal(view.loading, true);
  view.resetResults();
  finish({ records: [], pairs: [], jina: [] });
  await loading;
  assert.equal(view.result, null);
  assert.deepEqual(view.reviews, {});
});
