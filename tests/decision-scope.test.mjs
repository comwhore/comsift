import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { resolve } from "node:path";
const bundle = await build({ entryPoints: ["src/analysis/service.ts"], bundle: true, platform: "node", format: "esm", write: false, loader: { ".py": "text" }, plugins: [{ name: "mock", setup(b) {
  b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
  b.onResolve({ filter: /^\.\/ollama$/ }, args => args.importer.endsWith("service.ts") ? { path: "client", namespace: "mock" } : undefined);
  b.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ contents: args.path === "client"
    ? `export * from ${JSON.stringify(resolve("src/analysis/ollama.ts"))}; export function createClient() { return globalThis.decisionScopeClient; }`
    : 'export const loadMermaid = async () => ({ parse: async () => true }); export class Modal {} export class Notice {} export class TFile {} export class TFolder {} export const normalizePath = x => x; export const requestUrl = () => {};', resolveDir: process.cwd() }));
} }] });
const { AnalysisService } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].contents).toString("base64"));
const record = id => ({ id, fields: { username: id }, dataset: id, row: 1 });
test('a valid uncertain verdict does not start an automatic second assessment', async () => {
  let calls = 0;
  globalThis.decisionScopeClient = { async decide(_source, candidates) {
    calls++;
    return { candidate_id: 'a', explanation: 'Mixed evidence', supporting_evidence: [], conflicting_evidence: [], uncertain: true,
      verdicts: candidates.map(candidate => ({candidate_id:candidate.id,verdict:'uncertain',reason:'Missing corroboration'})) };
  } };
  const result = await new AnalysisService({ setting: {} }).reason(null, record('source'), [record('a'),record('b')], {pairs:[],jina:[]}, false);
  assert.equal(calls,1);
  assert.deepEqual(result.decision.verdicts.map(entry=>entry.verdict),['uncertain','uncertain']);
});

test('failed first pass retries twice and skips that source', async () => {
  let calls = 0;
  globalThis.decisionScopeClient = { label: 'test', async decide() { calls++; throw new Error('invalid JSON'); } };
  await assert.rejects(new AnalysisService({ setting: {} }).reason(null, record('source'), [record('a')], { pairs: [], jina: [] }, false), /Skipped after 3/);
  assert.equal(calls, 3);
});

test('decision retries are configurable and success stops retries immediately', async () => {
  for (const retries of [0, 1, 2]) {
    let calls = 0;
    globalThis.decisionScopeClient = { async decide() { calls++; throw new Error('invalid JSON'); } };
    await assert.rejects(new AnalysisService({ setting: { decisionRetries: retries } }).reason(null, record('source'), [record('a')], { pairs: [], jina: [] }, false));
    assert.equal(calls, retries + 1);
  }
  let calls = 0;
  globalThis.decisionScopeClient = { async decide() {
    if (++calls < 3) throw new Error('invalid JSON');
    return { candidate_id: 'a', explanation: 'Linked collaborator', supporting_evidence: [], conflicting_evidence: [], uncertain: false,
      verdicts: [{ candidate_id: 'a', verdict: 'related', reason: 'Linked collaborator' }] };
  } };
  const result = await new AnalysisService({ setting: {} }).reason(null, record('source'), [record('a')], { pairs: [], jina: [] }, false);
  assert.equal(calls, 3);
  assert.equal(result.decision.verdicts[0].verdict, 'related');
});

test('decision history is bounded to overlapping people and removed on context overflow', async () => {
  const calls = [];
  globalThis.decisionScopeClient = { async decide(source, candidates, pairs, rankings, signal, options) {
    calls.push(options.previous?.map(entry => entry.candidate.id) ?? []);
    if (options.previous?.length) throw new Error('maximum context length exceeded');
    return { candidate_id: 'a', explanation: 'Family evidence', supporting_evidence: [], conflicting_evidence: [], uncertain: false,
      verdicts: [{ candidate_id: 'a', verdict: 'related', reason: 'Family evidence' }] };
  } };
  const previous = [{source:record('source'),candidate:record('sibling'),status:'related'},
    {source:record('unrelated'),candidate:record('other'),status:'same'}];
  const result = await new AnalysisService({setting:{decisionRetries:0}}).reason(null,record('source'),[record('a')],{pairs:[],jina:[],records:[]},false,undefined,
    {settings:{ollamaModel:'override',ollamaContext:4096},previous});
  assert.deepEqual(calls,[['sibling'],[]]);
  assert.equal(result.decision.verdicts[0].verdict,'related');
});

test('canonical profile details enrich both source and candidate and refresh when the note changes', async () => {
  const source=record('source'), candidate=record('a');
  const notes=[source,candidate].map((record,index)=>({path:`Person/Connections/${index}.md`,stat:{mtime:1},record}));
  let reads=0;
  const plugin={setting:{},investigations:{},app:{vault:{getMarkdownFiles:()=>notes,cachedRead:async file=>{
    reads++;return `---\ncomsift_profile_data: ${JSON.stringify(JSON.stringify([{...file.record,fields:{...file.record.fields,bio:'Mountain photographer'}}]))}\n---\n\n\`\`\`comsift-person\n\`\`\`\n\n## Notes\nFamily grew up in Cork.`;
  }},metadataCache:{getFileCache:()=>({frontmatter:{comsift_custom_fields:{location:'Cork'}}})}}};
  globalThis.decisionScopeClient={async decide(source,candidates){
    for(const profile of [source,...candidates]){assert.equal(profile.fields.bio,'Mountain photographer');assert.equal(profile.fields.location,'Cork');assert.match(profile.fields.notes,/Cork/);}
    return {candidate_id:'a',explanation:'Evidence',verdicts:[{candidate_id:'a',verdict:'same',reason:'Evidence'}],supporting_evidence:[],conflicting_evidence:[],uncertain:false};
  }};
  const service=new AnalysisService(plugin);
  for(let i=0;i<2;i++)await service.reason(null,source,[candidate],{pairs:[],jina:[],records:[]},false);
  assert.equal(reads,2);
  notes[0].stat.mtime++;
  await service.reason(null,source,[candidate],{pairs:[],jina:[],records:[]},false);
  assert.equal(reads,3);
});

test('batch reviews persist all choices and consolidate profiles and refresh graph once', async () => {
  let content='{}',migrations=0,refreshes=0;const links=[];
  const file={path:'Person/Analysis/reviews.json'};
  const plugin={state:{},app:{vault:{getFileByPath:()=>file,process:async(file,change)=>{content=change(content);}}},
    graph:{addConfirmedLink:async(left,right)=>links.push([left,right]),removeConfirmedLink:async()=>{},refreshInvestigation:async()=>refreshes++}};
  const service=new AnalysisService(plugin);
  service.ensureFolder=async()=> 'Person/Analysis';
  service.profileNote=async(item,record)=>({path:migrations?`Person/${record.id}.md`:'Person/previously-merged.md'});
  service.migrateProfiles=async()=>migrations++;
  const item={id:'Person'};
  await service.review(item,record('source'),record('a'),'confirmed',undefined,true);
  await service.review(item,record('source'),record('b'),'related',undefined,true);
  assert.equal(Object.keys(JSON.parse(content)).length,2);
  assert.equal(migrations,0);assert.equal(refreshes,0);
  await service.finishReviewBatch(item);
  assert.equal(migrations,1);assert.equal(refreshes,1);
  assert.deepEqual(links,[['Person/source.md','Person/a.md'],['Person/source.md','Person/b.md']]);
});
