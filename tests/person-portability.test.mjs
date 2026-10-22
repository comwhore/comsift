import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
const bundle = await build({ entryPoints: ["src/service/personPortability.ts"], bundle: true, platform: "node", format: "esm", write: false });
const { safeRelativePath, relocatePersonText } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);

test("folder relocation preserves nested links, canvas paths and unrelated paths", () => {
  const text = '[[Old/Alice/Connections/Bob]] {"file":"Old/Alice/Alice.md"} [[Other/Bob]]';
  assert.equal(relocatePersonText(text, "Old/Alice", "People/Alice"), '[[People/Alice/Connections/Bob]] {"file":"People/Alice/Alice.md"} [[Other/Bob]]');
});

test("folder import refuses traversal, absolute and ambiguous paths", () => {
  for (const path of ["../note.md", "a/../note.md", "/tmp/note", "C:\\note.md", "a//note", "a/./note"]) assert.throws(() => safeRelativePath(path));
  assert.equal(safeRelativePath("Alice\\Sheets\\followers.sheet.md"), "Alice/Sheets/followers.sheet.md");
});

test("converting an already open spreadsheet does not replace navigation history", async () => {
  const source = await readFile("excel-modded/main.js", "utf8");
  const method = source.match(/  async setExcelView\(leaf\) \{([\s\S]*?)\n  \}/)[1];
  const convert = vm.runInNewContext(`(async function(leaf) {${method}})`, { VIEW_TYPE_EXCEL: "excel" });
  let calls = 0;
  const leaf = { view: { getViewType: () => "excel", getState: () => ({file:"A.sheet.md"}) }, setViewState: async () => { calls++; } };
  await convert(leaf);
  assert.equal(calls, 0);
  leaf.view.getViewType = () => "markdown";
  await convert(leaf);
  assert.equal(calls, 1);
});
