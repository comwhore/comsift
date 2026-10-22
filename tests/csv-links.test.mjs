import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const output=await build({entryPoints:['src/analysis/csvLinks.ts'],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'mock',setup(b){
 b.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export class Modal {} export class Notice { constructor(message) { globalThis.csvNotice = message; } } export class TFile {} globalThis.CsvTFile=TFile; export const normalizePath=x=>x;',loader:'js'}));
}}]});
const {CsvSheetLinks,csvSource,linkCsv,csvWithOriginalFormat,mergeCsvSheet}=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].contents).toString('base64'));
const body=rows=>'---\nexcel-plugin: parsed\n---\n# Excel\n'+JSON.stringify([{name:'Data',rows:{len:100,...Object.fromEntries(rows.map((row,r)=>[r,{cells:Object.fromEntries(row.map((text,c)=>[c,{text}]))}]))}}]);
function setup(){
 const files=new Map();const add=(path,text)=>{const file=Object.assign(new globalThis.CsvTFile(),{path,extension:path.split('.').at(-1)});files.set(path,{file,text});return file;};
 const app={vault:{getFiles:()=>[...files.values()].map(e=>e.file),getFileByPath:p=>files.get(p)?.file,read:async f=>files.get(f.path).text,modify:async(f,text)=>{files.get(f.path).text=text;},create:async(p,text)=>{assert.ok(!files.has(p));return add(p,text);}}};
 const host={shouldSyncCsv:()=>true,buildSheetMdBodyFromCsvText:text=>body(text.replace(/^\uFEFF/,'').trimEnd().split(/\r?\n/).map(r=>r.split(text.includes(';')?';':','))),refreshOpenExcelViewsForSheet:async()=>{}};
 return {files,add,app,host,links:new CsvSheetLinks(app,host)};
}
test('CSV stays unchanged with an explicitly linked companion and existing metadata survives',async()=>{
 const {files,add,links}=setup();const csv=add('Person/a.csv','name,id\r\nAlice,00123\r\n');
 await links.ensure(csv);
 assert.equal(files.get(csv.path).text,'name,id\r\nAlice,00123\r\n');
 assert.equal(csvSource(files.get('Person/a.sheet.md').text),csv.path);
 assert.match(files.get('Person/a.sheet.md').text,/00123/);
 assert.equal(files.size,2);
 const prior=linkCsv('---\ntags:\n  - important\n---\n# Excel\n[]',csv.path);
 assert.match(linkCsv(prior,csv.path),/important/);
 assert.equal(csvSource('---\ncomsift_csv_source: "[[../escape.csv]]"\n---\n'),null);
});
test('external edits to two CSVs both update linked sheets; unrelated tabs and layout survive',async()=>{
 const {files,add,links}=setup();const a=add('a.csv','name\nA\n'),b=add('b.csv','name\nB\n');await links.scan();
 files.get(a.path).text='name\nAA\n';files.get(b.path).text='name\nBB\n';
 await Promise.all([links.changed(a),links.changed(b)]);
 assert.match(files.get('a.sheet.md').text,/AA/);assert.match(files.get('b.sheet.md').text,/BB/);
 const old='---\ntags: test\n---\n# Excel\n'+JSON.stringify([{name:'Custom',cols:{len:4},styles:[{color:'red'}],rows:{0:{cells:{0:{text:'old',style:0}}}}},{name:'Extra',rows:{}}]);
 const merged=mergeCsvSheet(old,body([['new']]));
 const data=JSON.parse(merged.slice(merged.search(/^\[/m)));
 assert.equal(data[0].rows[0].cells[0].style,0);assert.equal(data[0].name,'Custom');assert.equal(data[0].cols.len,4);assert.equal(data[1].name,'Extra');assert.match(merged,/tags: test/);
});
test('sheet edits update the same original CSV and restore the link after Excel rewrites its header',async()=>{
 const {files,add,links}=setup();const csv=add('a.csv','name;id\r\nAlice;001\r\n');
 add('a.sheet.md',linkCsv(body([['name','id'],['Alice','001']]).replace('excel-plugin: parsed','excel-plugin: parsed\ntags: preserve'),csv.path));
 await links.scan();
 const sheet=files.get('a.sheet.md').file;
 files.get(sheet.path).text=body([['name','id'],['Alice changed','001']]);
 await links.saveSheet(sheet,'ignored in favor of latest saved file');
 assert.equal(files.get(csv.path).text,'name;id\r\nAlice changed;001\r\n');
 assert.equal(csvSource(files.get(sheet.path).text),csv.path);assert.match(files.get(sheet.path).text,/tags: preserve/);
 assert.equal(files.size,2);
});
test('renaming either file retains the explicit pair; standalone sheets never generate CSVs',async()=>{
 const {files,add,links}=setup();const csv=add('a.csv','name\nAlice\n');await links.scan();
 const sheet=files.get('a.sheet.md').file;let entry=files.get(sheet.path);files.delete(sheet.path);sheet.path='renamed.sheet.md';files.set(sheet.path,entry);await links.renamed(sheet,'a.sheet.md');
 entry=files.get(csv.path);files.delete(csv.path);csv.path='source.csv';files.set(csv.path,entry);await links.renamed(csv,'a.csv');
 assert.equal(csvSource(files.get(sheet.path).text),'source.csv');files.get(sheet.path).text=body([['name'],['Updated']]);await links.saveSheet(sheet,'');assert.match(files.get('source.csv').text,/Updated/);
 const standalone=add('standalone.sheet.md',body([['Only a sheet']]));await links.saveSheet(standalone,files.get(standalone.path).text);assert.equal(files.has('standalone.csv'),false);
 files.delete('source.csv');await assert.rejects(links.saveSheet(sheet,''),/missing/);assert.equal(files.has('source.csv'),false);
});
test('CSV serialization retains delimiter, BOM and newline format and quotes edited values',()=>{
 assert.equal(csvWithOriginalFormat([['id','name'],['001','A;B']], '\uFEFFid;name\r\n001;Alice\r\n'),'\uFEFFid;name\r\n001;"A;B"\r\n');
});
test('Import preserves a real CSV source and links the current sheet instead of converting it alone',async()=>{
 const {files,add,links}=setup();const sheet=add('Person/Selected.sheet.md',body([['old']]));
 const raw='name,id\r\nAlice,00123\r\n';
 await links.importFile(sheet,{name:'source.csv',text:async()=>raw});
 assert.equal(files.get('Person/source.csv').text,raw);
 assert.equal(csvSource(files.get(sheet.path).text),'Person/source.csv');
 assert.match(files.get(sheet.path).text,/00123/);
 assert.equal(files.has('Person/source.sheet.md'),false);
 files.get(sheet.path).text=body([['name','id'],['Changed','00123']]);await links.saveSheet(sheet,'');
 assert.equal(files.get('Person/source.csv').text,'name,id\r\nChanged,00123\r\n');
 await links.importFile(sheet,{name:'source.csv',text:async()=>raw});
 assert.equal(files.get('Person/source.csv').text,'name,id\r\nChanged,00123\r\n','a conflicting source must never be overwritten');
 assert.equal(files.get('Person/source 2.csv').text,raw);
 assert.equal(csvSource(files.get(sheet.path).text),'Person/source 2.csv');
});

test('linked CSV edits made while closed refresh the sheet on reopening; conflicts preserve both files',async()=>{
 const {files,add,app,host,links}=setup();add('a.csv','name\nOriginal\n');await links.scan();
 files.get('a.csv').text='name\nChanged offline\n';
 await new CsvSheetLinks(app,host).scan();assert.match(files.get('a.sheet.md').text,/Changed offline/);
 files.get('a.csv').text='name\nAnother CSV change\n';
 files.get('a.sheet.md').text=files.get('a.sheet.md').text.replace('Changed offline','Conflicting sheet edit');
 await assert.rejects(new CsvSheetLinks(app,host).scan(),/Both linked CSV and sheet changed/);
 assert.match(files.get('a.csv').text,/Another CSV change/);assert.match(files.get('a.sheet.md').text,/Conflicting sheet edit/);
});
test('the actual spreadsheet Import handler routes CSV to linked import without using FileReader conversion',async()=>{
 const source=await readFile('excel-modded/main.js','utf8');
 const start=source.indexOf('  handleFile(e) {'),end=source.indexOf('  process_wb(wb)',start);
 const calls=[];
 const instance=vm.runInNewContext('({'+source.slice(start,end)+'})',{FileReader:class{constructor(){throw new Error('CSV must not use conversion');}}});
 const file={name:'example.csv'};instance.file={path:'selected.sheet.md'};
 instance.plugin={importLinkedCsv:(sheet,source)=>{calls.push([sheet.path,source]);return Promise.resolve();}};
 instance.handleFile({target:{files:[file]}});
 assert.deepEqual(calls,[['selected.sheet.md',file]]);
});

test('an unchanged view autosave after a CSV update refreshes from source instead of falsely failing',async()=>{
 const {files,add,links}=setup();const csv=add('a.csv','name\nBefore\n');await links.scan();
 const sheet=files.get('a.sheet.md').file;
 files.get(csv.path).text='name\nNew source value\n';
 // Simulate the editor header reset and stale grid save before the CSV event runs.
 files.get(sheet.path).text=body([['name'],['Before']]);
 await links.saveSheet(sheet,'');
 assert.equal(files.get(csv.path).text,'name\nNew source value\n');
 assert.match(files.get(sheet.path).text,/New source value/);
});
test('CSV-only formatting changes do not falsely conflict with a spreadsheet save',async()=>{
 const {files,add,links}=setup();add('a.csv','name\r\nBefore\r\n');await links.scan();
 files.get('a.csv').text='name\nBefore\n';
 await links.saveSheet(files.get('a.sheet.md').file,'');
 assert.equal(files.get('a.csv').text,'name\nBefore\n');
});
test('CSV failures show a useful reason and a command instead of requiring the console',()=>{
 const {links}=setup();
 const error=console.error;console.error=()=>{};
 try{links.report(new Error('Linked CSV is missing'),'Person/a.sheet.md');}finally{console.error=error;}
 assert.match(globalThis.csvNotice,/Person\/a.sheet.md: Linked CSV is missing/);
 assert.match(globalThis.csvNotice,/status and repair/);
 assert.doesNotMatch(globalThis.csvNotice,/check the console/i);
});

test('source formatting edits and pending spreadsheet edits merge without false conflict',async()=>{
 const {files,add,links}=setup();add('a.csv','name\r\nBefore\r\n');await links.scan();
 files.get('a.csv').text='name\nBefore\n';files.get('a.sheet.md').text=body([['name'],['New sheet value']]);
 await links.saveSheet(files.get('a.sheet.md').file,'');
 assert.equal(files.get('a.csv').text,'name\nNew sheet value\n');
});
test('one broken pair does not prevent another pair syncing during startup',async()=>{
 const {files,add,app,host,links}=setup();add('a.csv','name\nOld A\n');add('b.csv','name\nOld B\n');await links.scan();
 files.get('a.csv').text='name\nCSV conflict\n';files.get('a.sheet.md').text=files.get('a.sheet.md').text.replace('Old A','Sheet conflict');
 files.get('b.csv').text='name\nUpdated B\n';
 await assert.rejects(new CsvSheetLinks(app,host).scan(),/Both linked/);
 assert.match(files.get('b.sheet.md').text,/Updated B/);
});
test('manual repair backs up both versions and restores a working pair',async()=>{
 const {files,add,app,host,links}=setup();add('a.csv','name\nOriginal\n');await links.scan();
 const csv='name\nCSV choice\n',sheet=files.get('a.sheet.md').text.replace('Original','Sheet choice');
 files.get('a.csv').text=csv;files.get('a.sheet.md').text=sheet;
 const backups=new Map();host.manifest={id:'comsift'};app.vault.configDir='.obsidian';
 app.vault.adapter={exists:async()=>true,mkdir:async()=>{},write:async(p,text)=>backups.set(p,text)};
 await links.repair(files.get('a.sheet.md').file,'csv');
 assert.equal(backups.size,1);const saved=JSON.parse([...backups.values()][0]);assert.equal(saved.csv.text,csv);assert.equal(saved.sheet.text,sheet);
 assert.match(files.get('a.sheet.md').text,/CSV choice/);assert.doesNotMatch(files.get('a.sheet.md').text,/Sheet choice/);
 await new CsvSheetLinks(app,host).scan();
});
test('startup retries transient indexing reads and queues autosaves until the scan completes',async()=>{
 const {links}=setup();let scans=0,finishRead;const order=[];
 links.scan=async()=>{scans++;if(scans===1)throw new Error('File is not indexed yet');await new Promise(resolve=>{finishRead=resolve;});order.push('scanned');};
 const prior=globalThis.window;globalThis.window={setTimeout:fn=>{fn();return 1;}};
 try{
  const saved=links.afterStartup(async()=>{order.push('saved');});
  const startup=links.startupScan();
  for(let i=0;i<8&&!finishRead;i++)await Promise.resolve();
  assert.equal(scans,2);assert.deepEqual(order,[]);finishRead();await startup;await saved;
  assert.deepEqual(order,['scanned','saved']);
 }finally{globalThis.window=prior;}
});
