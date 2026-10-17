import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const result = await build({ entryPoints: ["src/analysis/prompts.ts"], bundle: true, platform: "node", format: "esm", write: false });
const m = await import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].contents).toString("base64"));

test("fillPrompt substitutes placeholders and falls back to the default when blank", () => {
  assert.equal(m.fillPrompt("Work in {folder}.", "DEFAULT", { folder: "Alice" }), "Work in Alice.");
  assert.equal(m.fillPrompt("   ", "Default for {folder}", { folder: "X" }), "Default for X");
  assert.equal(m.fillPrompt("Keep {unknown}", "D", {}), "Keep {unknown}");
  assert.ok(m.DEFAULT_CHAT_PROMPT.includes("{folder}") && m.DEFAULT_CHAT_PROMPT.includes("<patch"));
});

test("Canvas assistant instructions expose uncertain as an arrow type", () => {
  assert.match(m.CANVAS_TOOL_RULES, /Arrow types:.*uncertain/);
  assert.match(m.CANVAS_TOOL_RULES, /type":"normal\|same\|related\|uncertain/);
});
