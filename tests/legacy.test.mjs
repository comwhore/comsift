import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const result = await build({ entryPoints: ["src/service/legacy.ts"], bundle: true, platform: "node", format: "esm", write: false });
const { safeName, stripLegacyBlocks, legacyPairId } = await import(
  "data:text/javascript;base64," + Buffer.from(result.outputFiles[0].contents).toString("base64"));

test("migration strips only generated JSON represented in Canvas and keeps handwritten content", () => {
  const graph = { nodes: [{ id: "a", text: "Alice" }], edges: [{ id: "e" }] };
  const md = ["---", "whereami:", "  id: legacy-1", "---", "# Alice", "",
    "Handwritten note.", "", "<!-- whereami:graph:start -->", "```json",
    JSON.stringify(graph), "```", "<!-- whereami:graph:end -->", ""].join("\n");
  const canvas = JSON.stringify({ nodes: [{ id: "a", type: "text", text: "Alice" }], edges: [{ id: "e", fromNode: "a", toNode: "a" }] });
  assert.equal(legacyPairId(md), "legacy-1");
  const stripped = stripLegacyBlocks(md, canvas);
  assert.match(stripped, /Handwritten note/);
  assert.doesNotMatch(stripped, /whereami:graph:start/);
  const changedCanvas = JSON.stringify({ nodes: [{ id: "a", text: "Changed" }], edges: [] });
  assert.equal(stripLegacyBlocks(md, changedCanvas), md);
});

test("investigation names reject path traversal and invalid filenames", () => {
  for (const value of ["..", "a/b", "trailing.", ""]) assert.throws(() => safeName(value));
  assert.equal(safeName(" Alice "), "Alice");
});
