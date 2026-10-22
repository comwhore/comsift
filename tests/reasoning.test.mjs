import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const bundle = await build({ entryPoints: ["src/analysis/ollama.ts"], bundle: true, platform: "node", format: "esm", write: false });
const { splitReasoning } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].contents).toString("base64"));

test("reasoning in think tags is removed from the reply, finished or still streaming", () => {
  assert.deepEqual(splitReasoning("<think>plan it</think>\nAnswer"), { text: "Answer", thinking: "plan it" });
  assert.deepEqual(splitReasoning("Hi <think>still going"), { text: "Hi ", thinking: "still going" });
  assert.equal(splitReasoning("Answer <thi").text, "Answer ");
  assert.equal(splitReasoning("a < b and <b>bold</b>").text, "a < b and <b>bold</b>");
});

test("decisions carry a verdict per candidate and unanswered candidates stay uncertain", async () => {
  const { validateDecision, summarizeVerdicts } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].contents).toString("base64"));
  const base = { candidate_id: "a", explanation: "x", supporting_evidence: [], conflicting_evidence: [], uncertain: false };
  const ok = validateDecision({ ...base, verdicts: [{ candidate_id: "a", verdict: "same", reason: "r" }] }, ["a", "b"]);
  assert.deepEqual(ok.verdicts.map(entry => [entry.candidate_id, entry.verdict]), [["a", "same"], ["b", "uncertain"]]);
  assert.throws(() => validateDecision({ ...base, verdicts: [{ candidate_id: "z", verdict: "same", reason: "r" }] }, ["a"]));
  assert.throws(() => validateDecision({ ...base, verdicts: [{ candidate_id: "a", verdict: "maybe", reason: "r" }] }, ["a"]));
  assert.deepEqual(summarizeVerdicts([{ candidate_id: "a", verdict: "different", reason: "" }, { candidate_id: "b", verdict: "related", reason: "" }]), { candidate_id: "b", uncertain: false });
  assert.deepEqual(summarizeVerdicts([{ candidate_id: "a", verdict: "different", reason: "" }]), { candidate_id: "NO_MATCH", uncertain: false });
});


test('decision profile filtering protects enriched and previous profile data', async () => {
  const {decisionProfile}=await import("data:text/javascript;base64,"+Buffer.from(bundle.outputFiles[0].contents).toString("base64"));
  const profile=decisionProfile({decisionIgnoredFields:'secret,notes'}, {fields:{username:'visible','column:secret':'private','id:secret':'private alias',notes:'private notes',comsift_records:'internal path',_comsift_key:'internal id',bio:'public bio'}});
  assert.deepEqual(profile,{username:'visible',bio:'public bio'});
});
