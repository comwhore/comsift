import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const result = await build({ entryPoints: ["src/service/canvasRelations.ts"], bundle: true, platform: "node", format: "esm", write: false, external: ["obsidian"] });
const { canvasRelationMap, inheritedRelation, clearCanvasRelation } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

test("Canvas arrows: same-person chains and typed links relative to the person", () => {
  const map = canvasRelationMap([
    { from: "P/P.md", to: "P/Maigret/alice.md", type: "same" },
    { from: "P/Maigret/alice.md", to: "P/Maigret/alice_alt.md", type: "same" },
    { from: "P/P.md", to: "P/Maigret/bob.md", type: "uncertain" },
    { from: "P/Maigret/alice.md", to: "P/Maigret/carol.md", type: "related" },
    { from: "P/Other.md", to: "P/Maigret/dave.md", type: "same" },
  ], "P/P.md");
  assert.equal(map.get("P/Maigret/alice.md"), "same");
  assert.equal(map.get("P/Maigret/alice_alt.md"), "same");
  assert.equal(map.get("P/Maigret/bob.md"), "uncertain");
  assert.equal(map.get("P/Maigret/carol.md"), "related");
  assert.equal(map.has("P/Maigret/dave.md"), false);
});

test("Source files never establish identity or relationship for their contained profiles", () => {
  const map = new Map([["P/Maigret/alice.md", "same"], ["P/Maigret/bob.md", "uncertain"]]);
  assert.equal(inheritedRelation(map, "P/Connections/alice.md", ["P/Maigret/bob.md", "P/Maigret/alice.md"]), null);
  map.set("P/Connections/alice.md", "related");
  assert.equal(inheritedRelation(map, "P/Connections/alice.md", ["P/Maigret/alice.md"]), "related");
  assert.equal(inheritedRelation(map, "P/Connections/x.md", ["P/Maigret/none.md"]), null);
});

const node = (id, file) => ({ id, type: file ? "file" : "text", ...(file ? {file} : {}), x: 0, y: 0, width: 10, height: 10 });
test("remove an inherited related link through the main person's same account", () => {
  const data = { nodes: [node("main", "P/P.md"), node("a", "a.md"), node("b", "b.md"), node("other", "other.md")], edges: [
    {id:"ma",fromNode:"main",toNode:"a",comsift_type:"same"},
    {id:"ab",fromNode:"a",toNode:"b",comsift_type:"related"},
    {id:"bo",fromNode:"b",toNode:"other",comsift_type:"related"},
  ] };
  assert.equal(clearCanvasRelation(data,"P/P.md","P/P.md","b.md"),true);
  assert.equal(data.edges[0].comsift_type,"same");
  assert.equal(data.edges[1].comsift_type,"normal");
  assert.equal(data.edges[2].comsift_type,"related");
});
test("remove handles paths through text nodes and keeps other account relationships", () => {
  const data = {nodes:[node("main","P/P.md"),node("text"),node("a","a.md"),node("b","b.md")],edges:[
    {id:"mt",fromNode:"main",toNode:"text",comsift_type:"normal"},
    {id:"ta",fromNode:"text",toNode:"a",comsift_type:"same"},
    {id:"ab",fromNode:"a",toNode:"b",comsift_type:"same"},
  ]};
  assert.equal(clearCanvasRelation(data,"P/P.md","P/P.md","a.md"),true);
  assert.equal(data.edges[1].comsift_type,"normal");
  assert.equal(data.edges[2].comsift_type,"normal");
});
test("changing a non-primary related pair preserves their other same-person arrows", () => {
 const data={nodes:[node("main","P/P.md"),node("a","a.md"),node("b","b.md"),node("c","c.md")],edges:[
  {id:"ma",fromNode:"main",toNode:"a",comsift_type:"same"},
  {id:"ab",fromNode:"a",toNode:"b",comsift_type:"related"},
  {id:"ac",fromNode:"a",toNode:"c",comsift_type:"same"},
 ]};
 clearCanvasRelation(data,"P/P.md","a.md","b.md");
 assert.deepEqual(data.edges.map(edge=>edge.comsift_type),["same","normal","same"]);
});
