import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const result = await build({entryPoints:['src/analysis/summaryAi.ts'],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'summary-models',setup(b){
 b.onResolve({filter:/^\.\/ollama$/},()=>({path:'ollama',namespace:'mock'}));
 b.onResolve({filter:/^\.\/mermaid$/},()=>({path:'mermaid',namespace:'mock'}));
 b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:args.path==='ollama'
 ? `export const createClient=settings=>{globalThis.summarySettings=settings;return globalThis.summaryClient;};`
 : `export const generateMermaid=async(plugin,description)=>{globalThis.diagramSettings=plugin.setting;globalThis.diagramDescription=description;return 'graph TD\\n A-->B';};export const delegateMermaidMarkdown=async(plugin,answer,question,trusted)=>{globalThis.trustedDiagrams=trusted;return answer;};export const repairMermaidMarkdown=async(plugin,answer,signal,settings)=>{globalThis.repairSettings=settings;return answer;};`}));
}}]});
const {summarizeAnalysis,isStructuredSummary,summaryContext}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'));
const plugin=enabled=>({setting:{mermaidEnabled:enabled,ollamaModel:'chat',ollamaContext:8192},app:{vault:{getFiles:()=>[]}}});
const settings={ollamaModel:'summary',ollamaContext:4096,ollamaTimeout:120,ollamaUrl:'http://summary',ollamaThink:true};
test('summary uses selected model directly when separate diagram model is off',async()=>{
 globalThis.diagramDescription=undefined;
 globalThis.summaryClient={chatStream:async messages=>{assert.match(messages[0].content,/Write any useful Mermaid diagram directly/);return '## Summary\n\n```mermaid\ngraph TD\n A-->B\n```';}};
 const answer=await summarizeAnalysis(plugin(false),settings,'Summarize choices',[]);
 assert.match(answer,/```mermaid/);assert.equal(globalThis.summarySettings.ollamaModel,'summary');assert.equal(globalThis.repairSettings.ollamaModel,'summary');assert.equal(globalThis.diagramDescription,undefined);
});
test('summary diagram tool inherits selected summary connection and preserves trusted output',async()=>{
 let calls=0;
 globalThis.summaryClient={toolChat:async(messages,tools)=>{
  calls++;assert.deepEqual(tools.map(tool=>tool.function.name),['generate_diagram']);
  if(calls===1)return {content:'',calls:[{id:'diagram',name:'generate_diagram',arguments:{description:'A is related to B'}}]};
  return {content:'## Connections\n\n```mermaid\ngraph TD\n A-->B\n```',calls:[]};
 }};
 const answer=await summarizeAnalysis(plugin(true),settings,'Summarize choices',[]);
 assert.match(answer,/A-->B/);assert.equal(globalThis.diagramSettings.ollamaModel,'summary');assert.equal(globalThis.diagramDescription,'A is related to B');assert.deepEqual(globalThis.trustedDiagrams,['```mermaid\ngraph TD\n A-->B\n```']);
});

test('summary explains decision evidence without proposal or persistence framing',async()=>{
 const data=[{source:{username:'example.person'},candidate:{display_name:'ExamplePerson'},status:'uncertain',reasoning:'Similar names; no shared account URL.',supporting_evidence:['Similar names'],conflicting_evidence:['Different handles']}];
 globalThis.summaryClient={chatStream:async messages=>{
  assert.doesNotMatch(messages.map(message=>message.content).join('\n'),/proposed|awaiting confirmation|Distinguish proposed choices/);
  assert.match(messages[1].content,/why the model made each decision/);
  assert.match(messages[1].content,/Different handles/);
  assert.match(messages[0].content,/diagrams are optional/);
  return 'The match is uncertain because the names overlap but the handles differ.';
 }};
 const answer=await summarizeAnalysis(plugin(false),settings,'Distinguish proposed choices from saved relationships.',data);
 assert.match(answer,/uncertain/);
});

test('summary final task overrides editable JSON prompts and respects user changes',async()=>{
 const data=[{source:{display_name:'Jane Doe'},candidate:{display_name:'John Doe'},ai_status:'same',status:'related',user_changed:true,main_person:true,reasoning:'The original AI explanation.'}];
 globalThis.summaryClient={chatStream:async messages=>{
  const instructions=messages[0].content;
  assert.ok(instructions.indexOf('FINAL TASK AND OUTPUT FORMAT')>instructions.indexOf('Return JSON'));
  assert.match(instructions,/current status field is authoritative/);
  assert.match(instructions,/do not present it as justification for a different user-selected status/);
  assert.match(instructions,/main_person/);
  assert.match(messages[1].content,/"user_changed":true/);
  return 'Jane and John are now marked related after your change from the AI’s same-person verdict. No reason for the change was supplied.';
 }};
 assert.match(await summarizeAnalysis(plugin(false),settings,'Return JSON with candidate statuses.',data),/your change/);
});

test('summary retries copied JSON once and returns readable text',async()=>{
 let calls=0;
 globalThis.summaryClient={chatStream:async messages=>{
  calls++;
  if(calls===1)return 'Here are the results:\n```json\n[{"source":{},"status":"related"}]\n```';
  assert.match(messages.at(-1).content,/Do not make new decisions/);
  return 'Jane and John may be related based on their shared biography details.';
 }};
 assert.match(await summarizeAnalysis(plugin(false),settings,'Return JSON',[]),/Jane and John/);
 assert.equal(calls,2);
});

test('summary refuses persistent JSON after one corrective retry',async()=>{
 let calls=0;
 globalThis.summaryClient={chatStream:async()=>{calls++;return '[{"status":"same"}]';}};
 await assert.rejects(summarizeAnalysis(plugin(false),settings,'Return JSON',[]),/readable summary/);
 assert.equal(calls,2);
});

test('summary JSON detection preserves normal Markdown and Mermaid',()=>{
 assert.equal(isStructuredSummary('## Connections\n\n- Jane and John may be related.\n\n```mermaid\ngraph TD\n A[Jane]-->B[John]\n```'),false);
 assert.equal(isStructuredSummary('Results:\n[\n {"candidate":{},"status":"same"}\n]'),true);
 assert.equal(isStructuredSummary('[Jane](obsidian://open) may be related to John.'),false);
});

test('large summaries preserve every visible total and prioritize user changes and relationships', () => {
 const rejected=Array.from({length:100},(_,i)=>({source:{username:`source${i}`},candidate:{username:`candidate${i}`},status:'rejected',reasoning:'x'.repeat(500)}));
 const changed={source:{username:'Jane'},candidate:{username:'John'},status:'related',ai_status:'uncertain',user_changed:true,reasoning:'Shared surname and distinctive biography'};
 const data={main_person:'Jane',choices:[...rejected,changed]};
 const compact=summaryContext(data,2048);
 assert.equal(compact.visible_pairs,101);
 assert.deepEqual(compact.visible_totals,{rejected:100,related:1});
 assert.equal(compact.choices[0].user_changed,true);
 assert.ok(compact.detailed_pairs<101);
 assert.match(compact.scope_note,/every visible pair/);
 assert.deepEqual(summaryContext({choices:[changed]},8192),{choices:[changed]});
});
