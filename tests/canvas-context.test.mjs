import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";

async function load(path) {
  const built = await build({ entryPoints: [path], bundle: true, platform: "node", format: "esm", write: false, loader: { ".py": "text" } });
  return import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].contents).toString("base64"));
}
const context = await load("src/analysis/canvasContext.ts");
const profiles = await load("src/analysis/modelProfiles.ts");
const node = (id, text, file) => ({ id, type: file ? "file" : "text", text, ...(file ? { file } : {}), x: 0, y: 0, width: 200, height: 100 });
const board = { nodes: [node("a", "apples"), node("b", "oranges"), node("c", "pears")], edges: [{ id: "ab", fromNode: "a", toNode: "b" }] };
function plugin() {
  return { setting: { ollamaUrl: "http://127.0.0.1:11434", ollamaModel: "main", ollamaContext: 8192, ollamaTimeout: 5,
    aiProvider: "ollama", canvasModel: { inherit: true }, contextSelectorModel: { inherit: true },
    canvasContextSelector: "local", canvasContextNodes: 2 },
    app: { vault: { configDir: ".obsidian", getFileByPath: () => null } } };
}

test("Canvas and selector profiles isolate model, provider, credentials, prompts and request parameters", () => {
  const p = plugin();
  p.setting.canvasModel = { ...profiles.DEFAULT_MODEL_PROFILE, inherit: false, aiProvider: "openai", ollamaModel: "canvas", apiKey: "canvas-test-key", apiExtraParams: "temperature=0.4", prompt: "Be concise" };
  p.setting.contextSelectorModel = { ...profiles.DEFAULT_MODEL_PROFILE, inherit: false, ollamaModel: "selector", ollamaContext: 4096, apiExtraParams: "options.temperature=0", prompt: "Rank carefully" };
  assert.equal(profiles.resolveCanvasSettings(p.setting).ollamaModel, "canvas");
  assert.equal(profiles.resolveSelectorSettings(p.setting).ollamaModel, "selector");
  assert.equal(profiles.resolveSelectorSettings(p.setting).apiKey, "");
  assert.equal(p.setting.ollamaModel, "main");
  p.setting.contextSelectorModel.inherit = true;
  assert.equal(profiles.resolveSelectorSettings(p.setting).apiKey, "canvas-test-key");
  assert.equal(profiles.resolveSelectorSettings(p.setting).prompt, "Rank carefully");
});

test("explicit captured selection and Everything cannot be narrowed by relevance settings", async () => {
  const p = plugin(); p.setting.canvasContextSelector = "model";
  const selected = await context.selectCanvasContext(p, board, "summarize", { mode: "selected", selected: ["a"] });
  assert.deepEqual(selected.data.nodes.map(n => n.id), ["a"]);
  assert.equal(selected.data.edges.length, 0);
  const all = await context.selectCanvasContext(p, board, "all", { mode: "everything", selected: [] });
  assert.equal(all.data.nodes.length, 3);
  await assert.rejects(context.selectCanvasContext(p, board, "hello", { mode: "selected", selected: ["missing"] }), /No captured nodes/);
});

test("context selector accepts known IDs only and file excerpts contribute to local relevance", () => {
  assert.deepEqual(context.parseSelectedNodes('```json\n{"ids":["b","b"]}\n```', new Set(["a", "b"])), ["b"]);
  assert.throws(() => context.parseSelectedNodes('{"ids":["unknown"]}', new Set(["a"])), /unknown node IDs/);
  assert.equal(context.rankCanvasNodes(board, "budget", [], new Map([["c", "budget approval"]]))[0], "c");
});

test("assistant context selector uses its own API profile and falls back safely on unknown IDs", async () => {
  let requested;
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", chunk => { text += chunk; });
    req.on("end", () => {
      requested = { path: req.url, key: req.headers.authorization, body: JSON.parse(text) };
      res.end('data: {"choices":[{"delta":{"content":"{\\"ids\\":[\\"unknown\\"]}"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const p = plugin(); p.setting.canvasContextSelector = "model";
    p.setting.contextSelectorModel = { ...profiles.DEFAULT_MODEL_PROFILE, inherit: false, aiProvider: "openai", apiBaseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "selector-test", ollamaModel: "selector-model" };
    const selected = await context.selectCanvasContext(p, board, "oranges", { mode: "needed", selected: [] });
    assert.equal(requested.body.model, "selector-model"); assert.equal(requested.key, "Bearer selector-test");
    assert.match(selected.report, /Local fallback/);
    assert.ok(selected.data.nodes.some(n => n.id === "b"));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
