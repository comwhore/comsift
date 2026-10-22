import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['src/service/canvasChanges.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { applyCanvasChange } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
const node = (id, x = 0) => ({ id, x, y: 0, width: 100, height: 50 });
const base = { nodes: [node('a'), node('b')], edges: [], custom: 'preserved' };
test('independent proposal operations can be accepted separately in either order', () => {
  const step1 = { ...base, nodes: [node('a', 10), node('b')] };
  const step2 = { ...base, nodes: [node('a', 10), node('b', 20)] };
  const first = { before: base, after: step1, label: 'move a' };
  const second = { before: step1, after: step2, label: 'move b' };
  const reversed = applyCanvasChange(applyCanvasChange(base, second), first);
  assert.deepEqual(reversed, step2);
  assert.deepEqual(base.nodes, [node('a'), node('b')]);
});
test('dependent changes refuse a rejected prerequisite', () => {
  const added = { ...base, nodes: [...base.nodes, node('new')] };
  const edited = { ...added, nodes: [...base.nodes, node('new', 10)] };
  assert.throws(() => applyCanvasChange(base, { before: added, after: edited }), /depends/);
  const connected = { ...added, edges: [{ id: 'e', fromNode: 'a', toNode: 'new' }] };
  assert.throws(() => applyCanvasChange(base, { before: added, after: connected }), /connected nodes/);
});
test('deletion accepts exact removal of nodes and associated arrows', () => {
  const connected = { ...base, edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }] };
  const removed = { ...base, nodes: [node('a')], edges: [] };
  assert.deepEqual(applyCanvasChange(connected, { before: connected, after: removed }), removed);
});
test('selected-only snapshot rejects hidden arrow mutations and allows deletion cleanup', async () => {
  const { assertCanvasSelection } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
  const connected = { ...base, edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }] };
  assert.throws(() => assertCanvasSelection(connected, { ...connected, edges: [] }, new Set(['a'])), /arrows outside/);
  assert.throws(() => assertCanvasSelection(connected, { ...connected, edges: [{ ...connected.edges[0], color: 'red' }] }, new Set(['a'])), /arrows outside/);
  assert.doesNotThrow(() => assertCanvasSelection(connected, { ...base, nodes: [node('b')], edges: [] }, new Set(['a'])));
  assert.doesNotThrow(() => assertCanvasSelection(connected, { ...connected, edges: [] }, new Set(['a', 'b'])));
  assert.throws(() => assertCanvasSelection(base, { ...base, nodes: [node('a'), node('b', 20)] }, new Set(['a'])), /nodes outside/);
});
test('move and color on the same node are independent field changes', () => {
  const moved = { ...base, nodes: [node('a', 10), node('b')] };
  const colored = { ...moved, nodes: [{ ...node('a', 10), color: '#008f0a' }, node('b')] };
  const move = { before: base, after: moved };
  const color = { before: moved, after: colored };
  const colorOnly = applyCanvasChange(base, color);
  assert.deepEqual(colorOnly.nodes[0], { ...node('a'), color: '#008f0a' });
  assert.deepEqual(applyCanvasChange(colorOnly, move), colored);
  assert.deepEqual(applyCanvasChange(applyCanvasChange(base, move), color), colored);
});
test('two moves of the same coordinate preserve the operation prerequisite', () => {
  const moved = { ...base, nodes: [node('a', 10), node('b')] };
  const movedAgain = { ...base, nodes: [node('a', 20), node('b')] };
  const second = { before: moved, after: movedAgain };
  assert.throws(() => applyCanvasChange(base, second), /depends/);
  assert.deepEqual(applyCanvasChange(moved, second), movedAgain);
});
test('field deletion retains independent changes and rejects changed prerequisite', () => {
  const before = { ...base, nodes: [{ ...node('a'), color: 'red', label: 'old' }, node('b')] };
  const after = { ...base, nodes: [{ ...node('a'), label: 'old' }, node('b')] };
  const live = { ...before, nodes: [{ ...before.nodes[0], label: 'new' }, node('b')] };
  assert.deepEqual(applyCanvasChange(live, { before, after }).nodes[0], { ...node('a'), label: 'new' });
  assert.throws(() => applyCanvasChange({ ...live, nodes: [{ ...live.nodes[0], color: 'blue' }, node('b')] }, { before, after }), /depends/);
});
