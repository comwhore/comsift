import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const result = await build({ entryPoints: ["src/analysis/sheets.ts"], bundle: true, platform: "node", format: "esm", write: false });
const m = await import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].contents).toString("base64"));

const md = `---\n\nexcel-plugin: parsed\n\n---\n\n\n# Excel\n[{"name":"people","rows":{"0":{"cells":{"0":{"text":"username"},"2":{"text":"bio, \\"x\\""}}},"2":{"cells":{"0":{"text":"alice"}}},"len":100},"cols":{"len":26}},{"name":"empty","rows":{"len":100}}]`;

test("parseSheetMd extracts non-empty sheets as dense grids", () => {
  const tables = m.parseSheetMd(md);
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].rows, [["username", "", 'bio, "x"'], ["", "", ""], ["alice", "", ""]]);
});

test("toCsv quotes commas and quotes; unparseable input yields no sheets", () => {
  assert.equal(m.toCsv([["a,b", 'c"d']]), '"a,b","c""d"\n');
  assert.deepEqual(m.parseSheetMd("# Excel\nnot json"), []);
  assert.equal(m.isSheetPath("A/b.sheet.md"), true);
});
