import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const result = await build({ entryPoints: ["src/service/canvasModel.ts"], bundle: true, platform: "node", format: "esm", write: false });
const m = await import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].contents).toString("base64"));
const node = (id, extra) => ({ id, x: 0, y: 0, width: 100, height: 50, ...extra });
const colors = { same: "#ff0000", related: "#888888", uncertain: "#e3b341" };

test("links follow arrows through text nodes; the main node is the person's note; types carry", () => {
  const data = { nodes: [node("comsift-main", { type: "text", text: "Sample Person" }), node("t", { type: "text", text: "sample_handle" }),
    node("a", { type: "file", file: "S/a.md" }), node("b", { type: "file", file: "S/b.sheet.md" }), node("c", { type: "file", file: "S/c.md" })],
    edges: [{ id: "1", fromNode: "comsift-main", toNode: "t" }, { id: "2", fromNode: "t", toNode: "a" },
      { id: "3", fromNode: "a", toNode: "b", label: "Sample Person" }, { id: "4", fromNode: "b", toNode: "c", comsift_type: "related" }] };
  const links = m.canvasLinks(data, "S/S.md", "Sample Person").map(link => `${link.from}>${link.to}:${link.type}`).sort();
  assert.deepEqual(links, ["S/S.md>S/a.md:normal", "S/a.md>S/b.sheet.md:same", "S/b.sheet.md>S/c.md:related"]);
});

test("arrow types round-trip through labels and markers", () => {
  const same = m.withArrowType({ id: "1", fromNode: "a", toNode: "b" }, "same", "Sample Person", colors);
  assert.equal(same.label, "Sample Person");
  assert.equal(m.arrowType(same, "Sample Person"), "same");
  const related = m.withArrowType(same, "related", "Sample Person", colors);
  assert.equal(related.label, "Sample Person");
  const uncertain = m.withArrowType(related, "uncertain", "Sample Person", colors);
  assert.equal(uncertain.label, "Sample Person");
  assert.equal(uncertain.color, colors.uncertain);
  assert.equal(m.arrowType(uncertain, "Sample Person"), "uncertain");
  const normal = m.withArrowType(uncertain, "normal", "Sample Person", colors);
  assert.equal(normal.label, "Sample Person");
  assert.equal(m.arrowType(normal, "Sample Person"), "normal");
  assert.equal(m.withArrowType({ id: "2", fromNode: "a", toNode: "b", label: "mine" }, "normal", "Sample Person", colors).label, "mine");
});

test("legacy Sherlock/Maigret group nodes are removed and results reattach to the source", () => {
  const data = { nodes: [node("src", { type: "text", text: "sample_handle" }), node("g", { type: "text", text: "Maigret\nsample_handle" }),
    node("r1", { type: "file", file: "S/Maigret/x.md" }), node("r2", { type: "file", file: "S/Maigret/y.md" })],
    edges: [{ id: "1", fromNode: "src", toNode: "g", fromSide: "left" }, { id: "2", fromNode: "g", toNode: "r1", fromSide: "left" },
      { id: "3", fromNode: "g", toNode: "r2", fromSide: "left" }] };
  const { data: flat, removed } = m.flattenToolGroups(data);
  assert.deepEqual(removed, ["g"]);
  assert.equal(flat.nodes.length, 3);
  assert.deepEqual(flat.edges.map(edge => `${edge.fromNode}>${edge.toNode}`).sort(), ["src>r1", "src>r2"]);
});

test("digest numbers nodes and edges; operations add, connect, retype, arrange and respect selection", () => {
  const data = { nodes: [node("comsift-main", { type: "text", text: "Sample Person" }), node("x9", { type: "text", text: "sample_handle", x: 300 }),
    node("y7", { type: "file", file: "S/a.md", x: 600 })], edges: [{ id: "q", fromNode: "comsift-main", toNode: "x9" }] };
  const digest = m.canvasDigest(data, { personName: "Sample Person", selected: ["x9"] });
  assert.match(digest.text, /node 1 \[main\] text="Sample Person"/);
  assert.match(digest.text, /node 2 \[selected\] text="sample_handle"/);
  assert.match(digest.text, /edge e1: 1 -> 2 .*type=normal/);
  let n = 0;
  const context = { digest, personName: "Sample Person", colors, newId: () => `new${++n}` };
  const { data: next, summary } = m.applyCanvasOps(data, [
    { op: "add", ref: "a", text: "tiktok", near: 2, direction: "right", type: "same" },
    { op: "connect", from: "a", to: 3, type: "related" },
    { op: "type", edges: ["e1"], type: "same" },
    { op: "arrange", node: 2, direction: "bottom" },
  ], context);
  assert.equal(summary.length, 4);
  assert.equal(next.nodes.length, 4);
  assert.equal(next.edges.find(edge => edge.fromNode === "x9" && edge.toNode === "new1").label, "Sample Person");
  assert.equal(next.edges.find(edge => edge.fromNode === "new1" && edge.toNode === "y7").comsift_type, "related");
  assert.equal(next.edges.find(edge => edge.id === "q").comsift_type, "same");
  assert.ok(next.nodes.find(entry => entry.id === "new1").y > 50);
  assert.throws(() => m.applyCanvasOps(data, [{ op: "delete", node: 1 }], context), /main node/);
  assert.throws(() => m.applyCanvasOps(data, [{ op: "text", node: 3, text: "x" }], { ...context, allowed: new Set(["x9"]) }), /outside the selection/);
  assert.throws(() => m.applyCanvasOps(data, [{ op: "move", node: 42, x: 0 }], context), /Unknown node 42/);
});

test("uncertain arrows remain uncertain through Canvas relationship chains", () => {
  const data = {
    nodes: [node("a", { type: "file", file: "A.md" }), node("b", { type: "text" }), node("c", { type: "file", file: "C.md" })],
    edges: [
      { id: "1", fromNode: "a", toNode: "b", comsift_type: "uncertain" },
      { id: "2", fromNode: "b", toNode: "c" },
    ],
  };
  assert.deepEqual(m.canvasLinks(data, null).map(link => link.type), ["uncertain"]);
});

test("AI Canvas operations apply the uncertain type and configured color", () => {
  const data = { nodes: [node("a"), node("b")], edges: [{ id: "e", fromNode: "a", toNode: "b" }] };
  const digest = m.canvasDigest(data);
  const result = m.applyCanvasOps(data, [{ op: "type", edge: "e1", type: "uncertain" }], {
    digest, personName: "Sample Person", colors, newId: () => "new",
  });
  assert.equal(result.data.edges[0].comsift_type, "uncertain");
  assert.equal(result.data.edges[0].label, "uncertain");
  assert.equal(result.data.edges[0].color, colors.uncertain);
});

test("model answers yield canvas operation blocks", () => {
  const parsed = m.parseCanvasEdits('Done.\n<canvas path="S/S.canvas">\n```json\n[{"op":"delete","node":3}]\n```\n</canvas>\n<canvas path="S/S.canvas">nope</canvas>');
  assert.equal(parsed.text, "Done.");
  assert.deepEqual(parsed.edits[0], { path: "S/S.canvas", ops: [{ op: "delete", node: 3 }] });
  assert.ok(parsed.edits[1].error);
});

test("review arrows add profile nodes beside their dataset and are removed with the review", () => {
  const data = { nodes: [node("comsift-main", { type: "text", text: "Sample Person" }), node("d", { type: "file", file: "S/data.sheet.md" })], edges: [] };
  let n = 0;
  const options = { personName: "Sample Person", colors, newId: () => `id${++n}` };
  const reviews = [{ key: "a → b", type: "same", left: { path: "S/Analysis/Profiles/a.md", dataset: "S/data.sheet.md" },
    right: { path: "S/Analysis/Profiles/b.md", dataset: "S/other.csv" } }];
  const once = m.syncReviewArrows(data, reviews, options);
  assert.equal(once.added, 1);
  assert.equal(once.data.nodes.length, 4);
  const typed = once.data.edges.find(edge => edge.comsift_review === "a → b");
  assert.equal(typed.label, "Sample Person");
  assert.equal(m.syncReviewArrows(once.data, reviews, options).added, 0);
  const cleared = m.syncReviewArrows(once.data, [], options);
  assert.equal(cleared.data.nodes.length, 2);
  assert.equal(cleared.data.edges.length, 0);
});

test("literal node IDs resolve only inside the provided digest and retain selection/main guards", () => {
  const data = { nodes: [node("visible-real-id"), node("hidden-real-id"), node("comsift-main")], edges: [{ id: "edge", fromNode: "visible-real-id", toNode: "hidden-real-id" }] };
  const digest = m.canvasDigest({ nodes: [data.nodes[0], data.nodes[2]], edges: [] });
  const context = { digest, personName: "Sample Person", colors, newId: () => "new" };
  const result = m.applyCanvasOps(data, [{ op: "delete", node: "visible-real-id" }], context);
  assert.deepEqual(result.data.nodes.map(n => n.id), ["hidden-real-id", "comsift-main"]);
  assert.deepEqual(result.data.edges, []);
  assert.throws(() => m.applyCanvasOps(data, [{ op: "delete", node: "hidden-real-id" }], context), /Unknown node/);
  assert.throws(() => m.applyCanvasOps(data, [{ op: "delete", node: "visible-real-id" }], { ...context, allowed: new Set(["comsift-main"]) }), /outside the selection/);
  assert.throws(() => m.applyCanvasOps(data, [{ op: "delete", node: "comsift-main" }], context), /main node/);
});

test("selected-only digest never leaks neighboring or all nodes, including empty selection", () => {
  const data = { nodes: [node("selected"), node("neighbor")], edges: [{ id: "e", fromNode: "selected", toNode: "neighbor" }] };
  const digest = m.canvasDigest(data, { onlySelected: true, selected: ["selected"] });
  assert.deepEqual([...digest.ids.values()], ["selected"]);
  assert.equal(digest.edgeIds.size, 0);
  assert.equal(m.canvasDigest(data, { onlySelected: true }).ids.size, 0);
});

test("new-node aliases with node prefix remain usable across creation, connect and move operations", () => {
  const data = { nodes: [node("node-existing")], edges: [] };
  const digest = m.canvasDigest(data);
  let id = 0;
  const result = m.applyCanvasOps(data, [
    { op: "add", ref: "nodeA", text: "First", near: "node-existing", connect: false },
    { op: "add", ref: "node1", text: "Second", near: "nodeA", connect: false },
    { op: "connect", from: "nodeA", to: "node1" },
    { op: "move", node: "node1", x: 900 },
  ], { digest, colors, personName: "Sample Person", newId: () => `id${++id}`, allowed: new Set(["node-existing"]) });
  const first = result.data.nodes.find(n => n.text === "First"), second = result.data.nodes.find(n => n.text === "Second");
  assert.equal(second.x, 900);
  assert.ok(result.data.edges.some(e => e.fromNode === first.id && e.toNode === second.id));
  assert.throws(() => m.applyCanvasOps(data, [{ op: "add", ref: "1", text: "shadow" }], { digest, colors, personName: "Sample Person", newId: () => "new" }), /already in use/);
});

test("lenient parsing: bare op arrays, path-less tags, truncated blocks", () => {
  const ops = '[{"op":"add","ref":"a","text":"test 4","near":"l-abc","direction":"bottom"}]';
  const fenced = m.parseCanvasEdits(`Adding it.\n\n\`\`\`json\n${ops}\n\`\`\``, "B/Board.canvas");
  assert.equal(fenced.edits.length, 1); assert.equal(fenced.edits[0].path, "B/Board.canvas"); assert.equal(fenced.text, "Adding it.");
  const bare = m.parseCanvasEdits(`Done.\n${ops}`, "B/Board.canvas");
  assert.equal(bare.edits[0].ops[0].op, "add"); assert.equal(bare.text, "Done.");
  const noPath = m.parseCanvasEdits(`<canvas>${ops.replace("}]", "},]")}</canvas>`, "B/Board.canvas");
  assert.equal(noPath.edits[0].error, undefined); assert.equal(noPath.edits[0].ops.length, 1);
  const cut = m.parseCanvasEdits(`<canvas path="B/Board.canvas">${ops}`, "B/Board.canvas");
  assert.equal(cut.edits[0].ops.length, 1);
  assert.equal(m.parseCanvasEdits(`\`\`\`json\n${ops}\n\`\`\``).edits.length, 0, "strict without a default path");
  assert.equal(m.parseCanvasEdits("```json\n[1,2]\n```", "B/Board.canvas").edits.length, 0);
});

test("hideCanvasOps hides finished and half-written operation JSON", () => {
  assert.equal(m.hideCanvasOps('Sure.\n\n```json\n[\n  {"op":"add","te'), "Sure.");
  assert.equal(m.hideCanvasOps('Sure.\n\n```json\n[{"op":"add"}]\n```\nAfter'), "Sure.\n\nAfter");
  assert.equal(m.hideCanvasOps('Sure.\n<canvas path="x.canvas">[{"op"'), "Sure.");
  assert.equal(m.hideCanvasOps("Sure <can"), "Sure");
  assert.equal(m.hideCanvasOps("```json\n{\"a\":1}\n```"), "```json\n{\"a\":1}\n```");
  assert.equal(m.hideCanvasOps("Use `a < b` here"), "Use `a < b` here");
});

test("arrow edits accept the style and direction wording models actually use", () => {
  const data = { nodes: [node("a"), node("b")], edges: [{ id: "e", fromNode: "a", toNode: "b" }] };
  const run = op => m.applyCanvasOps(data, [{ op: "edge", edge: "e1", ...op }], { digest: m.canvasDigest(data), personName: "P", colors, newId: () => "new" }).data.edges[0];
  assert.equal(run({ styleAttributes: { path: "dashed" } }).styleAttributes.path, "short-dashed");
  assert.equal(run({ style: "dotted" }).styleAttributes.path, "dotted");
  assert.equal(run({ dashed: true }).styleAttributes.path, "short-dashed");
  assert.equal(run({ styleAttributes: { pathfindingMethod: "Curved" } }).styleAttributes.pathfindingMethod, "bezier");
  const both = run({ direction: "both" });
  assert.equal(both.fromEnd, "arrow"); assert.equal(both.toEnd, "arrow");
  const reversed = run({ arrows: "reverse" });
  assert.equal(reversed.fromEnd, "arrow"); assert.equal(reversed.toEnd, "none");
  assert.throws(() => run({ styleAttributes: { path: "wavy" } }), /Invalid arrow style/);
});

test("Canvas chains: the weakest typed arrow on a path decides, the strongest path wins", () => {
  const data = { nodes: [node("comsift-main"), node("t", { type: "text", text: "nickname" }), node("t2", { type: "text", text: "plain" }),
    node("f", { type: "file", file: "P/Maigret/a.md" }), node("g", { type: "file", file: "P/Maigret/b.md" })], edges: [
    { id: "1", fromNode: "comsift-main", toNode: "t", comsift_type: "same" },
    { id: "2", fromNode: "t", toNode: "f", comsift_type: "uncertain" },
    { id: "3", fromNode: "comsift-main", toNode: "t2", comsift_type: "normal" },
    { id: "4", fromNode: "t2", toNode: "g", comsift_type: "same" },
    { id: "5", fromNode: "t", toNode: "g", comsift_type: "related" }] };
  const links = m.canvasLinks(data, "P/P.md", "P");
  const type = path => links.find(link => link.from === "P/P.md" && link.to === path)?.type;
  assert.equal(type("P/Maigret/a.md"), "uncertain");
  assert.equal(type("P/Maigret/b.md"), "same");
});
