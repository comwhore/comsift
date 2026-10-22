import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['src/analysis/chatTools.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { CHAT_TOOLS, executeChatTool, runChatTools, canvasEditingRequest } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
const files = ['Person/Map.canvas', 'Sketch.canvas', '.obsidian/secret.canvas'].map(path => ({ path, extension: 'canvas' }));
const data = { nodes: [{ id: 'real', type: 'text', text: 'Hello', x: 0, y: 0, width: 100, height: 50 }, { id: 'group', type: 'group', label: 'Overview', x: 0, y: 0, width: 400, height: 200 }], edges: [] };
function fixture(question = 'Show the nodes in the canvas') {
  return { plugin: { setting: { ollamaContext: 8192 }, app: { vault: { getFiles: () => files } }, canvasTools: { read: async () => structuredClone(data) } }, question, prepareEdit: async () => {} };
}
const empty = () => ({ edits: [], handoffs: [], toolResults: [] });
const call = (name, args, id = name) => ({ id, name, arguments: args });
test('read-only Canvas embeds validate actual paths and IDs and produce native group embeds', async () => {
  const env = fixture(), artifacts = empty();
  assert.match(await executeChatTool(call('canvas_embed', { path: 'Missing.canvas', ids: ['real'] }), env, artifacts), /Unknown Canvas path/);
  assert.match(await executeChatTool(call('canvas_embed', { path: 'Sketch.canvas', ids: ['invented'] }), env, artifacts), /Unknown node/);
  const valid = await executeChatTool(call('canvas_embed', { path: 'Sketch.canvas', ids: ['group'] }), env, artifacts);
  assert.equal(JSON.parse(valid).embeds, '![[Sketch.canvas#group|Overview]]');
  assert.equal(artifacts.handoffs.length, 0);
  assert.match(await executeChatTool(call('canvas_handoff', { path: 'Sketch.canvas', prompt: 'edit' }), env, artifacts), /handoff requires/);
  assert.equal(artifacts.handoffs.length, 0);
  const whole = await executeChatTool(call('canvas_embed', { path: 'Sketch.canvas' }), env, artifacts);
  assert.equal(JSON.parse(whole).embeds, '![[Sketch.canvas]]');
  assert.match(await executeChatTool(call('canvas_embed', { path: 'Ghost.canvas' }), env, artifacts), /Unknown Canvas path/);
});
test('tool loop sends bad IDs back to model, repairs them and displays the result even when final prose omits it', async () => {
  const requests = [];
  const client = { toolChat: async messages => {
    requests.push(structuredClone(messages));
    if (requests.length === 1) return { content: '', calls: [call('canvas_embed', { path: 'Sketch.canvas', ids: ['wrong'] })] };
    if (requests.length === 2) { assert.match(messages.at(-1).content, /Unknown node/); return { content: '', calls: [call('canvas_embed', { path: 'Sketch.canvas', ids: ['real'] })] }; }
    return { content: 'Here it is.', calls: [] };
  } };
  const result = await runChatTools(client, [{ role: 'user', content: 'show nodes' }], CHAT_TOOLS, fixture(), () => {});
  assert.match(result.answer, /!\[\[Sketch\.canvas#real\|Hello\]\]/);
  assert.equal(result.toolResults.filter(result => result.status === 'error').length, 1);
  assert.equal(requests.length, 3);
});
test('unsupported native tools fall back to validated JSON calls and return review artifacts independently of prose', async () => {
  let calls = 0;
  const env = fixture('Edit the canvas');
  const client = { toolChat: async () => { throw new Error('model does not support tools'); }, chatStream: async messages => {
    calls++;
    if (calls === 1) return JSON.stringify({ content: '', tool_calls: [{ name: 'canvas_handoff', arguments: { path: 'Sketch.canvas', prompt: 'Move the overview group.' } }] });
    assert.match(messages.at(-1).content, /awaiting_user_review/);
    return JSON.stringify({ content: '', tool_calls: [] });
  } };
  const result = await runChatTools(client, [], CHAT_TOOLS, env, () => {});
  assert.deepEqual(result.handoffs, [{ path: 'Sketch.canvas', prompt: 'Move the overview group.' }]);
  assert.equal(result.answer, '');
});
test('legacy invented handoff paths and direct invalid embeds are validated and sent back for repair', async () => {
  let step = 0;
  const client = { toolChat: async messages => {
    step++;
    if (step === 1) return { content: '<canvas-handoff path="Ghost.canvas">Move nodes</canvas-handoff>', calls: [] };
    if (step === 2) { assert.match(messages.at(-1).content, /Unknown Canvas path/); return { content: '', calls: [call('canvas_handoff', { path: 'Sketch.canvas', prompt: 'Move nodes' })] }; }
    return { content: 'Ready for review.', calls: [] };
  } };
  const result = await runChatTools(client, [], CHAT_TOOLS, fixture('Move the nodes on this canvas'), () => {});
  assert.equal(result.handoffs[0].path, 'Sketch.canvas');
  assert.doesNotMatch(result.answer, /Ghost|canvas-handoff/);
  let embedStep = 0;
  const embedded = await runChatTools({ toolChat: async messages => {
    embedStep++;
    if (embedStep === 1) return { content: '![[Sketch.canvas#fake]]', calls: [] };
    assert.match(messages.at(-1).content, /Unknown node/);
    return { content: '', calls: [call('canvas_embed', { path: 'Sketch.canvas', ids: ['real'] })] };
  } }, [], CHAT_TOOLS, fixture(), () => {});
  assert.doesNotMatch(embedded.answer, /#fake/);
  assert.match(embedded.answer, /#real/);
});
test('missing Canvas actions get one corrective turn and bounded failures preserve successful proposals', async () => {
  let step = 0;
  const result = await runChatTools({ toolChat: async messages => {
    step++;
    if (step === 1) return { content: 'Open Canvas chat yourself.', calls: [] };
    assert.match(messages.at(-1).content, /actual editable Canvas handoff/);
    return { content: '', calls: [call('canvas_handoff', { path: 'Sketch.canvas', prompt: 'Move the node' })] };
  } }, [], CHAT_TOOLS, fixture('Move the node in the canvas'), () => {});
  assert.equal(result.handoffs.length > 0, true);
  assert.equal(result.handoffs.length, 1);
  assert.ok(step <= 7);
  assert.equal(canvasEditingRequest('Create a note about this canvas'), false);
  assert.equal(canvasEditingRequest('Create a Mermaid diagram'), false);
});
test('note proposal errors are returned to the model and never written', async () => {
  const env = fixture('Create a note');
  env.prepareEdit = async () => { throw new Error('Edit path escapes selected folder'); };
  const artifacts = empty();
  const error = await executeChatTool(call('propose_note_edit', { path: '../bad.md', action: 'create', content: 'text' }), env, artifacts);
  assert.match(error, /escapes/);
  assert.deepEqual(artifacts.edits, []);
});
test('large Canvas inventories and pages have bounded results and retain real IDs', async () => {
  const env = fixture();
  env.plugin.app.vault.getFiles = () => Array.from({ length: 1500 }, (_, index) => ({ path: `Board ${index}.canvas`, extension: 'canvas' }));
  env.plugin.canvasTools.read = async () => ({ nodes: Array.from({ length: 1000 }, (_, index) => ({ ...data.nodes[0], id: `node${index}`, text: 'x'.repeat(2000) })), edges: [] });
  const inventory = await executeChatTool(call('list_canvases', {}), env, empty());
  assert.ok(inventory.length < 6500);
  assert.equal(JSON.parse(inventory).boards.length, 20);
  const page = await executeChatTool(call('read_canvas', { path: 'Board 0.canvas', offset: 20 }), env, empty());
  assert.ok(page.length < 6500);
  assert.equal(JSON.parse(page).nodes[0].id, 'node20');
  assert.ok(JSON.parse(page).nextOffset > 20);
});

test('file deletion is a proposal that needs no content and rejects unknown actions', async () => {
  const env = fixture(), artifacts = empty();
  const ok = await executeChatTool(call('propose_note_edit', { action: 'delete', path: 'Untitled.md' }), env, artifacts);
  assert.equal(JSON.parse(ok).status, 'awaiting_user_review');
  assert.deepEqual(artifacts.edits[0], { action: 'delete', path: 'Untitled.md', content: '' });
  assert.match(await executeChatTool(call('propose_note_edit', { action: 'erase', path: 'a.md' }), env, artifacts), /Unknown edit action/);
});

test('custom tool access rejects calls to disabled tools, including legacy proposals', async () => {
  let prepared = 0, step = 0;
  const env = fixture('Create a note'); env.prepareEdit = async () => { prepared++; };
  const onlyRead = CHAT_TOOLS.filter(tool => tool.function.name === 'read_canvas');
  const result = await runChatTools({ toolChat: async messages => {
    step++;
    if (step === 1) return { content: '<edit action="create" path="Draft.md">hello</edit>', calls: [] };
    assert.match(messages.at(-1).content, /disabled for this request/);
    return { content: 'File changes are disabled.', calls: [] };
  } }, [], onlyRead, env, () => {});
  assert.equal(prepared, 0); assert.equal(result.edits.length, 0);
  assert.equal(result.answer, 'File changes are disabled.');
});
test('empty custom tool selection uses plain streaming without native tools', async () => {
  let streamed = 0;
  const result = await runChatTools({ toolChat: async () => { throw new Error('must not call tools'); }, chatStream: async (messages, onText) => { streamed++; onText('Hello'); return 'Hello'; } }, [], [], fixture(), () => {});
  assert.equal(streamed, 1); assert.equal(result.answer, 'Hello'); assert.deepEqual(result.edits, []);
});
