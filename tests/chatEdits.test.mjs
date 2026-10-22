import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const result = await build({ entryPoints: ["src/analysis/chatEdits.ts"], bundle: true, platform: "node", format: "esm", write: false });
const m = await import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].contents).toString("base64"));

const note = "---\ncomsift_id: abc\ntitle: Alice\n---\n> [!comsift-links]- x\n> [[Alice/Other]]\n\n# Alice\n\nHello\n";

test("sanitizeForModel hides ids, markers and managed links", () => {
  const clean = m.sanitizeForModel("Alice/Alice.md", note);
  assert.equal(clean, "# Alice\n\nHello");
  assert.equal(m.sanitizeForModel("a.csv", "---\nx"), "---\nx");
});

test("parseEdits reads edit and patch tags", () => {
  const { text, edits } = m.parseEdits('Done.\n<patch path="a.md"><find>old</find><replace>new</replace></patch>\n<edit action="create" path="b.md">\n```md\n# B\n```\n</edit>');
  assert.equal(text, "Done.");
  assert.deepEqual(edits, [
    { action: "patch", path: "a.md", find: "old", content: "new" },
    { action: "create", path: "b.md", content: "# B" }]);
});

test("replace restores frontmatter and the links callout at the top; patch works on raw text", () => {
  const replaced = m.applyToText({ action: "replace", path: "S.md", content: "# Alice\n\nChanged" }, "S.md", note);
  assert.ok(replaced.startsWith("---\ncomsift_id: abc\ntitle: Alice\n---\n> [!comsift-links]- x\n> [[Alice/Other]]\n\n# Alice\n\nChanged"));
  assert.equal(m.applyToText({ action: "patch", path: "S.md", find: "Hello", content: "Bye" }, "S.md", note).includes("Bye"), true);
  assert.throws(() => m.applyToText({ action: "patch", path: "S.md", find: "nope", content: "x" }, "S.md", note));
});

test("diffLines marks additions and deletions", () => {
  const diff = m.diffLines("a\nb\nc", "a\nx\nc");
  assert.deepEqual(diff.map(l => l.kind), ["same", "del", "add", "same"]);
});

test("visibleWhileStreaming hides unfinished tags", () => {
  assert.deepEqual(m.visibleWhileStreaming('Hi <edit path="a.md">par'), { text: "Hi", pendingEdit: true });
});

test("append preserves original metadata and patch rejects ambiguous targets", () => {
  const edit = m.parseEdits('<edit action="append" path="a.md">New paragraph</edit>').edits[0];
  assert.equal(m.applyToText(edit, "a.md", "---\nid: safe\n---\nOld"), "---\nid: safe\n---\nOld\nNew paragraph");
  assert.throws(() => m.applyToText({ action: "patch", find: "old", content: "new" }, "a.md", "old old"), /more than once/);
  assert.equal(m.parseEdits('<edit action="delete" path="a.md">x</edit>').edits.length, 0);
});

test("creation converts a requested question title to a portable filename without weakening parent-path checks", () => {
  assert.equal(m.newNotePath('Person/Who is Person?.md'), 'Person/Who is Person.md');
  assert.equal(m.newNotePath('Person/Who is Person?'), 'Person/Who is Person.md');
  assert.equal(m.newNotePath('Person/CON.md'), 'Person/_CON.md');
  for (const path of ['../escape.md', 'Person/../escape.md', '.obsidian/config.json', '/outside.md', 'C:/outside.md', 'Person/\u0000bad.md', 'bad?/note.md']) {
    assert.throws(() => m.newNotePath(path));
  }
});

test("XML proposal fences do not swallow answer Markdown or leave orphan fences", () => {
  const answer = 'Here is **the note**.\n\n```xml\n<edit action="create" path="A.md">\n# Heading\n\n- item\n\n```mermaid\ngraph LR\nA --> B\n```\n</edit>\n```\n\nDone.';
  const parsed = m.parseEdits(answer);
  assert.equal(parsed.text, "Here is **the note**.\n\nDone.");
  assert.match(parsed.edits[0].content, /^# Heading/);
  assert.match(parsed.edits[0].content, /```mermaid/);
});
test("ordinary fenced HTML examples remain prose and cannot become edits", () => {
  const sample = 'Example:\n```html\n<edit action="create" path="Example.md">sample</edit>\n```';
  const parsed = m.parseEdits(sample);
  assert.equal(parsed.text, sample);
  assert.equal(parsed.edits.length, 0);
});
test("incomplete fenced proposals stay hidden while streaming", () => {
  const streamed = m.visibleWhileStreaming('Answer.\n\n```xml\n<edit action="create" path="A.md"># Heading');
  assert.equal(streamed.text, "Answer.");
  assert.equal(streamed.pendingEdit, true);
});
test("a file containing only a Mermaid diagram keeps its Markdown fence", () => {
  const diagram = "```mermaid\ngraph LR\nA --> B\n```";
  assert.equal(m.parseEdits(`<edit action="create" path="Diagram.md">${diagram}</edit>`).edits[0].content, diagram);
});
test("streaming diagrams remain plain code until final validation", () => {
  const draft = m.visibleWhileStreaming("Draft:\n```mermaid\ngraph LR\nA[unfinished (label)\n```");
  assert.match(draft.text, /```text/);
  assert.doesNotMatch(draft.text, /```mermaid/);
  assert.match(m.parseEdits("```mermaid\ngraph LR\nA --> B\n```").text, /```mermaid/);
});
test("unfinished final proposals leave readable prose without raw tags or orphan fences", () => {
  assert.equal(m.parseEdits('Answer.\n\n```xml\n<edit action="create" path="A.md">draft').text, "Answer.");
  assert.equal(m.parseEdits('Example:\n```html\n<edit action="create" path="A.md">example</edit>\n```').edits.length, 0);
});
test("note parser preserves complete Canvas and handoff tools for their own validated handlers", () => {
  const tools = '<canvas path="A.canvas">[]</canvas>\n<canvas-handoff path="A.canvas">edit it</canvas-handoff>';
  assert.equal(m.parseEdits(tools).text, tools);
});
