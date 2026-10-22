import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { build } from 'esbuild';
const result = await build({ entryPoints: ['src/analysis/ollama.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { OllamaClient, OpenAiClient } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'));
const tools = [{ type: 'function', function: { name: 'read_canvas', description: 'Read', parameters: { type: 'object', properties: {} } } }];
const messages = [{ role: 'user', content: 'Read board' }, { role: 'assistant', content: '', calls: [{ id: 'call_real', name: 'read_canvas', arguments: { path: 'Map.canvas' } }] }, { role: 'tool', callId: 'call_real', name: 'read_canvas', content: '{"nodes":[]}' }];
async function fixture(handler, run) {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => handler(JSON.parse(body), response));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const settings = { ollamaUrl: `http://127.0.0.1:${address.port}`, apiBaseUrl: `http://127.0.0.1:${address.port}/v1`, ollamaModel: 'local:9b', ollamaContext: 8192, ollamaTimeout: 5 };
    await run(settings);
  } finally { await new Promise(resolve => server.close(resolve)); }
}
test('Ollama native tools preserve tool-name results and stream final prose', async () => {
  await fixture((body, response) => {
    assert.deepEqual(body.tools, tools);
    assert.equal(body.stream, true);
    assert.deepEqual(body.messages[1].tool_calls[0].function.arguments, { path: 'Map.canvas' });
    assert.equal(body.messages[2].role, 'tool');
    assert.equal(body.messages[2].tool_name, 'read_canvas');
    response.end('{"message":{"content":"Hel"}}\n{"message":{"content":"lo"},"done":true}\n');
  }, async settings => {
    const seen = [];
    const answer = await new OllamaClient(settings).toolChat(messages, tools, undefined, false, text => seen.push(text));
    assert.equal(answer.content, 'Hello');
    assert.deepEqual(seen, ['Hel', 'Hello']);
  });
});
test('Ollama returns native structured calls independently of text', async () => {
  await fixture((_body, response) => response.end('{"message":{"content":"","tool_calls":[{"function":{"name":"read_canvas","arguments":{"path":"Map.canvas"}}}]},"done":true}\n'), async settings => {
    const answer = await new OllamaClient(settings).toolChat([], tools);
    assert.deepEqual(answer.calls[0], { id: 'call_0', name: 'read_canvas', arguments: { path: 'Map.canvas' } });
  });
});
test('OpenAI assembles fragmented native calls and sends matching tool_call_id', async () => {
  await fixture((body, response) => {
    assert.equal(body.messages[2].tool_call_id, 'call_real');
    assert.equal(body.messages[1].tool_calls[0].id, 'call_real');
    assert.equal(body.messages[1].tool_calls[0].function.arguments, '{"path":"Map.canvas"}');
    response.end([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_new', type: 'function', function: { name: 'read_canvas', arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Map.canvas"}' } }] } }] },
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n');
  }, async settings => {
    const answer = await new OpenAiClient(settings).toolChat(messages, tools);
    assert.deepEqual(answer.calls, [{ id: 'call_new', name: 'read_canvas', arguments: '{"path":"Map.canvas"}' }]);
  });
});

test('Ollama decisions honor Think even when extra parameters disagree', async () => {
  await fixture((body, response) => {
    assert.equal(body.think, false);
    assert.equal(body.stream, false);
    const data = JSON.parse(body.messages[1].content);
    assert.deepEqual(data.candidates.map(candidate => candidate.id), ['candidate_1']);
    response.end(JSON.stringify({ message: { content: JSON.stringify({ candidate_id: 'candidate_1', uncertain: true,
      explanation: 'Not enough evidence.', supporting_evidence: [], conflicting_evidence: [],
      verdicts: [{ candidate_id: 'candidate_1', verdict: 'uncertain', reason: 'Not enough evidence.' }] }) } }));
  }, async settings => {
    const client = new OllamaClient({ ...settings, ollamaThink: false, apiExtraParams: 'think=true' });
    const decision = await client.decide({ id: 'source', fields: { username: 'one' } }, [{ id: 'uncertain', fields: { username: 'two' } }], [], []);
    assert.equal(decision.verdicts[0].verdict, 'uncertain');
  });
});

for (const Provider of [OllamaClient, OpenAiClient]) {
  test(`${Provider.name} filters prefixed hidden columns, IDs and score evidence on both passes`, async () => {
    await fixture((body, response) => {
      const data = JSON.parse(body.messages[1].content);
      assert.equal(data.source.id, 'source');
      assert.deepEqual(data.source.profile, { username: 'visible' });
      assert.deepEqual(data.candidates[0].profile, { username: 'visible_alt' });
      assert.equal(data.candidates[0].id, 'candidate_1');
      assert.doesNotMatch(JSON.stringify(body.messages), /SECRET|private-dataset|sensitive-evidence/);
      const decision = { candidate_id: 'candidate_1', uncertain: false, explanation: 'Explicit collaborator link.',
        supporting_evidence: [], conflicting_evidence: [], verdicts: [{ candidate_id: 'candidate_1', verdict: 'related', reason: 'Explicit collaborator link.' }] };
      response.end(JSON.stringify(Provider === OllamaClient ? { message: { content: JSON.stringify(decision) } }
        : { choices: [{ message: { content: JSON.stringify(decision) } }] }));
    }, async settings => {
      const client = new Provider({ ...settings, decisionIgnoredFields: 'discord_id, location, platform' });
      const source = { id: 'private-dataset:SECRET-source', fields: { username: 'visible', 'id:discord_id': 'SECRET-id', 'note:location': 'SECRET-place', platform: 'SECRET-platform' }, raw: { secret: 'SECRET-raw' } };
      const candidate = { id: 'private-dataset:SECRET-candidate', fields: { username: 'visible_alt', 'column:discord_id': 'SECRET-id' } };
      for (const scores of [false, true]) {
        const decision = await client.decide(source, [candidate], [{ left_id: source.id, right_id: candidate.id, match_probability: 0.5, evidence: { username: 'sensitive-evidence' } }], [], undefined,
          { scores, ...(scores ? { earlier: { candidate_id: candidate.id, verdicts: [{ candidate_id: candidate.id, verdict: 'uncertain', reason: 'Visible handle variant.' }] } } : {}) });
        assert.equal(decision.candidate_id, candidate.id);
        assert.equal(decision.verdicts[0].candidate_id, candidate.id);
        assert.equal(decision.verdicts[0].verdict, 'related');
      }
    });
  });

  test(`${Provider.name} rejects incomplete or duplicate candidate verdicts`, async () => {
    for (const verdicts of [[], [{ candidate_id: 'candidate_1', verdict: 'same', reason: 'Link' }, { candidate_id: 'candidate_1', verdict: 'same', reason: 'Duplicate' }]]) {
      await fixture((_body, response) => {
        const decision = { candidate_id: 'candidate_1', uncertain: false, explanation: 'Evidence', supporting_evidence: [], conflicting_evidence: [], verdicts };
        response.end(JSON.stringify(Provider === OllamaClient ? { message: { content: JSON.stringify(decision) } } : { choices: [{ message: { content: JSON.stringify(decision) } }] }));
      }, async settings => {
        await assert.rejects(new Provider(settings).decide({ id: 'source', fields: {} }, [{ id: 'one', fields: {} }], [], []), /exactly once/);
      });
    }
  });
}
