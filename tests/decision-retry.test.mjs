import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const load = async path => {
  const result = await build({ entryPoints: [path], bundle: true, platform: "node", format: "esm", write: false });
  return import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].contents).toString("base64"));
};
const { retryDecision, DecisionAttemptsError } = await load("src/analysis/decisionRetry.ts");
const { validateDecision } = await load("src/analysis/ollama.ts");
const { resolveDecisionSettings, DEFAULT_MODEL_PROFILE } = await load("src/analysis/modelProfiles.ts");
const good = { candidate_id: "real", explanation: "Evidence", supporting_evidence: [], conflicting_evidence: [], uncertain: false };

test("unknown and malformed decisions retry up to three times, then a later source succeeds", async () => {
  let calls = 0;
  const failed = () => retryDecision(async () => { calls++; return validateDecision({ ...good, candidate_id: "invented" }, ["real"]); });
  await assert.rejects(failed(), error => error instanceof DecisionAttemptsError && error.attempts === 4);
  assert.equal(calls, 4);
  assert.deepEqual(await retryDecision(async () => validateDecision(good, ["real"])), good);
  let malformed = 0;
  assert.deepEqual(await retryDecision(async () => { malformed++; return validateDecision(malformed < 4 ? { ...good, uncertain: "yes" } : good, ["real"]); }), good);
  assert.equal(malformed, 4);
});

test("decision cancellation does not retry or skip", async () => {
  const abort = new AbortController(); abort.abort();
  let calls = 0;
  await assert.rejects(retryDecision(async () => { calls++; }, abort.signal), error => error.name === "AbortError");
  assert.equal(calls, 0);
});

test("decision profile inherits Chat, preserves custom prompt, or resolves independent settings", () => {
  const settings = { ...DEFAULT_MODEL_PROFILE, ollamaModel: "chat", decisionPrompt: "existing prompt", canvasModel: { ...DEFAULT_MODEL_PROFILE, inherit: false, ollamaModel: "canvas" } };
  assert.equal(resolveDecisionSettings(settings).ollamaModel, "chat");
  assert.equal(resolveDecisionSettings(settings).decisionPrompt, "existing prompt");
  settings.decisionModel = { ...DEFAULT_MODEL_PROFILE, prompt: "decision only" };
  assert.equal(resolveDecisionSettings(settings).decisionPrompt, "decision only");
  settings.decisionModel = { ...settings.decisionModel, inherit: false, ollamaModel: "decider", ollamaDevice: "cpu", ollamaContext: 2048, apiExtraParams: "options.num_thread=2" };
  const independent = resolveDecisionSettings(settings);
  assert.equal(independent.ollamaModel, "decider");
  assert.equal(independent.ollamaDevice, "cpu");
  assert.equal(independent.ollamaContext, 2048);
  assert.equal(independent.apiExtraParams, "options.num_thread=2");
});

test('decision Think remains independent when its model inherits Chat', () => {
  const settings = { ...DEFAULT_MODEL_PROFILE, ollamaThink: true,
    decisionModel: { ...DEFAULT_MODEL_PROFILE, ollamaThink: false } };
  assert.equal(resolveDecisionSettings(settings).ollamaThink, false);
  settings.ollamaThink = false;
  settings.decisionModel.ollamaThink = true;
  assert.equal(resolveDecisionSettings(settings).ollamaThink, true);
});
