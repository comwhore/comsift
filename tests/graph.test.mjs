import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

async function load(source) {
  const result = await build({ entryPoints: [source], bundle: true, platform: "node", format: "esm", write: false });
  return import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].contents).toString("base64"));
}

const { managedLinks, relationshipsFromCanvas } = await load("src/service/graphLogic.ts");
const canvasModel = await load("src/service/canvasModel.ts");
const { placeGroup } = await load("src/service/placement.ts");

test("managed graph links live in a property, skip manual links, deduplicate, then clean up", () => {
  const original = "# Person\n\nHandwritten [[Results/good|good result]] remains.\n";
  const once = managedLinks(original, ["Results/good", "Results/other", "Results/other"]);
  assert.equal(once, '---\ncomsift_links:\n  - "[[Results/other]]"\n---\n# Person\n\nHandwritten [[Results/good|good result]] remains.\n');
  assert.equal(managedLinks(once, ["Results/good", "Results/other"]), once);
  assert.equal(managedLinks(once, []), original);
  const manual = '---\nrelationships:\n  - "[[Results/other]]"\n---\nBody\n';
  assert.equal(managedLinks(manual, ["Results/other"]), manual);
});

test("Canvas arrows create links only between existing Markdown file nodes across folders", () => {
  const raw = JSON.stringify({
    nodes: [
      { id: "a", type: "file", file: "Alice/insta.md" },
      { id: "b", type: "file", file: "Bob/github.md" },
      { id: "c", type: "text", text: "unresolved" },
      { id: "d", type: "file", file: "gone.md" },
    ],
    edges: [
      { fromNode: "a", toNode: "b" }, { fromNode: "a", toNode: "b" },
      { fromNode: "b", toNode: "c" }, { fromNode: "a", toNode: "d" },
    ],
  });
  const links = relationshipsFromCanvas(raw, path => path !== "gone.md");
  assert.deepEqual(links, { "Alice/insta.md": ["Bob/github.md", "Bob/github.md"] });
});

test("positioning uses node dimensions and moves away from occupied space", () => {
  const source = { x: 0, y: 0, width: 340, height: 96 };
  assert.deepEqual(placeGroup(source, { width: 200, height: 100 }, "top", 50), { x: 70, y: -150 });
  const position = placeGroup(source, { width: 200, height: 100 }, "right", 50,
    [{ x: 390, y: 0, width: 200, height: 100 }]);
  assert.ok(position.y >= 124);
});
