import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const result = await build({ entryPoints: ["src/service/canvasLive.ts"], bundle: true, platform: "node", format: "esm", write: false });
const { replaceLiveCanvas } = await import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].contents).toString("base64"));
const node = id => ({ id, type: "text", text: id, x: 0, y: 0, width: 100, height: 50 });

test("live replacement deletes omitted nodes and edges, isolates prior user edits and creates one native undo step", () => {
  const prior = { nodes: [node("a"), node("b")], edges: [{ id: "ab", fromNode: "a", toNode: "b" }] };
  let current = structuredClone(prior);
  let pendingUserEdit = true;
  const history = [{ nodes: [node("a")], edges: [] }];
  const calls = [];
  const canvas = {
    requestPushHistory: { run() { calls.push("flush"); if (pendingUserEdit) history.push(structuredClone(current)); pendingUserEdit = false; } },
    getData() { return structuredClone(current); },
    importData(data, replace) { calls.push(`import:${replace}`); current = replace ? structuredClone(data) : { nodes: [...current.nodes, ...data.nodes], edges: [...current.edges, ...data.edges] }; },
    pushHistory(data) { calls.push("history"); history.push(structuredClone(data)); },
    requestSave(record = true) { calls.push(`save:${record}`); if (record) history.push(structuredClone(current)); },
  };
  replaceLiveCanvas(canvas, { nodes: [node("a")], edges: [] });
  assert.deepEqual(calls, ["flush", "import:true", "history", "save:false"]);
  assert.deepEqual(current.nodes.map(n => n.id), ["a"]);
  assert.deepEqual(current.edges, []);
  assert.equal(history.length, 3);
  // Native history undo restores the deleted objects; redo returns the accepted snapshot.
  assert.deepEqual(history.at(-2), prior);
  assert.deepEqual(history.at(-1), current);
});

test("older live Canvas still replaces data and uses its regular history save", () => {
  const calls = [];
  const data = { nodes: [], edges: [] };
  replaceLiveCanvas({ importData(value, replace) { calls.push([value, replace]); }, requestSave() { calls.push("save"); } }, data);
  assert.deepEqual(calls, [[data, true], "save"]);
});
