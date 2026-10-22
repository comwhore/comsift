import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({ entryPoints: ['src/service/personCard.ts'], bundle: true, platform: 'node', format: 'esm', write: false, plugins: [{name:'obsidian',setup(b) {
  b.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'stub'}));
  b.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:'export class FuzzySuggestModal {} export class MarkdownRenderChild {} export class Modal {} export class Notice {} export class TFile {} export const normalizePath=x=>x; export const setIcon=()=>{}; export const Keymap={};'}));
}}] });
const { PersonCards, customFields } = await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64'));
function fixture() {
  const a={path:'P/P.md'}, b={path:'P/Connections/b.md'}, canvas={path:'P/P.canvas',extension:'canvas'};
  const frontmatter=new Map([[a.path,{comsift_same:['[[P/Connections/b]]']}],[b.path,{comsift_related:['[[P/P]]'] }]]);
  const data={nodes:[{id:'comsift-main',type:'text',text:'P',x:0,y:0,width:10,height:10},{id:'b',type:'file',file:b.path,x:0,y:0,width:10,height:10}],edges:[{id:'ab',fromNode:'comsift-main',toNode:'b',comsift_type:'same',label:'P'}]};
  let changed;
  const cleared=[];
  const plugin={analysis:{clearProfileRelation:async(...args)=>cleared.push(args)},registerEvent(){},register(){},app:{vault:{on(){},getMarkdownFiles:()=>[a,b],getFiles:()=>[a,b,canvas],getFileByPath:p=>[a,b,canvas].find(f=>f.path===p),read:async()=>JSON.stringify(data),modify:async(_,content)=>{changed=JSON.parse(content);}},metadataCache:{getFileCache:f=>({frontmatter:frontmatter.get(f.path)}),getFirstLinkpathDest:p=>[a,b].find(f=>f.path===p+'.md')},fileManager:{processFrontMatter:async(f,fn)=>fn(frontmatter.get(f.path))}},investigations:{forPath:()=>({folderPath:'P'}),mdPath:()=>a.path}};
  return {cards:new PersonCards(plugin),a,b,frontmatter,cleared,get changed(){return changed;}};
}
test('incoming marks appear even before resolvedLinks updates',()=>{
  const f=fixture();
  assert.equal(f.cards.relations(f.b)[0].type,'related');
  delete f.frontmatter.get(f.b.path).comsift_related;
  assert.equal(f.cards.relations(f.b)[0].type,'same');
});
test('remove clears both mark directions and typed Canvas arrow',async()=>{
  const f=fixture(); await f.cards.removeRelation(f.a,f.b.path);
  assert.deepEqual(f.frontmatter.get(f.a.path),{}); assert.deepEqual(f.frontmatter.get(f.b.path),{});
  assert.equal(f.changed.edges[0].comsift_type,'normal'); assert.equal(f.changed.edges[0].label,undefined);
  assert.deepEqual(f.cleared,[[f.a.path,f.b.path]],'saved review is cleared before a later sync can restore it');
});
test('custom fields accept arbitrary text/links and discard nonstring values',()=>{
  assert.deepEqual(customFields({comsift_custom_fields:{website:'https://example.test/a',note:'hello',bad:[],blank:' '}}),{website:'https://example.test/a',note:'hello'});
  assert.deepEqual(customFields({comsift_custom_fields:[]}),{});
});

test('changing a relationship clears stale reciprocal same-person marks and arrows',async()=>{
  const f=fixture(); await f.cards.mark(f.b,f.a,'related');
  assert.deepEqual(f.frontmatter.get(f.a.path),{});
  assert.deepEqual(f.frontmatter.get(f.b.path),{comsift_related:['[[P/P]]']});
  assert.equal(f.changed.edges[0].comsift_type,'normal');
  assert.equal(f.cards.relations(f.a)[0].type,'related');
});
