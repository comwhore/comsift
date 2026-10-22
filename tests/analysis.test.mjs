import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";

const result = await build({ entryPoints: ["src/analysis/ollama.ts"], bundle: true, platform: "node", format: "esm", write: false });
const { OllamaClient, validateDecision } = await import(
  "data:text/javascript;base64," + Buffer.from(result.outputFiles[0].contents).toString("base64"));

test("Ollama decisions reject invented candidate IDs and malformed evidence", () => {
  assert.throws(() => validateDecision({ candidate_id: "invented", explanation: "x",
    supporting_evidence: [], conflicting_evidence: [], uncertain: false }, ["real"]));
  assert.deepEqual(validateDecision({ candidate_id: "NO_MATCH", explanation: "Insufficient evidence",
    supporting_evidence: [], conflicting_evidence: ["Different locations"], uncertain: true }, ["real"]).candidate_id, "NO_MATCH");
});

test("Ollama client lists installed models and validates streamed chat response", async () => {
  let chatBody;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/tags") response.end(JSON.stringify({ models: [{ name: "local:latest" }] }));
    else if (request.url === "/api/chat") {
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        chatBody = JSON.parse(body);
        response.end(JSON.stringify({ message: { content: "Hel" } }) + "\n" + JSON.stringify({ message: { content: "lo" }, done: true }) + "\n");
      });
    }
    else { response.statusCode = 404; response.end("{}"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const client = new OllamaClient({ ollamaUrl: `http://127.0.0.1:${address.port}`,
      ollamaModel: "local:latest", ollamaContext: 4096, ollamaTimeout: 5, ollamaDevice: "cpu" });
    assert.deepEqual(await client.models(), ["local:latest"]);
    const seen = [];
    assert.equal(await client.chatStream([{ role: "user", content: "hello" }], text => seen.push(text)), "Hello");
    assert.deepEqual(seen, ["Hel", "Hello"]);
    assert.equal(chatBody.options.num_gpu, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("Ollama request can be cancelled", async () => {
  const server = createServer((_request, response) => {
    setTimeout(() => response.end(JSON.stringify({ models: [] })), 200);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const controller = new AbortController();
    const address = server.address();
    const client = new OllamaClient({ ollamaUrl: `http://127.0.0.1:${address.port}`,
      ollamaModel: "local", ollamaContext: 4096, ollamaTimeout: 5 });
    const pending = client.models(controller.signal);
    controller.abort();
    await assert.rejects(pending, error => error.name === "AbortError");
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("HTTP clients reject malformed external values and interrupted responses", async () => {
  const payloads = [
    { models: [null] },
    { models: "not an array" },
    { models: [{ name: 42 }] },
    { models: [{ name: "local", size: -1 }] },
    { message: { content: { unsafe: true } } },
    { choices: [{ delta: { content: ["unsafe"] } }] },
  ];
  let index = 0;
  let interrupt = false;
  const server = createServer((_request, response) => {
    if (interrupt) {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"models":');
      setImmediate(() => response.destroy());
      return;
    }
    const payload = JSON.stringify(payloads[index++]);
    response.end(index === 6 ? `data: ${payload}\n\n` : `${payload}\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const settings = { ollamaUrl: base, apiBaseUrl: base, ollamaModel: "local", ollamaContext: 4096, ollamaTimeout: 2 };
    const client = new OllamaClient(settings);
    for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(client.models(), Error);
    await assert.rejects(client.running(), /invalid model size/);
    const seen = [];
    await assert.rejects(client.chatStream([], text => seen.push(text)), /invalid message text/);
    const { OpenAiClient } = await import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].contents).toString("base64"));
    await assert.rejects(new OpenAiClient(settings).chatStream([], text => seen.push(text)), /invalid message text/);
    assert.deepEqual(seen, []);
    interrupt = true;
    await assert.rejects(client.models(), /interrupted|aborted|reset|unavailable/i);
    await assert.rejects(client.chatStream([], () => {}), /interrupted|aborted|reset|unavailable/i);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
