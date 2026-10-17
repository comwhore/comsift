import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const output = await build({ entryPoints: ['src/analysis/canvasAssistant.ts'], bundle: true, platform: 'node', format: 'esm', write: false, plugins: [{ name: 'sidebar-boundaries', setup(build) {
  build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'mock' }));
  build.onResolve({ filter: /^\.\/canvasContext$/ }, () => ({ path: 'context', namespace: 'mock' }));
  build.onResolve({ filter: /^\.\/ollama$/ }, () => ({ path: 'client', namespace: 'mock' }));
  build.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: args.path === 'obsidian'
    ? 'export class ItemView { constructor(leaf) { this.app=leaf.app; } } export class Notice {} export function setIcon() {} export const Modifier = {};'
    : args.path === 'context' ? 'export function resolveCanvasSettings() { throw new Error("Stale request reached context"); } export function selectCanvasContext() {}'
    : 'export function createClient() {}' }));
} }] });
const { CanvasAssistant } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].contents).toString('base64'));
const plugin = { setting: { canvasContextMode: 'needed' }, canvasTools: {} };
const board = (...ids) => ({ selection: new Set(ids.map(id => ({ id }))) });
const view = () => {
  const assistant = new CanvasAssistant({ app: {} }, plugin);
  assistant.changes = { empty() {} }; assistant.log = { empty() {} };
  assistant.send = { disabled: false };
  return assistant;
};
test('same-board reopen preserves captured selected-only scope until explicit recapture', () => {
  const assistant = view();
  assistant.setBoard('a.canvas', board('a'), { selectedIds: ['a'], onlySelected: true });
  assistant.setBoard('a.canvas', board('b'));
  assert.deepEqual(assistant.selectedIds, ['a']);
  assert.equal(assistant.onlySelected, true);
  assistant.setBoard('a.canvas', board('b'), { selectedIds: ['b'], onlySelected: true });
  assert.deepEqual(assistant.selectedIds, ['b']);
});
test('switching boards aborts the old controller and stale async response cannot continue', async () => {
  const assistant = view(); assistant.bubble = () => ({ setText() {} });
  let finishRead;
  plugin.canvasTools.read = () => new Promise(resolve => { finishRead = resolve; });
  assistant.setBoard('a.canvas', board('a'));
  const request = assistant.respond('summarize');
  const oldController = assistant.controller;
  assistant.setBoard('b.canvas', board('b'));
  assert.equal(oldController.signal.aborted, true);
  const newController = new AbortController(); assistant.controller = newController; assistant.send.disabled = true;
  finishRead({ nodes: [], edges: [] }); await request;
  assert.equal(assistant.controller, newController);
  assert.equal(assistant.send.disabled, true);
  assert.equal(assistant.path, 'b.canvas');
  assert.deepEqual(assistant.pending, []);
});
