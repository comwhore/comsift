import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
async function load(path) {
  const result=await build({entryPoints:[path],bundle:true,platform:'node',format:'esm',write:false,plugins:[{
    name:'obsidian-test',setup(build) {build.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'stub'}));build.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:'export class Notice {} export class TFolder {} export const setIcon=()=>{}; export const normalizePath=p=>p;'}));}
  }]});
  return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'));
}
const {SherlockService}=await load('src/service/sherlock.ts');
const {MaigretService}=await load('src/service/maigret.ts');
const source={id:'source',type:'text',text:'handle',x:0,y:0,width:100,height:100};
function setup() {
  let data={nodes:[{...source}],edges:[]};
  const canvas={getData:()=>structuredClone(data),importData(next,replace=false){
    if(replace) data=structuredClone(next);
    else {
      for(const key of ['nodes','edges']) {const entries=new Map(data[key].map(n=>[n.id,n]));for(const entry of next[key]) entries.set(entry.id,structuredClone(entry));data[key]=[...entries.values()];}
    }
  },requestSave(){}};
  const plugin={addStatusBarItem:()=>({hide(){},show(){},toggle(){}}),state:{sherlockChildren:{},maigretChildren:{}},saveState:async()=>{},setting:{sherlockPosition:'right',maigretPosition:'right',COLUMN_GAP:50,ROW_GAP:20}};
  return {canvas,plugin};
}
for(const [name,Service] of [['Sherlock',SherlockService],['Maigret',MaigretService]]) test(`${name} overlapping same-source publications retain siblings, avoid overlap and replace previous batch`,async()=>{
  const {canvas,plugin}=setup(); const service=new Service(plugin);
  const key='Board.canvas#source';
  const first=service.publications.begin(key),second=service.publications.begin(key);
  let index=0;
  service.writeMarkdownReports=async()=>{await Promise.resolve();return [`report-${++index}.md`];};
  const publish=async(ticket)=>ticket.publish(async replace=>{
    if(name==='Sherlock') return service.applyResults(canvas,source,'Board.canvas',[{}],'handle',replace);
    return service.applyResults(canvas,'Board.canvas',source,'handle',[{path:`report-${++index}.md`}],replace);
  });
  await Promise.all([publish(first),publish(second)]);first.finish();second.finish();
  let children=canvas.getData().nodes.filter(n=>n.id!=='source');assert.equal(children.length,2);
  const [a,b]=children;assert.ok(a.y+a.height<=b.y || b.y+b.height<=a.y || a.x+a.width<=b.x || b.x+b.width<=a.x);
  const later=service.publications.begin(key);await publish(later);later.finish();
  children=canvas.getData().nodes.filter(n=>n.id!=='source');assert.equal(children.length,1);
  assert.equal(canvas.getData().edges.length,1);
});
test('Sherlock publication uses source geometry after awaited report writes and retains reports for deleted source',async()=>{
  const {canvas,plugin}=setup(); const service=new SherlockService(plugin);
  service.writeMarkdownReports=async()=>{canvas.importData({nodes:[{...source,x:900}],edges:[]},true);return ['report.md'];};
  await service.applyResults(canvas,source,'Board.canvas',[{}],'handle');
  assert.ok(canvas.getData().nodes.find(n=>n.id!=='source').x>1000);
  service.writeMarkdownReports=async()=>{canvas.importData({nodes:[],edges:[]},true);return ['retained-report.md'];};
  await assert.rejects(service.applyResults(canvas,source,'Board.canvas',[{}],'handle'),/source node was removed/);
  assert.equal(canvas.getData().nodes.length,0);
});
