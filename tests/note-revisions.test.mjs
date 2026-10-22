import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const bundle = await build({ entryPoints: ["src/analysis/service.ts"], bundle: true, platform: "node", format: "esm", write: false, loader: { ".py": "text" }, plugins: [{ name: "mock", setup(build) {
  build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
  build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: 'export class Modal {} export const loadMermaid = async () => ({ parse: async () => true }); export class Notice {} export class TFile {} globalThis.RevisionTFile = TFile; export class TFolder {} export const normalizePath = x => x; export const requestUrl = () => {};', loader: "js" }));
} }] });
const { AnalysisService } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].contents).toString("base64"));
function setup() {
  const files = new Map(), journal = new Map();
  const file = Object.assign(new globalThis.RevisionTFile(), { path: "Folder/a.md" });
  files.set(file.path, { file, text: "Original" });
  const adapter = { exists: async () => true, mkdir: async () => {}, write: async (path, text) => journal.set(path, text), list: async () => ({ files: [...journal.keys()] }), read: async path => journal.get(path) };
  const vault = { configDir: ".obsidian", adapter, getAbstractFileByPath: path => files.get(path)?.file, read: async file => files.get(file.path).text, process: async (file, update) => { files.get(file.path).text = update(files.get(file.path).text); }, create: async (path, text) => { const file = Object.assign(new globalThis.RevisionTFile(), { path }); files.set(path, { file, text }); return file; } };
  const service = new AnalysisService({ manifest: { id: "comsift" }, app: { vault, fileManager: { trashFile: async file => files.delete(file.path) } } });
  service.ensureRelativeFolder = async () => {};
  return { service, files, journal, vault };
}

test("approved append creates durable revision, undo restores and stale edits cannot apply", async () => {
  const { service, files, journal } = setup();
  const prepared = await service.prepareEdit(["Folder"], { action: "append", path: "Folder/a.md", content: "Addition" });
  await service.commitEdit(prepared);
  assert.equal(files.get(prepared.path).text, "Original\nAddition");
  assert.equal(journal.size, 1);
  assert.deepEqual(await service.recentEdits(), [prepared]);
  files.get(prepared.path).text += "\nManual change";
  await assert.rejects(service.undoEdit(prepared), /modified/);
  files.get(prepared.path).text = prepared.after;
  await service.undoEdit(prepared);
  assert.equal(files.get(prepared.path).text, "Original");
  files.get(prepared.path).text = "Concurrent edit";
  await assert.rejects(service.commitEdit(prepared), /changed since/);
  assert.equal(journal.size, 1);
});

test("new notes require approval and undo only the unchanged newly created file", async () => {
  const { service, files } = setup();
  const prepared = await service.prepareEdit(["Folder"], { action: "create", path: "New.md", content: "New note" });
  assert.equal(files.has("Folder/New.md"), false);
  await service.commitEdit(prepared);
  assert.equal(files.get("Folder/New.md").text, "New note");
  await service.undoEdit(prepared);
  assert.equal(files.has("Folder/New.md"), false);
});

test("corrupt and tampered revision records cannot write hidden paths or escape vault", async () => {
  const { service, journal } = setup();
  journal.set("bad.json", "not json");
  for (const path of ["../secret.md", ".obsidian/config.json", "/outside.md", "C:/secret.md"]) {
    const edit = { path, before: "old", after: "new", isNew: false };
    journal.set(path + ".json", JSON.stringify(edit));
    await assert.rejects(service.undoEdit(edit), /Invalid revision/);
    await assert.rejects(service.prepareEdit(["Folder"], { action: "replace", path, content: "new" }));
  }
  assert.deepEqual(await service.recentEdits(), []);
});

test("normal chat retries context overflow with less content and retains relation types", async () => {
  const { service } = setup();
  service.plugin.setting = { ollamaContext: 10000, canvasContextSelector: "local", ollamaThink: false };
  service.chatContext = async () => ({ canvases: [{ path: "board.canvas", digest: { text: "Long content ".repeat(100) }, summary: "node a; node b; a -> b type=uncertain" }], files: [], tree: [], bridges: [] });
  const requests = [];
  Object.defineProperty(service, "llm", { get: () => ({ chatStream: async request => { requests.push(request); if (requests.length === 1) throw new Error("context length exceeded"); return "Answer"; } }) });
  const response = await service.chat(["Folder"], "Question", [], () => {}, null);
  assert.equal(response.answer, "Answer");
  assert.equal(requests.length, 2);
  assert.match(requests[1].at(-1).content, /type=uncertain/);
  assert.ok(JSON.stringify(requests[1]).length < JSON.stringify(requests[0]).length);
});

test('question titles create reviewable safe new notes and never overwrite an existing file', async () => {
  const { service, files } = setup();
  const proposal = { action: 'create', path: 'Folder/Who is Person?.md', content: '# Who is Person?\n\nSummary' };
  const prepared = await service.prepareEdit(['Folder'], proposal);
  assert.equal(prepared.path, 'Folder/Who is Person.md');
  assert.equal(prepared.isNew, true);
  assert.equal(files.has(prepared.path), false);
  await service.commitEdit(prepared);
  assert.equal(files.get(prepared.path).text, proposal.content);
  await assert.rejects(service.prepareEdit(['Folder'], proposal), /already exists/);
});

test('arrow permission invokes the selected Jina classifier on the current prompt and fails closed', async () => {
  const { service } = setup();
  service.plugin.setting = { canvasContextSelector: 'jina', jinaModelPath: 'local-model', jinaDevice: 'cpu' };
  const requests = [];
  let rankings = [{ id: 'edit', score: .9 }, { id: 'read', score: .2 }];
  Object.defineProperty(service, 'runner', { get: () => ({ run: async request => { requests.push(request); return { rankings }; } }) });
  assert.equal(await service.authorizeArrowEdits('Create a note about the arrows'), false);
  assert.equal(requests.length, 0);
  assert.equal(await service.authorizeArrowEdits('Change the arrows to related'), true);
  assert.equal(requests[0].query, 'Change the arrows to related');
  rankings = [{ id: 'unknown', score: 1 }];
  assert.equal(await service.authorizeArrowEdits('Change the arrows to related'), false);
  rankings = [{ id: 'edit', score: .5 }, { id: 'read', score: .5 }];
  assert.equal(await service.authorizeArrowEdits('Change the arrows to related'), false);
});
