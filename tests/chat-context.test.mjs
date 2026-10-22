import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const out = await build({ entryPoints: ["src/analysis/service.ts"], bundle: true, platform: "node", format: "esm", write: false, loader: { ".py": "text" }, plugins: [{ name: "context-boundaries", setup(b) {
  b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
  b.onResolve({ filter: /^\.\/ollama$/ }, () => ({ path: "llm", namespace: "mock" }));
  b.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ contents: args.path === "obsidian" ? 'export class Modal {} export const loadMermaid = async () => ({ parse: async () => true }); export class Notice {} export class TFile {} export class TFolder {} export const normalizePath=x=>x;' : 'export const traceClient = client => client; export const summarizeVerdicts = () => ({ candidate_id: "NO_MATCH", uncertain: false }); export const createClient = settings => ({ chatStream: async messages => globalThis.chatContextClient(settings,messages) });' }));
} }] });
const { AnalysisService } = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].contents).toString("base64"));
function setup(enabled) {
  const contents = new Map([["Elsewhere/Secret.md", "Complete forced document\n" + "evidence\n".repeat(300)], ["Outside/Board.canvas", JSON.stringify({ nodes: [{ id: "real-id", type: "text", text: "Project decision", x: 0, y: 0, width: 200, height: 100 }], edges: [] })]]);
  const files = [...contents.keys()].map(path => ({ path, basename: path.split("/").at(-1).split(".")[0], extension: path.split(".").at(-1), stat: { mtime: 1 } }));
  const plugin = { setting: { ollamaContext: 8192, chatContextAssistantEnabled: enabled, chatContextSelectorModel: { inherit: false, ollamaContext: 8192, ollamaModel: "collector", prompt: "Select context." } }, app: { vault: { getFiles: () => files, getFileByPath: path => files.find(file => file.path === path), cachedRead: async file => contents.get(file.path) } }, investigations: { forPath: () => null } };
  const service = new AnalysisService(plugin);
  service.chatContext = async () => ({ canvases: [], files: [{ path: "Scope/Noise.md", content: "unrelated existing file", role: "folder", truncated: false }], snapshot: new Map(), tree: [], bridges: [], omitted: 0 });
  return { service, contents };
}
test("forced files outside the selected folder reach the action model in full", async () => {
  const { service, contents } = setup(false);
  let request;
  globalThis.chatContextClient = (_settings, messages) => { request = messages; return "answer"; };
  await service.chat(["Scope"], "Read @[[Elsewhere/Secret.md]]", [], () => {}, null);
  assert.ok(request.at(-1).content.includes(contents.get("Elsewhere/Secret.md").trim().split("\n").at(-1)));
  assert.match(request.at(-1).content, /L301: evidence/);
});
test("context assistant selects outside Canvas, loads real IDs and excludes unrelated scope context", async () => {
  const { service } = setup(true);
  let action;
  globalThis.chatContextClient = (settings, messages) => {
    if (settings.ollamaModel === "collector") { assert.match(messages.at(-1).content, /Project decision/); return '{"items":[{"id":"Outside/Board.canvas","density":"full"}]}'; }
    action = messages; return "answer";
  };
  await service.chat(["Scope"], "Explain project decision from Outside/Board.canvas", [], () => {}, null);
  assert.match(action.at(-1).content, /real-id/);
  assert.match(action.at(-1).content, /Project decision/);
  assert.doesNotMatch(action.at(-1).content, /unrelated existing file/);
});
test("context assistant never offers files outside the chosen folder unless the user names them", async () => {
  const { service } = setup(true);
  let offered = "";
  globalThis.chatContextClient = (settings, messages) => {
    if (settings.ollamaModel === "collector") { offered = messages.at(-1).content; return '{"items":[]}'; }
    return "answer";
  };
  await assert.rejects(service.chat(["Scope"], "Explain project decision", [], () => {}, null), /no room for file context/);
  assert.equal(offered, "");
});
