import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const built = await build({ entryPoints: ["src/service/profilePaths.ts"], bundle: true, platform: "node", format: "esm", write: false });
const { connectionNeighborhood, connectionScope } = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].contents).toString("base64"));
test("connection depth follows undirected relationships without including duplicate cycles", () => {
  const links = [["a", "b"], ["b", "c"], ["b", "a"], ["c", "d"]];
  assert.deepEqual([...connectionNeighborhood("a", links, 0)], [["a", 0]]);
  assert.deepEqual([...connectionNeighborhood("a", links, 1)], [["a", 0], ["b", 1]]);
  assert.deepEqual([...connectionNeighborhood("a", links, 2)], [["a", 0], ["b", 1], ["c", 2]]);
});
test("connection scope supports current notes and old generated-profile paths", () => {
  assert.equal(connectionScope("Person/Connections/A.md"), "Person");
  assert.equal(connectionScope("Comsift/Comparisons/hash/Analysis/Profiles/A.md"), "Comsift/Comparisons/hash");
  assert.equal(connectionScope("Person/Analysis/reviews.json"), null);
});
