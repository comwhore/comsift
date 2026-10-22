import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const result = await build({ entryPoints: ["src/analysis/history.ts"], bundle: true, platform: "node", format: "esm", write: false });
const m = await import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].contents).toString("base64"));

const rec = (id, platform, username) => ({ id, dataset: id, row: 1, fields: { platform, username, display_name: "" }, raw: {} });
const run = (signals, score) => ({ records: [rec("a:1", "instagram", "that.guy"), rec("b:1", "tiktok", "silly.guy")],
  pairs: [{ left_id: "a:1", right_id: "b:1", evidence_score: score, evidence: { signals } }], jina: [] });

test("evidence accumulates across scans and survives row shifts", () => {
  const first = m.mergeRun({}, run({ username: 0.5 }, 0.5), "t1");
  const moved = run({ username: 0.5, display_name: 1 }, 0.8);
  moved.records[0].id = "a:7"; moved.pairs[0].left_id = "a:7";
  const second = m.mergeRun(first, moved, "t2");
  const entry = Object.values(second)[0];
  assert.equal(Object.keys(second).length, 1);
  assert.equal(entry.runs, 2);
  assert.equal(entry.first, "t1");
  assert.equal(entry.prev, 0.5);
  assert.deepEqual(entry.gained, ["display_name"]);
});
