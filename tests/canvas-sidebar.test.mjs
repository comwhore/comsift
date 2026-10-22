import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['src/analysis/canvasAssistant.ts'], bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.py': 'text' },
  plugins: [{ name: 'obsidian-test', setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'test' }));
    build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `export class Component {} export const MarkdownRenderer = {}; export async function loadMermaid() {} export class ItemView { constructor(leaf) {this.app=leaf.app;} } export class Notice {} export function htmlToMarkdown(node) { return node.textContent; } export function setIcon() {} export function normalizePath(path) { return path; } export function requestUrl() { throw new Error('Network not expected'); }` }));
  } }],
});
const { CanvasAssistant, openCanvasAssistant } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
function fixture() {
  const app = { workspace: {} };
  const plugin = { app };
  const leaf = { app };
  const view = new CanvasAssistant(leaf, plugin);
  leaf.view = view;
  return { app, plugin, leaf, view };
}
test('Canvas conversation transfer refuses pending edits without resetting the board or requests', async () => {
  const { app, plugin, leaf, view } = fixture();
  view.path = 'Original.canvas';
  view.pending = [{ label: 'keep me' }];
  let opened = false;
  leaf.setViewState = async () => { opened = true; };
  app.workspace.getLeavesOfType = () => [leaf];
  await assert.rejects(openCanvasAssistant(plugin, 'Other.canvas', {}, { messages: [{ role: 'user', content: 'continue' }] }), /Finish or discard/);
  assert.equal(opened, false);
  assert.equal(view.path, 'Original.canvas');
  assert.equal(view.pending[0].label, 'keep me');
  assert.throws(() => view.importConversation([]), /Finish or discard/);
});
test('Canvas imports readable conversation and editable prompt without executing tools', () => {
  const { view } = fixture();
  const rendered = [];
  view.log = { empty() {} };
  view.input = { value: '', focus() {} };
  view.bubble = (role, content) => rendered.push({ role, content });
  view.importConversation([{ role: 'system', content: 'excluded' }, { role: 'user', content: 'Explain it' }, { role: 'assistant', content: 'Here. <canvas path="Test.canvas">[]</canvas><canvas-handoff path="Test.canvas">do things</canvas-handoff>' }], 'Edit this prompt');
  assert.deepEqual(rendered, [{ role: 'user', content: 'Explain it' }, { role: 'assistant', content: 'Here.' }]);
  assert.equal(view.input.value, 'Edit this prompt');
  assert.equal(view.pending.length, 0);
});
test('Canvas dropdown lists person boards and independent boards, excluding hidden files', () => {
  const { view, plugin, app } = fixture();
  const options = [];
  view.boardSelect = { empty() {}, createEl(tag, option) { options.push(option); }, value: '' };
  view.path = 'People/A/A.canvas';
  app.vault = { getFiles: () => ['Sketch.canvas', 'People/A/A.canvas', '.hidden/Other.canvas', 'Other.md'].map(path => ({ path, extension: path.split('.').at(-1) })) };
  const person = { folderPath: 'People/A' };
  plugin.canvasTools = { personFor: path => ({ item: path.startsWith('People/A/') ? person : null }) };
  plugin.investigations = { canvasPath: () => 'People/A/A.canvas' };
  view.refreshBoards();
  assert.deepEqual(options, [{ value: 'People/A/A.canvas', text: 'People/A (person)' }, { value: 'Sketch.canvas', text: 'Sketch.canvas' }]);
  assert.equal(view.boardSelect.value, 'People/A/A.canvas');
});
