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

test("saved and transferred conversations strip handoffs without losing Canvas embeds", () => {
  const answer = 'See ![[Research.canvas#node1]]. <canvas-handoff path="Research.canvas">Move the node</canvas-handoff> Keep this explanation.';
  assert.equal(m.stripExecutableProposals(answer), 'See ![[Research.canvas#node1]].  Keep this explanation.');
  assert.equal(m.stripExecutableProposals('Earlier answer <canvas-handoff path="Research.canvas">unfinished'), 'Earlier answer');
  const saved = m.serializeChat({ folder: 'F', model: 'M', created: 'today', messages: [{ role: 'assistant', content: answer }] });
  assert.doesNotMatch(saved, /canvas-handoff/);
  assert.match(saved, /!\[\[Research.canvas#node1\]\]/);
});

test("retry transcripts preserve previous prompts and prose but never executable diffs", () => {
  const messages = [
    { role: "user", content: "First request" },
    { role: "assistant", content: 'Previous answer <patch path="a.md"><find>old</find><replace>new</replace></patch>' },
    { role: "user", content: "Edited request" },
    { role: "assistant", content: 'New answer <edit action="create" path="b.md">body</edit><canvas path="b.canvas">[]</canvas>' },
  ];
  const saved = m.serializeChat({ folder: "F", model: "M", created: "today", messages });
  assert.doesNotMatch(saved, /<patch|<edit|<canvas/);
  assert.deepEqual(m.parseChat(saved).messages.map(item => item.content), ["First request", "Previous answer", "Edited request", "New answer"]);
  const legacy = saved.replace("Previous answer", 'Previous answer <edit action="create" path="x.md">unsafe</edit>');
  assert.equal(m.parseChat(legacy).messages[1].content, "Previous answer");
});
