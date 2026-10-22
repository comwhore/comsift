import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
async function load(path) { const result = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false }); return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64')); }
const p = await load('src/service/placement.ts');
const e = await load('src/service/canvasEmbedModel.ts');
const m = await load('src/service/canvasModel.ts');
test('legacy typed arrows keep their type when the visible label changes', () => {
  const data = m.persistArrowTypes({nodes:[],edges:[{id:'a',fromNode:'x',toNode:'y',label:'related'}]},'Person');
  data.edges[0].label = 'My custom explanation';
  assert.equal(m.arrowType(data.edges[0]),'related');
  assert.equal(m.withArrowType(data.edges[0],'uncertain','Person',{same:'1',related:'2',uncertain:'3'}).label,'My custom explanation');
});
const node = (id, x=0, y=0, width=100,height=100) => ({id,x,y,width,height});
test('malformed Canvas documents fail before they can be edited or rendered', () => {
  for (const value of [null, {}, {nodes:[null],edges:[]}, {nodes:[node('a'),node('a')],edges:[]},
    {nodes:[{...node('a'),width:0}],edges:[]}, {nodes:[node('a')],edges:[{id:'e',fromNode:'a',toNode:'missing'}]},
    {nodes:[node('a')],edges:[{id:'e',fromNode:'a',toNode:'a',label:{}}]}]) assert.throws(() => m.parseCanvas(JSON.stringify(value)));
  assert.deepEqual(m.parseCanvas(JSON.stringify({nodes:[node('a')],edges:[],custom:'preserved'})).custom,'preserved');
});
test('ports use actual rectangle faces after diagonal and unequal size placement', () => {
  assert.deepEqual(p.connectionSides(node('a'), node('b',-20,250)), {fromSide:'bottom',toSide:'top'});
  assert.deepEqual(p.connectionSides(node('a'), node('b',300,20)), {fromSide:'right',toSide:'left'});
  assert.deepEqual(p.connectionSides(node('a',0,0,1000,100),node('b',800,300)), {fromSide:'bottom',toSide:'left'});
});
test('auto output opposes incoming, prefers unused sides, handles reverse arrows and explicit choices', () => {
  const data = {nodes:[node('source'),node('other',-200)],edges:[{fromNode:'other',toNode:'source',toSide:'left'}]};
  assert.equal(p.resolveOutputDirection(data,'source','auto'),'right');
  assert.equal(p.resolveOutputDirection(data,'source','left'),'left');
  data.edges.push({fromNode:'source',toNode:'other',fromSide:'right'});
  assert.equal(p.resolveOutputDirection(data,'source','auto'),'bottom');
  data.edges = [{fromNode:'source',toNode:'other',fromSide:'top',fromEnd:'arrow',toEnd:'none'}];
  assert.equal(p.resolveOutputDirection(data,'source','auto'),'bottom');
  data.edges = [{fromNode:'other',toNode:'source'}];
  assert.equal(p.resolveOutputDirection(data,'source','auto'),'right');
});
test('tool result groups use rows vertically, columns horizontally and configured spacing', () => {
  const rows = p.resultGroupLayout(node('s'),3,{width:40,height:30},'bottom',50,[],11);
  assert.equal(rows[0].y,150); assert.equal(rows[2].y,150); assert.equal(rows[1].x-rows[0].x,51);
  const columns = p.resultGroupLayout(node('s'),3,{width:40,height:30},'right',50,[],17);
  assert.equal(columns[0].x,150); assert.equal(columns[2].x,150); assert.equal(columns[1].y-columns[0].y,47);
});
test('AI connections ignore incorrect supplied ports and preserve directed relationship type after moves', () => {
  const data = {nodes:[node('a'),node('b',-20,250)], edges:[]};
  const context = {digest:m.canvasDigest(data),personName:'person',colors:{same:'1',related:'2',uncertain:'3'},newId:()=> 'edge'};
  let next = m.applyCanvasOps(data,[{op:'connect',from:1,to:2,type:'uncertain',fromSide:'left',toSide:'right'}],context).data;
  assert.equal(next.edges[0].fromSide,'bottom'); assert.equal(next.edges[0].toSide,'top'); assert.equal(next.edges[0].comsift_type,'uncertain');
  next = m.applyCanvasOps(next,[{op:'move',node:2,x:300,y:10}],{...context,digest:m.canvasDigest(next)}).data;
  assert.equal(next.edges[0].fromSide,'right'); assert.equal(next.edges[0].toSide,'left'); assert.equal(next.edges[0].fromNode,'a');
});
test('embeds select exact arrows including endpoints and node-only induced relationships', () => {
  const data={nodes:[node('a'),node('b'),node('c')],edges:[{id:'ab',fromNode:'a',toNode:'b',comsift_type:'related'},{id:'bc',fromNode:'b',toNode:'c'}]};
  const selected=e.embedSelection(data,{path:'Map.canvas',nodes:[],edges:['ab']});
  assert.deepEqual(selected.nodes.map(n=>n.id),['a','b']); assert.equal(selected.edges[0].comsift_type,'related');
  assert.equal(e.embedSelection(data,{path:'Map.canvas',nodes:['a','b']}).edges.length,1);
  assert.equal(e.embedSelection(data,{path:'Map.canvas',nodes:['a','b'],edges:[]}).edges.length,0);
});
test('embed format round trips without allowing paths outside vault or malformed IDs', () => {
  const spec={path:'Person/Map.canvas',nodes:['abc']};
  assert.equal(e.embedMarkdown(spec),'\n\n![[Person/Map.canvas#abc]]\n');
  assert.deepEqual(e.parseEmbedSpec(JSON.stringify(spec)),spec);
  assert.throws(()=> e.embedMarkdown({...spec,edges:['edge1']}));
  assert.throws(()=> e.embedMarkdown({...spec,nodes:['bad]]\ntext']}));
  for (const bad of [{path:'../Map.canvas',nodes:[]},{path:'/Map.canvas',nodes:[]},{path:'Map.canvas',nodes:[3]},{path:'Map.canvas',nodes:[],edges:[{}]},null]) assert.throws(()=>e.parseEmbedSpec(JSON.stringify(bad)));
});

test('typed arrows preserve independently edited labels and explicit normal overrides legacy labels', () => {
  const colors={same:'1',related:'2',uncertain:'3'};
  let edge={id:'e',fromNode:'a',toNode:'b',label:'custom evidence'};
  edge=m.withArrowType(edge,'same','person',colors);
  assert.equal(edge.label,'custom evidence');
  edge=m.withArrowType({...edge,label:'related'},'normal','person',colors);
  assert.equal(edge.label,'related'); assert.equal(m.arrowType(edge,'person'),'normal');
});
test('AI groups use geometric containment and keep existing members on add', () => {
  const data={nodes:[node('a'),node('b',300),node('c',700)],edges:[]};
  let id=0;
  const context={digest:m.canvasDigest(data),personName:'person',colors:{same:'1',related:'2',uncertain:'3'},newId:()=>`new${++id}`};
  const next=m.applyCanvasOps(data,[{op:'group',ref:'g',label:'Evidence',nodes:[1,2]},{op:'group-add',group:'g',nodes:[3]},{op:'group-edit',node:'g',label:'All evidence'}],context).data;
  const group=next.nodes.find(n=>n.type==='group');
  assert.equal(group.label,'All evidence');
  for (const n of data.nodes) assert.equal(m.containsNode(group,n),true);
  assert.throws(()=>m.applyCanvasOps(data,[{op:'group',width:-3}],context));
});
test('arrow edits support labels and endpoints with automatic correct ports', () => {
  const data={nodes:[node('a'),node('b',300),node('c',0,300)],edges:[{id:'edge',fromNode:'a',toNode:'b',comsift_type:'related',label:'original'}]};
  const context={digest:m.canvasDigest(data),personName:'person',colors:{same:'1',related:'2',uncertain:'3'},newId:()=> 'id'};
  const next=m.applyCanvasOps(data,[{op:'edge',edge:'edge',to:3,label:'new evidence',fromEnd:'arrow',toEnd:'none'}],context).data.edges[0];
  assert.equal(next.toNode,'c'); assert.equal(next.fromSide,'bottom'); assert.equal(next.label,'new evidence'); assert.equal(next.comsift_type,'related');
});
