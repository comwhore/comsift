import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
async function load(path) {
  const result = await build({ entryPoints: [path], bundle: true, format: 'esm', platform: 'node', write: false });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'));
}
const [model, review, preview] = await Promise.all(['src/service/canvasModel.ts', 'src/service/canvasChanges.ts', 'src/analysis/canvasEdgePreview.ts'].map(load));
const node = (id, x = 0) => ({ id, x, y: 0, width: 100, height: 50 });
const base = { nodes: [node('a'), node('b', 300)], edges: [] };
const context = { digest: model.canvasDigest(base), personName: 'person', colors: { same: '1', related: '2', uncertain: '3' }, newId: () => 'edge' };
test('arrow labels, colors, endpoints and Advanced Canvas styles survive independent edits', () => {
  const connected = model.applyCanvasOps(base, [{ op: 'connect', from: 1, to: 2, label: 'knows', color: '#abcdef', fromEnd: 'arrow', styleAttributes: { path: 'dotted', arrow: 'diamond-outline', pathfindingMethod: 'square' } }], context).data;
  assert.equal(connected.edges[0].comsift_type, 'normal');
  assert.equal(connected.edges[0].label, 'knows');
  const changed = model.applyCanvasOps(connected, [{ op: 'edge', edge: 'edge', label: 'met in 2025', styleAttributes: { path: 'long-dashed' } }], { ...context, digest: model.canvasDigest(connected) }).data;
  assert.equal(changed.edges[0].label, 'met in 2025');
  assert.equal(changed.edges[0].color, '#abcdef');
  assert.equal(changed.edges[0].fromEnd, 'arrow');
  assert.deepEqual(changed.edges[0].styleAttributes, { path: 'long-dashed', arrow: 'diamond-outline', pathfindingMethod: 'square' });
  assert.match(model.canvasDigest(changed).text, /styleAttributes=.*square/);
  assert.throws(() => model.applyCanvasOps(connected, [{ op: 'edge', edge: 'edge', styleAttributes: { arrow: 'script' } }], { ...context, digest: model.canvasDigest(connected) }), /Invalid arrow style/);
  assert.deepEqual(connected.edges[0].styleAttributes, { path: 'dotted', arrow: 'diamond-outline', pathfindingMethod: 'square' });
});
test('review disables connections until node creation is accepted and rejection removes dependent edits', () => {
  const added = { ...base, nodes: [...base.nodes, node('new', 500)] };
  const connected = { ...added, edges: [{ id: 'e', fromNode: 'a', toNode: 'new' }] };
  const colored = { ...connected, nodes: connected.nodes.map(value => value.id === 'b' ? { ...value, color: '2' } : value) };
  const create = { before: base, after: added, label: 'create' };
  const connect = { before: added, after: connected, label: 'connect' };
  const color = { before: connected, after: colored, label: 'color' };
  assert.match(review.canvasChangeBlocker(base, connect), /connected nodes/);
  assert.equal(review.canvasChangeBlocker(review.applyCanvasChange(base, create), connect), null);
  assert.deepEqual(review.remainingCanvasChanges(base, [create, connect, color], create), [color]);
});
test('edge preview uses ports, defaults to curves and respects final direction', () => {
  const geometry = preview.canvasEdgeGeometry({}, base, { id: 'e', fromNode: 'a', toNode: 'b' });
  assert.deepEqual(geometry.a, { x: 100, y: 25 });
  assert.deepEqual(geometry.b, { x: 300, y: 25 });
  assert.match(geometry.path, /^M 100 25 C /);
  assert.equal(Math.abs(geometry.toAngle), 0);
  assert.equal(preview.canvasColor('3'), 'rgb(var(--canvas-color-3))');
  assert.equal(preview.canvasColor('#aabbcc'), '#aabbcc');
  assert.equal(preview.canvasColor('url(unsafe)'), 'var(--text-muted)');
});
test('Advanced Canvas routing receives only detached proposed geometry', () => {
  const frozen = structuredClone(base);
  let called = false;
  const app = { plugins: { getPlugin: id => {
    assert.equal(id, 'advanced-canvas');
    return { canvasExtensions: [{ getArrowPolygonPoints() {}, onEdgeChanged(canvas, edge) {
      called = true;
      assert.equal(canvas.isDragging, false);
      assert.equal(canvas.nodes.get('b').getBBox().minX, 300);
      assert.ok(canvas.dirty.has(edge));
      edge.path.display.setAttr('d', 'M 100 25 L 180 25 L 300 25');
      edge.center = { x: 180, y: 25 };
    } }] };
  } } };
  const result = preview.canvasEdgeGeometry(app, base, { id: 'e', fromNode: 'a', toNode: 'b', styleAttributes: { pathfindingMethod: 'a-star' } });
  assert.equal(called, true);
  assert.equal(result.path, 'M 100 25 L 180 25 L 300 25');
  assert.deepEqual(result.center, { x: 180, y: 25 });
  assert.deepEqual(base, frozen);
});
