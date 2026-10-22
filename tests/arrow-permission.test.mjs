import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const result = await build({ entryPoints: ['src/analysis/arrowPermission.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const m = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'));
const board = () => ({ nodes: ['a', 'b'].map((id, i) => ({ id, type: 'text', x: i * 300, y: 0, width: 100, height: 100 })), edges: [{ id: 'ab', fromNode: 'a', toNode: 'b', fromSide: 'right', toSide: 'left', label: 'friend', comsiftType: 'related' }] });
test('only a current explicit arrow mutation request can grant tools', () => {
  for (const prompt of ['Change the arrows to related', 'connect A to B', 'Edit the arrow labels', 'Create a new connection', 'Remove all arrows', 'Change the text inside this arrow', 'Set the color of the arrows', 'Change the routing of these connections', "change all of them nodes' arrows to be dashed.", 'make the arrows dotted']) assert.equal(m.explicitArrowRequest(prompt), true, prompt);
  for (const prompt of ['Summarize the canvas', 'Explain these arrows', 'Create a note about connections', 'Do not change arrows', 'Move the nodes without changing arrows', 'Why did you change the arrows?']) assert.equal(m.explicitArrowRequest(prompt), false, prompt);
  for (const answer of ['{"allowArrowEdits":true}', '```json\n{"allowArrowEdits":true}\n```']) assert.equal(m.modelArrowGrant(answer), true);
  for (const answer of ['true', '{"allowArrowEdits":"true"}', 'sure', 'null', '{}']) assert.equal(m.modelArrowGrant(answer), false);
});
test('runtime denies arrow rewiring, label/type mutations, deletion through a node, and new old-node connections', () => {
  const before = board();
  for (const mutate of [b => b.edges[0].label = 'changed', b => b.edges[0].comsiftType = 'same', b => b.edges[0].toNode = 'a', b => b.edges = [], b => { b.nodes.pop(); b.edges = []; }, b => b.edges.push({ id: 'ba', fromNode: 'b', toNode: 'a' }), b => b.edges[0].fromSide = 'bottom']) {
    const after = structuredClone(before); mutate(after);
    assert.throws(() => m.assertArrowPermission(before, after, false), /request/);
    assert.doesNotThrow(() => m.assertArrowPermission(before, after, true));
  }
});
test('new-node automatic arrows and geometry rerouting remain available without arrow edit access', () => {
  const before = board(), after = structuredClone(before);
  after.nodes[1].y = 300; after.edges[0].fromSide = 'bottom';
  after.nodes.push({ id: 'new', type: 'text', x: 500, y: 300, width: 100, height: 100 });
  after.edges.push({ id: 'new-arrow', fromNode: 'a', toNode: 'new' });
  assert.doesNotThrow(() => m.assertArrowPermission(before, after, false));
});
