import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const bundled = await build({ entryPoints: ["src/analysis/columnMapping.ts"], bundle: true, platform: "node", format: "esm", write: false });
const { columnMismatches, datasetLabel } = await import("data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].contents).toString("base64"));
const dataset = (name, columns) => ({ name, columns });
test("mismatch compares effective mapping and prioritizes uncommon schemas", () => {
  const rows = [dataset("a", ["handle", "bio"]), dataset("b", ["username", "bio"]), dataset("z", ["account", "city"])];
  assert.equal(columnMismatches(rows, "{}")[0].name, "z");
  assert.deepEqual(columnMismatches(rows, "{}")[0].mismatching, ["account", "city"]);
  const mapped = columnMismatches(rows, JSON.stringify({ z: { username: "account", bio: "city" } }));
  assert.ok(mapped.every(row => !row.mismatch));
});
test("two datasets still report mismatches; ignored fields do not cause mismatches", () => {
  const rows = [dataset("a", ["username", "extra"]), dataset("b", ["username"])];
  assert.ok(columnMismatches(rows, "{}").every(row => row.mismatch));
  assert.ok(columnMismatches(rows, JSON.stringify({ a: { _ignore: "extra" } })).every(row => !row.mismatch));
  assert.equal(columnMismatches([rows[0]], "{}")[0].mismatch, false);
  assert.equal(datasetLabel("folder/book.sheet.md#Accounts"), "book.sheet#Accounts");
});
test("column aliases match the analysis parser's canonical fields", () => {
  const rows = [dataset("a", ["homepage", "account_id", "real name", "member since"]),
    dataset("b", ["website", "user_id", "display_name", "created"])];
  assert.ok(columnMismatches(rows, "{}").every(row => !row.mismatch));
});
