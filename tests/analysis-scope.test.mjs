import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const mock = `export class Component {} export class FuzzySuggestModal {} export class ItemView {}
export class Modal {} export class Notice {} export class TFile {} export class TFolder {} export class WorkspaceLeaf {}
export class MarkdownView {} export const MarkdownRenderer = {}; export const htmlToMarkdown = () => ""; export async function loadMermaid() {} export function setIcon() {} export function setTooltip() {} export class Setting {}`;
const bundled = await build({ entryPoints: ["src/analysis/view.ts"], bundle: true, platform: "node", format: "esm", write: false, loader: { ".py": "text" },
  plugins: [{ name: "obsidian-mock", setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
    build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: mock, loader: "js" }));
  } }] });
const { AnalysisView } = await import("data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].contents).toString("base64"));

function setup() {
  const plugin = { setting: { splinkThreshold: .5, analysisLowThreshold: .2 }, analysis: { comparisonItem(paths) { return { id: "comparison:test", folderPath: "Comsift/Comparisons/test" }; }, async stageReview() { throw new Error("Override stageReview in setup"); } } };
  const staged = [];
  plugin.analysis.stageReview = async (...choice) => { staged.push(choice); };
  const view = new AnalysisView({}, plugin);
  const records = ["alice", "bob", "carol"].map((name, i) => ({ id: String(i), dataset: "dataset" + i, row: 1, fields: { username: name }, raw: {} }));
  view.result = { records, pairs: [
    { left_id: "0", right_id: "1", evidence_score: .8, evidence: {} },
    { left_id: "0", right_id: "2", evidence_score: .3, evidence: {} },
    { left_id: "missing", right_id: "1", evidence_score: .9, evidence: {} }], jina: [] };
  view.selectedDatasets = ["a.csv", "b.csv"];
  return { view, records, staged };
}

test("decision scope excludes hidden lower-score candidates, stale records, and orphans", async () => {
  const { view, records, staged } = setup();
  assert.equal(view.visibleResult().pairs.length, 1);
  await view.reviewPair(records[0], records[1], "confirmed");
  assert.equal(view.reviews["0 → 1"].status, "confirmed");
  assert.equal(view.reviews["0 → 1"].pending, true);
  assert.equal(staged.length, 1);
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

test("importing a root Canvas conversation enables root chat and discards stale review controls", () => {
  const { view } = setup();
  let rejected = false;
  view.pendingEdits.add(() => { rejected = true; });
  view.chatFolder = "Previous person";
  view.render = () => { view.composerInput = { value: "" }; };
  view.importConversation([{ role: "user", content: "Continue" }], "Follow up", "");
  assert.equal(view.chatFolder, "/");
  assert.equal(view.tab, "chat");
  assert.equal(view.composerInput.value, "Follow up");
  assert.equal(view.pendingEdits.size, 0);
  assert.equal(rejected, true);
});
test("import does not silently replace a busy normal chat", () => {
  const { view } = setup();
  view.controller = new AbortController();
  view.chatHistory = [{ role: "user", content: "Current question" }];
  assert.throws(() => view.importConversation([{ role: "user", content: "Other chat" }]), /Finish the current chat/);
  assert.equal(view.chatHistory[0].content, "Current question");
});

test('show lower-score results clears hiding filters and selects a lower-score source', () => {
  const { view } = setup();
  view.filter = 'confirmed'; view.search = 'no matching name';
  view.toggleLowerResults();
  assert.equal(view.showLow, true);
  assert.equal(view.filter, 'all');
  assert.equal(view.search, '');
  assert.equal(view.visibleResult().pairs.length, 2);
  assert.equal(view.selectedSource, '0');
  assert.equal(view.sourceRows(view.visibleResult()).length, 1);
  view.toggleLowerResults();
  assert.equal(view.showLow, false);
  assert.equal(view.visibleResult().pairs.length, 1);
});

test('source list does not discard lower-score sources after the first 300 records', () => {
  const { view } = setup();
  view.result.records = Array.from({ length: 303 }, (_, i) => ({ id: String(i), fields: { username: String(i) }, dataset: String(i), row: 1 }));
  view.result.pairs = Array.from({ length: 302 }, (_, i) => ({ left_id: String(i), right_id: '302', evidence_score: i < 300 ? .8 : .3 }));
  view.toggleLowerResults();
  assert.equal(view.sourceRows(view.visibleResult()).length, 302);
  assert.equal(view.selectedSource, '300');
});

test('lower-score sources appear before the first page of higher-score sources', () => {
  const { view } = setup();
  const records = Array.from({ length: 303 }, (_, i) => ({ id: String(i), fields: { username: String(i) }, dataset: String(i), row: 1 }));
  view.result = { records, pairs: Array.from({ length: 302 }, (_, i) => ({ left_id: String(i), right_id: '302', evidence_score: i < 300 ? .8 : .3 })), jina: [] };
  view.toggleLowerResults();
  assert.deepEqual(view.sourceRows(view.visibleResult()).slice(0, 2).map(row => row.id), ['300', '301']);
});


test("accepting AI review stages choices without applying profiles or relationships", async () => {
  const { view, records, staged } = setup();
  view.render = () => {};
  view.setStatus = () => {};
  view.applyChoices = () => { throw new Error("AI acceptance must not apply final choices"); };
  view.runReviewAction = (_label, run) => run(new AbortController().signal);
  await view.stageAiChoices([{ source: records[0], candidate: records[1], status: "related", reason: "explicit link" }]);
  assert.equal(staged.length, 1);
  assert.deepEqual(view.reviews["0 → 1"], { status: "related", pending: true });
});

test('confirming a current pair clears its detail without invoking AI', async () => {
  const {view,records}=setup();
  let finishes=0;
  const reviews={};
  view.plugin.analysis.review=async(_item,source,candidate,status)=>{reviews[`${source.id} → ${candidate.id}`]={status};};
  view.plugin.analysis.finishReviewBatch=async()=>{finishes++;};
  view.plugin.analysis.reviews=async()=>reviews;
  view.plugin.analysis.settleDecisions=async()=>{};
  view.plugin.analysis.reason=()=>{throw new Error('No automatic AI checks');};
  view.runReviewAction=(_label,run)=>run(new AbortController().signal);
  view.render=()=>{};view.setStatus=()=>{};
  view.selectedSource='0';view.reasoningSource='0';
  await view.applyChoices([{source:records[0],candidate:records[1],status:'related',reason:'Family evidence'}]);
  assert.equal(view.selectedSource,null);
  assert.equal(view.reasoningSource,null);
  assert.equal(finishes,1);
});
