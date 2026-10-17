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
