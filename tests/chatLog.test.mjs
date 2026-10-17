import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const result = await build({ entryPoints: ["src/analysis/chatLog.ts"], bundle: true, platform: "node", format: "esm", write: false });
const m = await import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].contents).toString("base64"));

test("chat transcript round-trips through readable Markdown", () => {
  const log = { folder: "Alice", model: "qwen3.5:9b", created: "2026-10-15T20:00:00.000Z", messages: [
    { role: "user", content: "Summarize **everything**" },
    { role: "assistant", content: "## Summary\n\n```mermaid\ngraph TD; A-->B\n```\n\n- one\n- two" }] };
  const text = m.serializeChat(log);
  assert.ok(text.includes("# Summarize everything"));
  assert.deepEqual(m.parseChat(text), log);
});

test("parseChat ignores ordinary notes", () => {
  assert.equal(m.parseChat("# just a note"), null);
});
