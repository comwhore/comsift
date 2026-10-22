import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const result = await build({ entryPoints: ["src/analysis/prompts.ts"], bundle: true, platform: "node", format: "esm", write: false });
const m = await import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].contents).toString("base64"));

test("fillPrompt substitutes placeholders and falls back to the default when blank", () => {
  assert.equal(m.fillPrompt("Work in {folder}.", "DEFAULT", { folder: "Alice" }), "Work in Alice.");
  assert.equal(m.fillPrompt("   ", "Default for {folder}", { folder: "X" }), "Default for X");
  assert.equal(m.fillPrompt("Keep {unknown}", "D", {}), "Keep {unknown}");
  assert.ok(m.DEFAULT_CHAT_PROMPT.includes("{folder}") && m.DEFAULT_CHAT_PROMPT.includes("tools"));
});

test("shipped tag-based prompts migrate to tools while custom instructions are retained", () => {
  assert.equal(m.upgradeChatPrompt(m.LEGACY_CHAT_PROMPT), m.DEFAULT_CHAT_PROMPT);
  assert.equal(m.upgradeChatPrompt('Custom instructions: prefer short notes.'), 'Custom instructions: prefer short notes.');
  assert.equal(m.upgradeChatPrompt(null), m.DEFAULT_CHAT_PROMPT);
  assert.doesNotMatch(m.DEFAULT_CHAT_PROMPT, /<edit|<patch/);
});

test("Canvas assistant instructions expose uncertain as an arrow type", () => {
  assert.match(m.CANVAS_TOOL_RULES, /Arrow types:.*uncertain/);
  assert.match(m.CANVAS_TOOL_RULES, /type":"normal\|same\|related\|uncertain/);
});

test("identity prompt distinguishes account variants from evidenced relationships", () => {
  assert.match(m.DEFAULT_DECISION_PROMPT, /same real person/);
  assert.match(m.DEFAULT_DECISION_PROMPT, /Different usernames or names are NOT contradictions/);
  assert.match(m.DEFAULT_DECISION_PROMPT, /related = evidence of a family or romantic relationship/);
  assert.match(m.DEFAULT_DECISION_PROMPT, /never alternate accounts/);
  assert.doesNotMatch(m.DEFAULT_DECISION_PROMPT, /friends|friendship|mutuals/);
  assert.match(m.DEFAULT_DECISION_PROMPT, /Do not require matching first names/);
  assert.match(m.DEFAULT_DECISION_PROMPT, /does not need an explicit family or partner label/);
  assert.match(m.DEFAULT_DECISION_PROMPT, /common surname alone is weak evidence/);
  assert.match(m.DEFAULT_DECISION_PROMPT, /Only use different when actual contradictory evidence exists/);
  assert.ok(m.DEFAULT_DECISION_PROMPT.length > 0);
});

test("every shipped decision prompt upgrades while custom and blank overrides survive", () => {
  for (const previous of [m.PREVIOUS_REQUESTED_DECISION_PROMPT, m.PREVIOUS_CONNECTION_DECISION_PROMPT, m.PREVIOUS_IDENTITY_DECISION_PROMPT, m.PREVIOUS_DECISION_PROMPT, m.PREVIOUS_HUMAN_DECISION_PROMPT, m.PREVIOUS_PUBLIC_DECISION_PROMPT]) {
    assert.equal(m.upgradeDecisionPrompt(previous), m.DEFAULT_DECISION_PROMPT);
  }
  assert.equal(m.upgradeDecisionPrompt("My custom identity instructions"), "My custom identity instructions");
  assert.equal(m.upgradeDecisionPrompt(""), "");
  assert.equal(m.upgradeDecisionPrompt(m.DEFAULT_DECISION_PROMPT), m.DEFAULT_DECISION_PROMPT);
});

test('the earlier supplied public-profile prompt also gains corrected relationship semantics', () => {
 const earlier = m.PREVIOUS_PUBLIC_DECISION_PROMPT.split('\n').filter(line => !line.startsWith('Judge each candidate independently;')).join('\n');
 assert.equal(m.upgradeDecisionPrompt(earlier), m.DEFAULT_DECISION_PROMPT);
});
