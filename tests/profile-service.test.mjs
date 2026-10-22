import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const output = await build({ entryPoints: ['src/analysis/service.ts'], bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.py': 'text' }, plugins: [{ name: 'mock', setup(build) {
  build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'mock' }));
  build.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: 'export class Modal {} export const loadMermaid = async () => ({ parse: async () => true }); export class Notice {} export class TFile {} globalThis.ProfileTFile = TFile; export class TFolder {} export const normalizePath = x => x;', loader: 'js' }));
} }] });
const { AnalysisService } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].contents).toString('base64'));
function setup() {
  const files = new Map(), remaps = [], backups = new Map(), trashed = [];
  const add = (path, text) => { const file = Object.assign(new globalThis.ProfileTFile(), { path, extension: path.split('.').at(-1) }); files.set(path, { file, text }); return file; };
  const vault = { configDir: '.obsidian', adapter: { exists: async () => true, mkdir: async () => {}, write: async (path, text) => backups.set(path, text) }, getFileByPath: path => files.get(path)?.file, getMarkdownFiles: () => [...files.values()].filter(e => e.file.extension === 'md').map(e => e.file), getFiles: () => [...files.values()].map(e => e.file), getAbstractFileByPath: path => files.get(path)?.file,
    read: async file => files.get(file.path).text,
    process: async (file, update) => { files.get(file.path).text = update(files.get(file.path).text); },
    create: async (path, text) => { await Promise.resolve(); if (files.has(path)) throw new Error('Duplicate create'); return add(path, text); } };
  const owner = { id: 'person', folderPath: 'Person' };
  const plugin = { manifest: { id: 'comsift' }, app: { vault, metadataCache: { getFileCache: () => null }, fileManager: { trashFile: async file => { trashed.push(file.path); files.delete(file.path); }, renameFile: async (file, next) => { const entry = files.get(file.path); files.delete(file.path); file.path = next; files.set(next, entry); } } }, investigations: { forPath: () => owner, mdPath: item => `${item.folderPath}/${item.folderPath.split("/").at(-1)}.md` }, graph: { remap: (...paths) => remaps.push(paths), refreshInvestigation: async () => {} }, state: { graphSources: {}, investigations: { person: owner } }, saveState: async () => {} };
  const service = new AnalysisService(plugin);
  service.ensureFolder = async (item, folder) => `${item.folderPath}/${folder}`;
  service.ensureRelativeFolder = async () => {};
  return { service, files, add, owner, remaps, backups, trashed };
}

test('concurrent source creation with stale metadata produces one profile containing both sources', async () => {
  const { service, files, owner } = setup();
  const record = (name, platform) => ({ id: `Person/${name}.sheet.md:2`, dataset: `Person/${name}.sheet.md`, row: 2, fields: { username: 'Alice', platform }, raw: {} });
  const [a, b] = await Promise.all([service.profileNote(owner, record('a', 'a instagram')), service.profileNote(owner, record('b', 'b instagram'))]);
  assert.equal(a, b);
  assert.equal(files.size, 1);
  assert.match(files.get(a.path).text, /Person\/a.sheet/);
  assert.match(files.get(a.path).text, /Person\/b.sheet/);
});

test('profile remapping resolves full, relative and unique short wikilinks without changing other accounts', async () => {
  const { service, add, files } = setup();
  const old = 'Person/Analysis/Profiles/Alice 2.md', next = 'Person/Analysis/Profiles/Alice.md';
  add(old, 'duplicate'); add(next, 'survivor'); add('Elsewhere/Bob.md', 'other');
  add('Person/Notes.md', 'Before [[Analysis/Profiles/Alice 2|relative]] [[Alice 2#Evidence|short]] [[Person/Analysis/Profiles/Alice 2.md|full]] [[Bob|untouched]] after');
  await service.remapProfileReferences(old, next);
  const text = files.get('Person/Notes.md').text;
  assert.equal(text, 'Before [[Person/Analysis/Profiles/Alice|relative]] [[Person/Analysis/Profiles/Alice#Evidence|short]] [[Person/Analysis/Profiles/Alice.md|full]] [[Bob|untouched]] after');
  assert.equal(files.get(old).text, 'duplicate');
});

test('profile remapping leaves ambiguous short names alone', async () => {
  const { service, add, files } = setup();
  const old = 'Person/Analysis/Profiles/Alice 2.md';
  add(old, 'duplicate'); add('Other/Alice 2.md', 'other'); add('Third/note.md', '[[Alice 2]]');
  await service.remapProfileReferences(old, 'Person/Analysis/Profiles/Alice.md');
  assert.equal(files.get('Third/note.md').text, '[[Alice 2]]');
});

test('profile remapping preserves Markdown link labels, anchors and titles', async () => {
  const { service, add, files } = setup();
  const old = 'Person/Analysis/Profiles/Alice 2.md', next = 'Person/Analysis/Profiles/Alice.md';
  add(old, 'duplicate'); add(next, 'survivor');
  add('Person/note.md', '[proof](Analysis/Profiles/Alice%202.md#Evidence "Title") [external](https://example.test/Alice%202.md)');
  await service.remapProfileReferences(old, next);
  assert.equal(files.get('Person/note.md').text, '[proof](Analysis/Profiles/Alice.md#Evidence "Title") [external](https://example.test/Alice%202.md)');
});

test('Canvas remapping preserves text links, file nodes, node metadata and edge type/label', async () => {
  const { service, add, files } = setup();
  const old = 'Person/Analysis/Profiles/Alice 2.md', next = 'Person/Analysis/Profiles/Alice.md';
  add(old, 'duplicate'); add(next, 'survivor');
  const canvas = { nodes: [{ id: 'a', type: 'file', file: old, x: 0, y: 0, width: 200, height: 200 }, { id: 'b', type: 'text', text: `User annotation [[${old}#Proof|alias]]`, x: 300, y: 0, width: 200, height: 200, custom: 'preserved' }], edges: [{ id: 'e', fromNode: 'a', fromSide: 'right', toNode: 'b', toSide: 'left', label: 'custom label', comsiftType: 'related' }], customRoot: 'preserved' };
  add('Person/board.canvas', JSON.stringify(canvas));
  await service.remapProfileReferences(old, next);
  const actual = JSON.parse(files.get('Person/board.canvas').text);
  assert.equal(actual.nodes[0].file, next);
  assert.equal(actual.nodes[1].text, `User annotation [[${next}#Proof|alias]]`);
  assert.equal(actual.nodes[1].custom, 'preserved');
  assert.equal(actual.customRoot, 'preserved');
  assert.deepEqual(actual.edges, canvas.edges);
});


const profileRecord = (source, username = 'Alice', platform = 'instagram') => ({ id: `Person/${source}.sheet.md:2`, dataset: `Person/${source}.sheet.md`, row: 2, fields: { username, platform } });
const legacyDocument = record => `---\ncomsift_records:\n  - ${JSON.stringify(record.id)}\n---\n# ${record.fields.username}\n\nSources:\n- [[${record.dataset.slice(0, -3)}]], row ${record.row}\n\n- username: ${record.fields.username}\n- platform: ${record.fields.platform}\n`;
const profileFiles = files => [...files.keys()].filter(path => path.includes('/Connections/'));

test('migration consolidates old namespaces and comparison copies into owner, preserving sources, references and backups idempotently', async () => {
  const { service, files, add, backups, trashed } = setup();
  const records = [profileRecord('a', 'Alice', 'a instagram'), profileRecord('b', 'Alice', 'b instagram'), profileRecord('c')];
  const paths = ['Person/Analysis/Profiles/Alice.md', 'Comsift/Comparisons/one/Analysis/Profiles/Alice copy.md', 'Comsift/Comparisons/two/Analysis/Profiles/Alice copy 2.md'];
  records.forEach((record, index) => add(paths[index], legacyDocument(record) + `\nAnnotation ${index}\n`));
  add('Person/Notes.md', `References [[${paths[1]}|one]] [[Alice copy 2|two]]`);
  add('Person/board.canvas', JSON.stringify({ nodes: [{ id: 'a', type: 'file', file: paths[1], x: 0, y: 0, width: 100, height: 100 }], edges: [] }));
  await service.migrateProfiles();
  const canonical = 'Person/Connections/Alice (instagram).md';
  assert.deepEqual(profileFiles(files), [canonical]);
  const survivor = files.get(canonical).text;
  for (const record of records) assert.ok(survivor.includes(record.dataset), `missing source ${record.dataset}`);
  for (let i = 0; i < 3; i++) assert.ok(survivor.includes(`Annotation ${i}`));
  assert.equal(trashed.length, 2);
  assert.equal(backups.size, 3);
  assert.equal(JSON.parse(files.get('Person/board.canvas').text).nodes[0].file, canonical);
  assert.equal(files.get('Person/Notes.md').text, `References [[${canonical}|one]] [[${canonical.slice(0, -3)}|two]]`);
  const snapshot = [...files].map(([path, entry]) => [path, entry.text]);
  await service.migrateProfiles();
  assert.deepEqual([...files].map(([path, entry]) => [path, entry.text]), snapshot);
  assert.equal(backups.size, 3, 'second migration should not write another backup');
});

test('confirmed different accounts consolidate and rejecting their review splits accounts again', async () => {
  const { service, files, add, backups } = setup();
  const a = profileRecord('a'), b = profileRecord('b', 'Bob', 'tiktok');
  add('Person/Analysis/Profiles/Alice.md', legacyDocument(a));
  add('Person/Analysis/Profiles/Bob.md', legacyDocument(b));
  const pair = `${a.id} → ${b.id}`;
  const review = status => JSON.stringify({ [pair]: { status, source_id: a.id, candidate_id: b.id } });
  add('Person/Analysis/reviews.json', review('confirmed'));
  await service.migrateProfiles();
  assert.equal(profileFiles(files).length, 1);
  const merged = files.get(profileFiles(files)[0]).text;
  assert.ok(merged.includes(a.dataset)); assert.ok(merged.includes(b.dataset));
  files.get('Person/Analysis/reviews.json').text = review('rejected');
  await service.migrateProfiles();
  const split = profileFiles(files).map(path => files.get(path).text);
  assert.equal(split.length, 2);
  assert.equal(split.filter(text => text.includes(a.dataset)).length, 1);
  assert.equal(split.filter(text => text.includes(b.dataset)).length, 1);
  assert.ok(backups.size >= 3);
  const snapshot = [...files].map(([path, entry]) => [path, entry.text]);
  await service.migrateProfiles();
  assert.deepEqual([...files].map(([path, entry]) => [path, entry.text]), snapshot);
});

test('changing a merged confirmed profile to related splits notes before linking the separate people', async () => {
  const { service, files, add, owner } = setup();
  const a = profileRecord('a'), b = profileRecord('b', 'Bob', 'tiktok');
  add('Person/Analysis/Profiles/Alice.md', legacyDocument(a));
  add('Person/Analysis/Profiles/Bob.md', legacyDocument(b));
  add('Person/Analysis/reviews.json', JSON.stringify({ [`${a.id} → ${b.id}`]: { status: 'confirmed', source_id: a.id, candidate_id: b.id } }));
  await service.migrateProfiles();
  assert.equal(profileFiles(files).length, 1);
  const linked = [];
  service.plugin.graph.addConfirmedLink = async (from, to) => linked.push([from, to]);
  service.plugin.graph.removeConfirmedLink = async () => {};
  await service.review(owner, a, b, 'related');
  assert.equal(profileFiles(files).length, 2);
  assert.equal(linked.length, 1);
  assert.notEqual(linked[0][0], linked[0][1]);
});

test('promotion preserves canonical profile content, remaps references, carries depth-one connections and reuses promoted identity', async () => {
  const { service, files, add, owner, backups, trashed } = setup();
  const a = profileRecord('a'), b = profileRecord('b', 'Bob', 'tiktok'), c = profileRecord('c', 'Cara', 'reddit');
  const old = 'Person/Connections/Alice.md', bob = 'Person/Connections/Bob.md', cara = 'Person/Connections/Cara.md';
  const profile = add(old, legacyDocument(a) + '\nManual annotation [[Person/Connections/Bob]]\n');
  add(bob, legacyDocument(b)); add(cara, legacyDocument(c));
  add('Person/Notes.md', `[[${old}|Alice]]`);
  const promoted = { id: 'alice', folderPath: 'People/Alice' };
  add('People/Alice/Alice.md', '---\ncomsift_id: alice\n---\n');
  add('People/Alice/Alice.canvas', JSON.stringify({ nodes: [{ id: 'comsift-main', type: 'text', text: 'Alice', x: 0, y: 0, width: 340, height: 96 }], edges: [] }));
  service.plugin.setting = { embedCanvas: true, embedDivider: true };
  service.plugin.investigations.mdPath = item => `${item.folderPath}/Alice.md`;
  service.plugin.investigations.canvasPath = item => `${item.folderPath}/Alice.canvas`;
  service.plugin.investigations.forPrimaryPath = path => path === 'People/Alice/Alice.md' ? promoted : null;
  service.plugin.app.fileManager.processFrontMatter = async (file, callback) => {
    const data = {}; callback(data);
    files.get(file.path).text = files.get(file.path).text.replace(/^---\n/, `---\n${Object.entries(data).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n`);
  };
  service.plugin.state.graphSources = { one: { [old]: [bob], [bob]: [cara] } };
  await service.promoteProfile(profile, promoted);
  assert.deepEqual(trashed, [old]);
  assert.ok(backups.size >= 1);
  const text = files.get('People/Alice/Alice.md').text;
  assert.match(text, /Manual annotation/); assert.match(text, /comsift_id: "alice"/); assert.match(text, /!\[\[Alice.canvas\]\]/);
  assert.equal(files.get('Person/Notes.md').text, '[[People/Alice/Alice.md|Alice]]');
  const board = JSON.parse(files.get('People/Alice/Alice.canvas').text);
  assert.deepEqual(board.nodes.filter(node => node.type === 'file').map(node => node.file), [bob]);
  assert.equal(board.edges.length, 1);
  assert.equal(board.edges[0].comsift_type, 'normal', 'a generic connection never implies an evidenced related-person verdict');
  const canonical = await service.profileNote(owner, { ...a, raw: {} });
  assert.equal(canonical.path, 'People/Alice/Alice.md');
  assert.equal(files.has(old), false);
  assert.equal([...files.keys()].filter(path => path.startsWith('Person/Connections/') && /Alice/.test(path)).length, 0);
});

test('migration preserves an unrelated destination collision and moves old profiles only once', async () => {
  const { service, files, add, backups } = setup();
  const record = profileRecord('a');
  add('Person/Analysis/Profiles/Alice.md', legacyDocument(record));
  add('Person/Connections/Alice (instagram).md', '# Handwritten unrelated note\n');
  await service.migrateProfiles();
  assert.equal(files.get('Person/Connections/Alice (instagram).md').text, '# Handwritten unrelated note\n');
  assert.equal(files.has('Person/Analysis/Profiles/Alice.md'), false);
  const snapshot = [...files].map(([path, entry]) => [path, entry.text]);
  const count = backups.size;
  await service.migrateProfiles();
  assert.deepEqual([...files].map(([path, entry]) => [path, entry.text]), snapshot);
  assert.equal(backups.size, count);
});

test('identity migration keeps a promoted primary in place instead of recreating it under Connections', async () => {
  const { service, files, add, owner } = setup();
  const record = profileRecord('a');
  const primary = 'People/Alice/Alice.md';
  const promoted = { id: 'alice', folderPath: 'People/Alice' };
  const primaryFile = add(primary, legacyDocument(record) + '\nPersonal investigation notes\n');
  service.plugin.investigations.forPrimaryPath = path => path === primary ? promoted : null;
  await service.profileNote(owner, { ...record, raw: {} });
  await service.migrateProfiles();
  assert.equal(files.get(primary).file, primaryFile);
  assert.match(files.get(primary).text, /Personal investigation notes/);
  assert.equal([...files.keys()].filter(path => path.includes('/Connections/')).length, 0);
  const snapshot = files.get(primary).text;
  await service.migrateProfiles();
  assert.equal(files.get(primary).text, snapshot);
});

test('chat context includes scoped connection profiles and stored relationships without Analysis internals', async () => {
  const { service, files, add } = setup();
  const record = profileRecord('a');
  const path = 'Person/Connections/Alice.md';
  add(path, `---\nrelationships:\n  - "[[Person/Connections/Bob]]"\n---\n# Alice\n\nAccount evidence\n`);
  add('Person/Analysis/internal.md', '# Internal result dump');
  add('Other/Connections/Outside.md', legacyDocument(record));
  for (const entry of files.values()) { entry.file.basename = entry.file.path.split('/').at(-1).replace(/\.md$/, ''); entry.file.stat = { mtime: 1 }; }
  service.plugin.app.vault.cachedRead = service.plugin.app.vault.read;
  service.plugin.app.metadataCache.resolvedLinks = {};
  service.plugin.setting = { ollamaContext: 8192 };
  service.plugin.investigations.mdPath = item => `${item.folderPath}/Person.md`;
  const context = await service.chatContext(['Person'], 'Who is Alice?', null);
  assert.ok(context.files.some(file => file.path === path));
  assert.match(context.files.find(file => file.path === path).content, /Stored connections[\s\S]*Person\/Connections\/Bob/);
  assert.equal(context.files.some(file => file.path.includes('internal') || file.path.startsWith('Other/')), false);
});

test('batch profile import reads existing notes once and reuses newly indexed identities', async () => {
  const { service, files, add, owner } = setup();
  for (let i = 0; i < 25; i++) add(`Person/Connections/Existing ${i}.md`, legacyDocument(profileRecord(`old${i}`, `existing${i}`)));
  let reads = 0;
  const original = service.plugin.app.vault.read;
  service.plugin.app.vault.read = async file => { reads++; return original(file); };
  const records = [];
  for (let i = 0; i < 50; i++) {
    const record = { ...profileRecord(`new${i}`, `new${i}`), raw: {} };
    records.push(record, { ...record, id: `Person/copy${i}.sheet.md:9`, dataset: `Person/copy${i}.sheet.md`, row: 9 });
  }
  await service.importRecords(owner, records);
  assert.equal(reads, 25, 'only the initial index reads existing profile content');
  assert.equal([...files.keys()].filter(path => path.includes('/Connections/')).length, 75);
  const merged = [...files.values()].filter(entry => entry.text.includes('Person/copy0.sheet'));
  assert.equal(merged.length, 1);
  assert.match(merged[0].text, /Person\/new0.sheet/);
});

test('reused source row labels never replace an earlier person profile', async () => {
  const { service, files, owner } = setup();
  const a = { ...profileRecord('a', 'Alice'), raw: {} };
  const original = await service.profileNote(owner, a);
  const other = await service.profileNote(owner, { ...a, fields: { username: 'Bob', platform: 'instagram' } });
  assert.notEqual(original.path, other.path);
  assert.match(files.get(original.path).text, /\\"username\\":\\"Alice\\"/);
});

test('existing latest analyses backfill all people including rejected rows and migrate legacy notes', async () => {
  const { service, add, owner, files } = setup();
  const record = (id, name) => ({ id, dataset: 'Person/roblox.csv', row: 1, fields: { username: name, platform: 'roblox' }, raw: {} });
  const alice = record('a', 'alice'), bob = record('b', 'bob');
  add('Person/Analysis/Profiles/Legacy Alice.md', service.profileBody([alice], 'alice') + '\nManual evidence stays.\n');
  const stale = add('Person/Analysis/run-1.json', JSON.stringify({ records: [record('stale', 'old_import')], pairs: [], jina: [] }));
  stale.stat = { mtime: 1 };
  const current = add('Person/Analysis/run-2.json', JSON.stringify({ records: [alice, bob], pairs: [], jina: [] }));
  current.stat = { mtime: 2 };
  add('Person/Analysis/reviews.json', JSON.stringify({ 'a → b': { status: 'rejected' } }));
  assert.equal(await service.upgradeConnections(), 2);
  const connections = [...files].filter(([path]) => path.startsWith('Person/Connections/'));
  assert.equal(connections.length, 2);
  assert.ok(connections.some(([, entry]) => entry.text.includes('Manual evidence stays.')));
  assert.ok(![...files].some(([path]) => path.includes('/Analysis/Profiles/')));
  assert.ok(!connections.some(([path]) => path.includes('old_import')));
  assert.equal(await service.upgradeConnections(), 2);
  assert.equal([...files].filter(([path]) => path.startsWith('Person/Connections/')).length, 2);
});

test('sparse source observations cannot bridge conflicting account identifiers during import', async () => {
 const {service,files,owner}=setup();
 const row=(id,user_id)=>({...profileRecord(id,'alice','roblox'),fields:{username:'alice',platform:'roblox',...(user_id?{user_id}:{})},raw:{}});
 await service.importRecords(owner,[row('first','1'),row('sparse',''),row('conflict','2')]);
 assert.equal([...files.keys()].filter(path=>path.includes('/Connections/')).length,2);
});

test('promotion preserves existing relationship direction and style instead of inventing Related', async () => {
 const {service,files,add}=setup();
 const old='Person/Connections/Alice.md', bob='Person/Connections/Bob.md';
 const profile=add(old,legacyDocument(profileRecord('alice')));
 add(bob,legacyDocument(profileRecord('bob','Bob','roblox')));
 add('Person/Existing.canvas',JSON.stringify({nodes:[
  {id:'a',type:'file',file:old,x:0,y:0,width:300,height:200},
  {id:'b',type:'file',file:bob,x:400,y:0,width:300,height:200}],
  edges:[{id:'old-edge',fromNode:'b',fromSide:'left',toNode:'a',toSide:'right',comsift_type:'uncertain',label:'Maybe',color:'#ffcc00',styleAttributes:{lineStyle:'dashed'},comsift_review:'original-review'}]}));
 const item={id:'alice',folderPath:'People/Alice'};
 add('People/Alice/Alice.md','# Alice');
 add('People/Alice/Alice.canvas',JSON.stringify({nodes:[{id:'comsift-main',type:'text',text:'Alice',x:0,y:0,width:300,height:100}],edges:[]}));
 service.plugin.setting={embedCanvas:false};
 service.plugin.investigations.mdPath=()=> 'People/Alice/Alice.md';
 service.plugin.investigations.canvasPath=()=> 'People/Alice/Alice.canvas';
 service.plugin.app.fileManager.processFrontMatter=async (_file,cb)=>cb({});
 await service.promoteProfile(profile,item,1);
 const board=JSON.parse(files.get('People/Alice/Alice.canvas').text);
 const edge=board.edges[0];
 assert.equal(edge.comsift_type,'uncertain');
 assert.equal(edge.label,'Maybe');
 assert.equal(edge.color,'#ffcc00');
 assert.deepEqual(edge.styleAttributes,{lineStyle:'dashed'});
 assert.equal(edge.toNode,'comsift-main');
 assert.equal(board.nodes.find(node=>node.id===edge.fromNode).file,bob);
 assert.equal(edge.comsift_review,undefined);
});


test('main person custom fields load as a matching dataset without requiring imported records', async () => {
  const { service, owner, add } = setup();
  const primary = add('Person/Person.md', '# Person');
  service.plugin.investigations.forPrimaryPath = path => path === primary.path ? owner : null;
  service.plugin.setting = {};
  service.plugin.app.vault.cachedRead = service.plugin.app.vault.read;
  service.plugin.app.metadataCache.getFileCache = () => ({ frontmatter: { comsift_custom_fields: { username: 'silly', profile_url: 'https://example.test/silly', invalid: 42 } } });
  assert.ok(service.listDatasets().includes(primary));
  const datasets = await service.loadDatasets([primary.path]);
  assert.equal(datasets.length, 1);
  assert.equal(datasets[0].records[0].fields.username, 'silly');
  assert.equal(datasets[0].records[0].fields.invalid, undefined);
});

test('destructive rebuild parses sources first, backs up generated notes, and keeps promoted people', async () => {
  const { service, owner, add, files, backups, trashed } = setup();
  const source = add('Person/a.csv', 'Username\nalice\n');
  const profile = add('Person/Connections/Alice.md', '');
  // Use the production serializer rather than depending on YAML quoting here.
  const record = { id: 'a:1', dataset: 'a.csv', row: 1, fields: { username: 'alice' }, raw: {} };
  files.get(profile.path).text = service.profileBody([record], 'Alice');
  const promoted = add('Person/Connections/Promoted.md', files.get(profile.path).text);
  service.plugin.investigations.forPrimaryPath = path => path === promoted.path ? owner : null;
  service.plugin.app.vault.cachedRead = service.plugin.app.vault.read;
  service.plugin.setting = {};
  const events = [];
  service.loadDatasets = async paths => { assert.deepEqual(paths, [source.path]); return [{ name: source.path, csv: 'x' }]; };
  service.resolvedMappings = async () => ({ [source.path]: { username: 'Username' } });
  Object.defineProperty(service, 'runner', { value: { run: async request => { events.push('parsed'); return [record]; } } });
  service.importRecords = async (item, records) => { events.push('imported'); assert.equal(records[0].id, record.id); };
  assert.equal(await service.rebuildConnections(owner, 'destructive'), 1);
  assert.deepEqual(events, ['parsed', 'imported']);
  assert.deepEqual(trashed, [profile.path]);
  assert.ok(files.has(promoted.path));
  assert.equal(backups.size, 1);
  const snapshot = JSON.parse([...backups.values()][0]);
  assert.equal(snapshot[0].path, profile.path);
  assert.match(snapshot[0].content, /comsift_profile_data/);
});

test('merge rebuild preserves existing fields and adds newly enabled source values', async () => {
  const { service, owner, add, files, backups, trashed } = setup();
  add('Person/a.csv', 'Username\nalice\n');
  const old = { id: 'a:1', dataset: 'a.csv', row: 1, fields: { username: 'alice', bio: 'Keep this', website: '' }, raw: {} };
  add('Person/Connections/Alice.md', service.profileBody([old], 'Alice'));
  service.plugin.setting = {};
  service.loadDatasets = async () => [{ name: 'a.csv', csv: 'x' }];
  service.resolvedMappings = async () => ({});
  Object.defineProperty(service, 'runner', { value: { run: async () => [{ ...old, fields: { username: 'alice', bio: '', website: 'https://example.test' } }] } });
  let imported;
  service.importRecords = async (item, records) => { imported = records; };
  await service.rebuildConnections(owner, 'merge');
  assert.equal(imported[0].fields.bio, 'Keep this');
  assert.equal(imported[0].fields.website, 'https://example.test');
  assert.equal(trashed.length, 0);
  assert.equal(backups.size, 0);
  assert.ok(files.has('Person/Connections/Alice.md'));
});

test('removing a profile relation deletes both staged and committed decisions permanently', async () => {
  const { service, owner, add, files } = setup();
  const record = (id, username) => ({ id, dataset: 'a.csv', row: 1, fields: { username }, raw: {} });
  add('Person/Connections/Alice.md', service.profileBody([record('a:1', 'alice')], 'Alice'));
  add('Person/Person.md', service.profileBody([record('b:1', 'bob')], 'Bob'));
  const reviewPath = 'Person/Analysis/reviews.json';
  add(reviewPath, JSON.stringify({
    'a:1 → b:1': { status: 'related', pending: true, source_id: 'a:1', candidate_id: 'b:1', graph_id: 'draft', committedReview: { status: 'confirmed', graph_id: 'committed' } },
    'a:1 → c:1': { status: 'related', source_id: 'a:1', candidate_id: 'c:1' },
  }));
  const removed = [];
  service.plugin.graph.removeConfirmedLink = async id => { removed.push(id); };
  await service.clearProfileRelation('Person/Connections/Alice.md', 'Person/Person.md');
  const saved = JSON.parse(files.get(reviewPath).text);
  assert.equal(saved['a:1 → b:1'], undefined);
  assert.ok(saved['a:1 → c:1']);
  assert.deepEqual(removed.sort(), ['committed', 'draft']);
});

test('selecting a sheet includes its bare primary person and explicit accounts as matching targets', async () => {
  const {service, owner, add} = setup();
  const primary = add('Person/Person.md', '# ExamplePerson');
  const sheet = add('Person/Following.csv', 'Username,Name\nexample.person,Example\n');
  service.plugin.investigations.forPrimaryPath = path => path === primary.path ? owner : null;
  service.plugin.setting = {};
  service.plugin.app.vault.cachedRead = service.plugin.app.vault.read;
  service.plugin.app.metadataCache.getFileCache = file => ({frontmatter: file === primary ? {
    title:'ExamplePerson', comsift_profiles:[{service:'instagram',username:'exampleperson'}], comsift_accounts:['twitch|silly']
  } : {}});
  const datasets = await service.loadDatasets([sheet.path], undefined, true);
  const person = datasets.find(dataset => dataset.name === primary.path);
  assert.ok(person);
  assert.deepEqual(person.records.map(record => record.fields.display_name), ['ExamplePerson','ExamplePerson','ExamplePerson']);
  assert.equal(person.records[0].fields.username, undefined);
  assert.equal(person.records[1].fields.username, 'exampleperson');
  assert.equal(person.records[1].fields.platform, 'instagram');
  assert.equal(person.records[2].fields.username, 'silly');
  assert.ok(person.records.every(record => record.is_primary));
  for (const record of person.records) assert.equal(await service.profileNote(owner,record), primary);
});

test('weak primary-name matching defaults off and only an explicit setting enables it', async () => {
  const {service} = setup();
  service.resolvedMappings = async () => ({});
  const requests = [];
  Object.defineProperty(service, "runner", {value: {run: async request => { requests.push(request); return {records:[],pairs:[],jina:[]}; }}});
  service.plugin.setting = {analysisMode:'splink',splinkThreshold:0.5,analysisLowThreshold:0.2};
  await service.runDatasets([{name:'Person/Person.md',csv:'',records:[]}]);
  assert.equal(requests.at(-1).allow_primary_name_candidates,false);
  service.plugin.setting.allowPrimaryNameCandidates = true;
  await service.runDatasets([{name:'Person/Person.md',csv:'',records:[]}]);
  assert.equal(requests.at(-1).allow_primary_name_candidates,true);
  service.plugin.setting.allowPrimaryNameCandidates = false;
  await service.runDatasets([{name:'Person/Person.md',csv:'',records:[]}]);
  assert.equal(requests.at(-1).allow_primary_name_candidates,false);
});
