import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const out = await build({entryPoints:['src/service/graph.ts'],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'mock',setup(b){
  b.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'mock'}));
  b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export class TFile {} export class TAbstractFile {}',loader:'js'}));
}}]});
const { GraphService } = await import('data:text/javascript;base64,'+Buffer.from(out.outputFiles[0].contents).toString('base64'));
test('identity remapping retains relationships from both merged source paths', () => {
  const plugin = {state:{graphSources:{a:{'old.md':['first.md'],'new.md':['second.md']}},graphManagedFiles:['old.md','new.md']}};
  new GraphService(plugin).remap('old.md','new.md');
  assert.deepEqual(plugin.state.graphSources.a,{'new.md':['first.md','second.md']});
});
test('confirmed records already sharing a canonical profile cannot create a self link', async () => {
  const plugin = {app:{vault:{getFileByPath:()=>({})}},state:{graphSources:{'confirmed:pair':{'profile.md':['profile.md']}},graphManagedFiles:[]},saveState:async()=>{}};
  const graph = new GraphService(plugin);
  graph.refreshManagedLinks = async()=>{};
  await graph.addConfirmedLink('profile.md','profile.md','pair');
  assert.deepEqual(plugin.state.graphSources,{});
});
