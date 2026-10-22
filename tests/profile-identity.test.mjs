import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const output = await build({ entryPoints: ['src/analysis/profileIdentity.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { canonicalPlatform, profileAccountKey, readProfileRecords, mergeProfileContent, mergeProfileDocuments, profileComponents } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].contents).toString('base64'));
const record = (dataset, row = 2) => ({ id: `${dataset}:${row}`, dataset, row, fields: { username: 'Alice', platform: 'instagram' } });
test('confirmed aliases share one identity; related, rejected and ambiguous row IDs do not merge', () => {
  const a = record('Person/a.sheet.md'), b = {...record('Person/b.sheet.md'),fields:{username:'Different',platform:'tiktok'}};
  const entries = [{path:'a.md',scope:'Person',records:[a],text:''},{path:'b.md',scope:'Person',records:[b],text:''}];
  const review = status => ({[`${a.id} → ${b.id}`]:{status}});
  assert.equal(profileComponents(entries,[review('confirmed')]).length,1);
  for (const status of ['related','rejected','uncertain']) assert.equal(profileComponents(entries,[review(status)]).length,2);
  assert.equal(profileComponents([{...entries[0],records:[a,b]}],[]).length,2, 'revoking a merge recovers separate identities');
  const reused = {...a,fields:{username:'SomeoneElse',platform:'instagram'}};
  assert.equal(profileComponents([...entries,{path:'c.md',scope:'Person',records:[reused],text:''}],[review('confirmed')]).length,3);
  assert.notEqual(profileAccountKey({display_name:'Anna',platform:'instagram'},'a'),profileAccountKey({display_name:'Anna',platform:'instagram'},'b'));
});

test('legacy source-prefixed platform names and URL evidence resolve to one account', () => {
  const a = { username: '@ALICE', platform: 'alice7 instagram' };
  const b = { username: 'alice', platform: 'bob7 instagram' };
  assert.equal(profileAccountKey(a, 'a'), profileAccountKey(b, 'b'));
  assert.equal(canonicalPlatform({ platform: 'export', profile_url: 'https://www.instagram.com/Alice/' }), 'instagram');
  assert.equal(canonicalPlatform({ platform: 'bsky' }), 'bluesky');
  assert.notEqual(profileAccountKey(a, 'a'), profileAccountKey({ username: 'alice', platform: 'tiktok' }, 'b'));
});

test('legacy multi-source notes recover each dataset and row from its own record ID', () => {
  const text = `---\ncomsift_records:\n  - "Person/a.sheet.md#Followers:4.2"\n  - "Person/b.sheet.md:8"\n---\n# Alice\n\nSources:\n- [[Person/a.sheet]], row 4\n- [[Person/b.sheet]], row 8\n\n- username: Alice\n- platform: export instagram\n`;
  const records = readProfileRecords(text);
  assert.deepEqual(records.map(({ dataset, row }) => [dataset, row]), [['Person/a.sheet.md#Followers', 4], ['Person/b.sheet.md', 8]]);
  assert.equal(records[0].fields.platform, 'instagram');
});

test('profile generated updates round-trip structured records and preserve annotations and metadata', () => {
  const a = record('Person/a.sheet.md'), b = record('Person/b.sheet.md', 8);
  const original = '---\ntags:\n  - "important"\nreviewed_by: "Human"\n---\nMy hand-written annotation.\n';
  const first = mergeProfileContent([a], 'Alice', original);
  const merged = mergeProfileContent([a, b], 'Alice', first);
  assert.deepEqual(readProfileRecords(merged).map(r => r.id), [a.id, b.id]);
  assert.match(merged, /My hand-written annotation\./);
  assert.match(merged, /reviewed_by: "Human"/);
  assert.match(merged, /important/);
  assert.equal((merged.match(/```comsift-person/g) ?? []).length, 1);
  assert.doesNotMatch(merged, /comsift:profile:start/);
  assert.equal(mergeProfileContent([a, b], 'Alice', merged), merged);
});

test('merging duplicate documents preserves both annotations, graph links, tags and manual metadata', () => {
  const a = record('Person/a.sheet.md'), b = record('Person/b.sheet.md');
  const left = mergeProfileContent([a], 'Alice', '---\ntags:\n  - "first"\n---\nFirst annotation.\n');
  const right = mergeProfileContent([b], 'Alice', '---\ntags:\n  - "second"\nrelationships:\n  - "[[Other person]]"\nreviewed_by: "Human reviewer"\n---\nSecond annotation.\n');
  const merged = mergeProfileDocuments([a, b], 'Alice', [left, right]);
  for (const expected of ['First annotation.', 'Second annotation.', 'first', 'second', '[[Other person]]', 'Human reviewer']) assert.ok(merged.includes(expected), `missing preserved value: ${expected}`);
});

test('very old ID-heading profiles without cached properties remain migratable', () => {
  const text = '# Person/a.sheet.md:5\n\nSource dataset: [[Person/a.sheet]]\nRow: 5\n\n- username: Alice\n- platform: instagram\n';
  assert.equal(readProfileRecords(text)[0]?.id, 'Person/a.sheet.md:5');
});


test('only confirmed review choices merge different accounts; removing confirmation separates them', () => {
  const a = record('Person/a.sheet.md');
  const b = { ...record('Person/b.sheet.md'), fields: { username: 'OtherHandle', platform: 'tiktok' } };
  const c = { ...record('Person/c.sheet.md'), fields: { username: 'ThirdHandle', platform: 'reddit' } };
  const entries = [a, b, c].map((r, index) => ({ path: `Person/Analysis/Profiles/${index}.md`, scope: 'Person', records: [r], text: '' }));
  const review = status => ({ [`${a.id} → ${b.id}`]: { status, source_id: a.id, candidate_id: b.id } });
  assert.equal(profileComponents(entries, [review('confirmed')]).length, 2);
  for (const status of ['rejected', 'related', 'uncertain', 'later']) assert.equal(profileComponents(entries, [review(status)]).length, 3);
  assert.equal(profileComponents(entries, []).length, 3);
  const second = { [`${b.id} → ${c.id}`]: { status: 'confirmed' } };
  assert.equal(profileComponents(entries, [review('confirmed'), second]).length, 1);
});

test('previously merged document splits into independent components and reused row IDs cannot assert identity', () => {
  const a = record('Person/a.sheet.md');
  const b = { ...record('Person/b.sheet.md'), fields: { username: 'OtherHandle', platform: 'tiktok' } };
  const merged = [{ path: 'Person/Analysis/Profiles/Alice.md', scope: 'Person', records: [a, b], text: '' }];
  assert.equal(profileComponents(merged, []).length, 2);
  const recycled = { ...a, fields: { username: 'SomeoneElse', platform: 'instagram' } };
  const entries = [...merged, { path: 'Person/Analysis/Profiles/Old.md', scope: 'Person', records: [recycled], text: '' }];
  const review = { [`${a.id} → ${b.id}`]: { status: 'confirmed' } };
  assert.equal(profileComponents(entries, [review]).length, 3);
});

const identityEntries = rows => rows.map((fields,index)=>({path:`Scope/Connections/${index}.md`,scope:'Scope',records:[{id:`dataset${index}:2`,dataset:`dataset${index}`,row:2,fields}],text:''}));
test('exact identity tolerates absent fields while preserving all source records',()=>{
 const entries=identityEntries([{username:'@ALICE',platform:'instagram',user_id:'123',display_name:'Alice'}, {username:'alice',platform:'instagram'}, {username:'alice',user_id:'123'}]);
 const groups=profileComponents(entries,[]);assert.equal(groups.length,1);assert.equal(groups[0].records.length,3);
});
test('common names and places do not establish profile identity',()=>{
 const entries=identityEntries([{display_name:'Anna',location:'Warsaw'}, {display_name:'Anna',location:'Warsaw'}]);
 assert.equal(profileComponents(entries,[]).length,2);
});
test('same handle cannot merge conflicting identifiers or be bridged by missing identifiers',()=>{
 for(const key of ['user_id','profile_url']) {
  const a={username:'alice',platform:'instagram',[key]:key==='user_id'?'1':'https://instagram.com/alice-1'};
  const b={username:'alice',platform:'instagram',[key]:key==='user_id'?'2':'https://instagram.com/alice-2'};
  const sparse={username:'alice',platform:'instagram'};
  for(const rows of [[a,b],[a,sparse,b],[sparse,a,b],[a,b,sparse]]) {
   const groups=profileComponents(identityEntries(rows),[]);assert.equal(groups.length,2);
   assert.ok(groups.every(group=>new Set(group.records.map(record=>record.fields[key]).filter(Boolean)).size<=1));
  }
 }
});
test('indexed identifiers match even when the newest group member lacks that anchor',()=>{
 const entries=identityEntries([{username:'alice',user_id:'123',platform:'instagram'}, {username:'alice',platform:'instagram'}, {user_id:'123',platform:'instagram'}]);
 assert.equal(profileComponents(entries,[]).length,1);
});
test('explicit same-person reviews remain transitive across conflicting account identifiers',()=>{
 const entries=identityEntries([{username:'alice',platform:'instagram',user_id:'1'}, {username:'alice',platform:'instagram',user_id:'2'}, {username:'other',platform:'tiktok'}]);
 const ids=entries.map(entry=>entry.records[0].id);
 const reviews={[`${ids[0]} → ${ids[1]}`]:{status:'confirmed'},[`${ids[1]} → ${ids[2]}`]:{status:'confirmed'}};
 assert.equal(profileComponents(entries,[reviews]).length,1);
 assert.equal(profileComponents(entries,[]).length,3);
});
test('inferred identity stays within investigation scope',()=>{
 const entries=identityEntries([{username:'alice',platform:'instagram'}, {username:'alice',platform:'instagram'}]);entries[1].scope='Other';
 assert.equal(profileComponents(entries,[]).length,2);
});
