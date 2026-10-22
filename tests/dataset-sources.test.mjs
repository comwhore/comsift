import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const out=await build({entryPoints:['src/analysis/service.ts'],bundle:true,platform:'node',format:'esm',write:false,loader:{'.py':'text'},plugins:[{name:'mock',setup(b){
 b.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export class Modal {} export const loadMermaid = async () => ({ parse: async () => true }); export class Notice {} export class TFile {} export class TFolder {} export const normalizePath=x=>x;',loader:'js'}));
}}]});
const {AnalysisService}=await import('data:text/javascript;base64,'+Buffer.from(out.outputFiles[0].contents).toString('base64'));
function setup(metadata=false){
 const sheet='Person/view.sheet.md',source='Person/original.csv';
 const text='---\ncomsift_csv_source: "[[Person/original.csv]]"\n---\n# Excel\n'+JSON.stringify([{name:'People',rows:{0:{cells:{0:{text:'username'}}},1:{cells:{0:{text:'alice'}}}}}]);
 const files=[source,sheet,'Person/independent.csv','Person/unlinked.sheet.md'].map(path=>({path,extension:path.endsWith('.csv')?'csv':'md',stat:{mtime:1,size:10}}));
 const contents=new Map([[sheet,text],[source,'username\nalice\n'],['Person/independent.csv','username\nbob\n'],['Person/unlinked.sheet.md','# Excel\n'+JSON.stringify([{name:'Separate',rows:{0:{cells:{0:{text:'username'}}},1:{cells:{0:{text:'charlie'}}}}}])]]);
 const service=new AnalysisService({setting:{columnMapping:JSON.stringify({[source]:{username:'username'}})},app:{vault:{configDir:'.obsidian',getFiles:()=>files,cachedRead:async f=>contents.get(f.path)},metadataCache:{getFileCache:f=>metadata&&f.path===sheet?{frontmatter:{comsift_csv_source:'[[Person/original.csv]]'}}:null}}});
 return {service,files,contents,sheet,source};
}
test('dataset picker lists the sheet once for a linked pair and keeps standalone CSVs',()=>{
 const {service,sheet,source}=setup(true);
 assert.deepEqual(service.listDatasets().map(f=>f.path),['Person/independent.csv','Person/unlinked.sheet.md',sheet]);
 assert.deepEqual(service.canonicalDatasetPaths([source,sheet,sheet+'#People']),[sheet,sheet+'#People']);
 assert.deepEqual(service.comparisonItem([source,'Person/independent.csv']),service.comparisonItem([sheet,'Person/independent.csv']));
});
test('backend deduplicates raw links before metadata indexing, including old CSV-only selections',async()=>{
 const {service,sheet,source}=setup();
 const loaded=await service.loadDatasets([source,sheet,'Person/independent.csv']);
 assert.deepEqual(loaded.map(d=>d.name),['Person/independent.csv',sheet+'#People']);
 assert.equal(loaded[1].csv,'username\nalice\n');
 assert.deepEqual((await service.loadDatasets([source])).map(d=>d.name),[sheet+'#People']);
 assert.ok(!service.listDatasets().some(f=>f.path===source));
});
test('one linked source can be analyzed within itself without duplicating its CSV',async()=>{
 const {service,sheet,source}=setup();
 const loaded=await service.loadDatasets([source,sheet]);
 assert.equal(loaded.length,1);
 let request;
 Object.defineProperty(service,'runner',{get:()=>({run:async value=>{request=value;return {records:[],pairs:[],jina:[]};}})});
 await service.runDatasets(loaded);
 assert.equal(request.compare_within,true);
 assert.equal(request.datasets[0].name,sheet+'#People');
});
test('CSV-specific mappings apply to the canonical sheet while independent sheets and CSVs remain separate',async()=>{
 const {service,sheet,source,contents}=setup();
 const loaded=await service.loadDatasets([source,'Person/unlinked.sheet.md','Person/independent.csv']);
 assert.equal(loaded.length,3);
 let request;Object.defineProperty(service,'runner',{get:()=>({run:async value=>{request=value;return {records:[],pairs:[],jina:[]};}})});
 await service.runDatasets(loaded);
 assert.equal(request.mappings[sheet+'#People'].username,'username');
 contents.set(sheet,contents.get(sheet).replace('comsift_csv_source: "[[Person/original.csv]]"','tags: unrelated'));
 const separated=await service.loadDatasets([source,sheet]);
 assert.equal(separated.length,2,'without an explicit source link these are independent datasets');
});

test('saved rectangles export only selected repeated headers and retain original row offsets', async()=>{
 const {service,sheet,source,contents}=setup();
 const rows = [
  ['FOLLOWING','Display name','Username','Profile link','IN COMMON','Display name','Username','Profile link'],
  ['', 'Alice','alice','https://example.test/alice','','Bob','bob','https://example.test/bob'],
  ['', 'Carol','carol','','','Dave','dave','']
 ];
 contents.set(sheet,'# Excel\n'+JSON.stringify([{name:'People',rows:Object.fromEntries(rows.map((row,r)=>[r,{cells:Object.fromEntries(row.map((text,c)=>[c,{text}]))}]))}]));
 service.plugin.setting.sheetRanges=JSON.stringify({[sheet+'#People']:['F1:H3']});
 service.plugin.setting.columnMapping=JSON.stringify({[sheet+'#People']:{username:'Username'}});
 const selected=await service.loadDatasets([sheet]);
 assert.equal(selected.length,1);
 assert.equal(selected[0].name,sheet+'#People@F1:H3');
 assert.equal(selected[0].row_offset,0);
 assert.match(selected[0].csv,/Bob,bob/);
 assert.doesNotMatch(selected[0].csv,/Alice|Carol/);
 assert.equal(service.datasetMappings(selected)[selected[0].name].username,'Username');
 assert.notEqual(service.comparisonItem([sheet]).id,service.comparisonItem(['Other.csv']).id);
});
test('analysis completes saved column choices with automatic roles and falls back when discovery fails',async()=>{
 const {service,sheet,source}=setup();
 const loaded=await service.loadDatasets([source,'Person/independent.csv']);
 const requests=[];
 Object.defineProperty(service,'runner',{configurable:true,get:()=>({run:async value=>{requests.push(value);
  if(value.action==='columns')return value.datasets.map(d=>({name:d.name,columns:['username','Contact'],samples:{username:['alice'],Contact:['a@example.test']},filled:{username:1,Contact:1},rows:1}));
  return {records:[],pairs:[],jina:[]};}})});
 await service.runDatasets(loaded);
 assert.deepEqual(requests.map(r=>r.action),['columns','analyze']);
 const mapping=requests[1].mappings[sheet+'#People'];
 assert.equal(mapping.username,'username');
 assert.equal(mapping.email,'Contact');
 assert.equal(mapping._identity,'Contact');
 Object.defineProperty(service,'runner',{configurable:true,get:()=>({run:async value=>{if(value.action==='columns')throw new Error('no python');requests.push(value);return [];}})});
 await service.importConnections([source]);
 assert.equal(requests.at(-1).mappings[sheet+'#People'].username,'username');
});
