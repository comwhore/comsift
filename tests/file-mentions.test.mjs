import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const bundle = await build({ entryPoints: ["src/analysis/fileMentions.ts"], bundle: true, platform: "node", format: "esm", write: false });
const { mentionedPaths, prioritizeMentionFiles } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].contents).toString("base64"));

test("explicit file references support spaces, Canvas paths, quotes and deduplication", () => {
  assert.deepEqual(mentionedPaths('Read @[[People/A note.md]] and @"Board.canvas" plus @Data.csv @[[People/A note.md]]'), ["People/A note.md", "Board.canvas", "Data.csv"]);
});
test("ordinary emails and unmarked wiki links do not force context", () => {
  assert.deepEqual(mentionedPaths("Email me@example.com or read [[Note.md]] and @someone"), []);
});

test("mention picker lists current person first without including similarly named folders", () => {
  const files = ["Other/A.md", "Alice2/X.md", "Alice/Z.md", "Alice/A.md"].map(path => ({ path }));
  assert.deepEqual(prioritizeMentionFiles(files, "Alice/").map(file => file.path), ["Alice/A.md", "Alice/Z.md", "Alice2/X.md", "Other/A.md"]);
  assert.equal(files[0].path, "Other/A.md");
});

test("only explicit references, full paths and wiki links count as mentions", async () => {
  const { fileMentioned } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].contents).toString("base64"));
  assert.equal(fileMentioned("see @[[Bob/Profile.md]]", "Bob/Profile.md"), true);
  assert.equal(fileMentioned("open Bob/Profile.md please", "Bob/Profile.md"), true);
  assert.equal(fileMentioned("compare with [[Profile]]", "Bob/Profile.md"), true);
  assert.equal(fileMentioned("what does the profile say about Bob", "Bob/Profile.md"), false);
});

test("folder mentions end with a slash and cover the files inside", async () => {
  const mod = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].contents).toString("base64"));
  assert.deepEqual(mod.mentionedFolders("look at @[[People/Bob/]] and @[[Notes/a.md]]"), ["People/Bob"]);
  assert.equal(mod.fileMentioned("see @[[People/Bob/]]", "People/Bob/Profile.md"), true);
  assert.equal(mod.fileMentioned("see @[[People/Bob/]]", "People/Bobby/Profile.md"), false);
});
