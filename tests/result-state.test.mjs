import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const result = await build({ entryPoints: ["src/analysis/resultState.ts"], bundle: true, platform: "node", format: "esm", write: false });
const { loadedPairs, runSummary } = await import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].contents).toString("base64"));
const record = (dataset, row, fields) => ({ id: `${dataset}:${row}`, dataset, row, fields, raw: fields });
const records = [record("a", 1, { "column:email": "a-at-example.test" }), record("b", 1, { "column:email": "a-at-example.test" })];
const pair = (score, left = records[0].id, right = records[1].id) => ({ left_id: left, right_id: right, evidence_score: score, evidence: { signals: { email: 1 } } });

test("rerun distinguishes new matches, stronger evidence, and lower-score candidates", () => {
  const previous = { records, pairs: [pair(.7)], jina: [] };
  assert.deepEqual(runSummary(previous, previous, .5, .2), { fresh: 0, updated: 0, low: 0, rerun: true });
  assert.equal(runSummary(previous, { ...previous, pairs: [pair(.8)] }, .5, .2).updated, 1);
  assert.equal(runSummary({ ...previous, pairs: [pair(.3)] }, previous, .5, .2).fresh, 1);
  assert.deepEqual(runSummary(previous, { ...previous, pairs: [pair(.3)] }, .5, .2), { fresh: 0, updated: 0, low: 1, rerun: true });
});

test("generic record identities survive row shifts and orphan pairs cannot enable actions", () => {
  const shifted = records.map(item => ({ ...item, id: item.dataset + ":10", row: 10 }));
  const previous = { records, pairs: [pair(.7)], jina: [] };
  const next = { records: shifted, pairs: [pair(.7, shifted[0].id, shifted[1].id), pair(.9, "missing", shifted[1].id)], jina: [] };
  assert.equal(loadedPairs(next).length, 1);
  assert.equal(runSummary(previous, next, .5, .2).fresh, 0);
});
