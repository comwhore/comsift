import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";

async function load(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", write: false });
  return import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].contents).toString("base64"));
}

const llm = await load("src/analysis/ollama.ts");
const edits = await load("src/analysis/chatEdits.ts");
const slider = await load("src/analysis/contextSlider.ts");
const colors = await load("src/service/colors.ts");
const coloring = await load("src/service/graphColoring.ts");

async function serve(handler, run) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function readBody(request) {
  return new Promise(resolve => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => resolve(body ? JSON.parse(body) : null));
  });
}

test("extra request parameters nest, parse JSON values and split headers", () => {
  const parsed = llm.parseExtraParams("# comment\noptions.temperature=0.2\nstop=[\"###\"]\nname=plain text\nheader.X-Title=comsift\n");
  assert.deepEqual(parsed.body, { options: { temperature: 0.2 }, stop: ["###"], name: "plain text" });
  assert.deepEqual(parsed.headers, { "X-Title": "comsift" });
  assert.throws(() => llm.parseExtraParams("missing equals"));
  assert.throws(() => llm.parseExtraParams("__proto__.polluted=true"), /Invalid extra request parameter/);
  assert.throws(() => llm.parseExtraParams('options={"constructor":{"prototype":{"polluted":true}}}'),
    /Invalid extra request parameter/);
  assert.throws(() => llm.parseExtraParams("header.Host=example.com"), /reserved extra HTTP header/);
  assert.deepEqual(llm.mergeBody({ options: { num_ctx: 1, seed: 1 }, model: "a" }, { options: { seed: 2 } }),
    { options: { num_ctx: 1, seed: 2 }, model: "a" });
});

test("API credentials cannot be sent to a remote HTTP endpoint", async () => {
  const client = llm.createClient({ aiProvider: "openai", apiBaseUrl: "http://example.com/v1", apiKey: "secret",
    ollamaUrl: "", ollamaModel: "m", ollamaContext: 4096, ollamaTimeout: 5 });
  await assert.rejects(client.models(), /credentials require HTTPS/);
});

test("Ollama keeps the model loaded and applies extra parameters", async () => {
  let body;
  await serve(async (request, response) => {
    body = await readBody(request);
    response.end(JSON.stringify({ message: { content: "ok" }, done: true }) + "\n");
  }, async url => {
    const client = llm.createClient({ ollamaUrl: url, ollamaModel: "m", ollamaContext: 4096, ollamaTimeout: 5,
      ollamaKeepAlive: "45m", apiExtraParams: "options.temperature=0.1" });
    assert.equal(await client.chatStream([{ role: "user", content: "hi" }], () => {}), "ok");
    assert.equal(body.keep_alive, "45m");
    assert.equal(body.options.temperature, 0.1);
    assert.equal(body.options.num_ctx, 4096);
  });
});

test("OpenAI compatible client sends the key, streams SSE and returns structured decisions", async () => {
  const seen = [];
  await serve(async (request, response) => {
    seen.push({ url: request.url, auth: request.headers.authorization, title: request.headers["x-title"] });
    if (request.url === "/v1/models") { response.end(JSON.stringify({ data: [{ id: "b" }, { id: "a" }] })); return; }
    const body = await readBody(request);
    if (body.stream) {
      response.setHeader("content-type", "text/event-stream");
      response.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
      response.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
      response.end("data: [DONE]\n\n");
    } else {
      assert.equal(body.response_format.type, "json_schema");
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidate_id: "c1",
        explanation: "same handle", supporting_evidence: ["username"], conflicting_evidence: [], uncertain: false }) } }] }));
    }
  }, async url => {
    const client = llm.createClient({ aiProvider: "openai", apiBaseUrl: `${url}/v1`, apiKey: "sk-test",
      apiExtraParams: "header.X-Title=comsift", ollamaUrl: "", ollamaModel: "gpt", ollamaContext: 4096, ollamaTimeout: 5 });
    assert.deepEqual(await client.models(), ["a", "b"]);
    const parts = [];
    assert.equal(await client.chatStream([{ role: "user", content: "hi" }], text => parts.push(text)), "Hello");
    assert.deepEqual(parts, ["Hel", "Hello"]);
    const source = { id: "s", fields: {} };
    const decision = await client.decide(source, [{ id: "c1", fields: {} }], [], []);
    assert.equal(decision.candidate_id, "c1");
    assert.ok(seen.every(entry => entry.auth === "Bearer sk-test" && entry.title === "comsift"));
    assert.ok(seen.some(entry => entry.url === "/v1/chat/completions"));
  });
});

test("API errors surface the provider message", async () => {
  await serve((_request, response) => {
    response.statusCode = 401;
    response.end(JSON.stringify({ error: { message: "Invalid API key" } }));
  }, async url => {
    const client = llm.createClient({ aiProvider: "openai", apiBaseUrl: url, ollamaUrl: "", ollamaModel: "x", ollamaContext: 1, ollamaTimeout: 5 });
    await assert.rejects(client.models(), /Invalid API key/);
  });
});

test("numbered context keeps real file line numbers and hides managed metadata", () => {
  const text = "---\ncomsift_id: 1\n---\n> [!comsift-links]- Investigation relationships\n> [[A/x]]\n\n# Alice\n\nlikes cats\n";
  assert.equal(edits.numberedForModel("A/Alice.md", text), "L6: \nL7: # Alice\nL8: \nL9: likes cats");
  assert.equal(edits.numberedForModel("A/data.json", "{}"), "{}");
  assert.equal(edits.stripLineNumbers("L5: # Alice\nL7: likes cats"), "# Alice\nlikes cats");
  assert.equal(edits.stripLineNumbers("plain L5: text"), "plain L5: text");
  const parsed = edits.parseEdits('<patch path="A/Alice.md"><find>L9: likes cats</find><replace>L9: likes dogs</replace></patch>');
  assert.equal(parsed.edits[0].find, "likes cats");
  assert.equal(parsed.edits[0].content, "likes dogs");
});

test("line links parse single lines and ranges", () => {
  assert.deepEqual(edits.parseLineLink("Folder/Note#L12"), { path: "Folder/Note", from: 12, to: 12 });
  assert.deepEqual(edits.parseLineLink("Folder/Note.md#L12-L20"), { path: "Folder/Note.md", from: 12, to: 20 });
  assert.deepEqual(edits.parseLineLink("Note#L9-3"), { path: "Note", from: 9, to: 9 });
  assert.equal(edits.parseLineLink("Note#Heading"), null);
});

test("context slider snaps to 1024 unless smooth, within 1024..102400", () => {
  assert.equal(slider.snapContext(5000, false), 5120);
  assert.equal(slider.snapContext(5000, true), 5000);
  assert.equal(slider.snapContext(999999, false), 102400);
  assert.equal(slider.snapContext(10, true), 1024);
});

test("shades dim with distance, dark colors brighten, related is brighter but capped", () => {
  const base = "#3388cc";
  const near = colors.shade(base, 1, 0.2);
  const far = colors.shade(base, 3, 0.2);
  assert.ok(colors.luminance(near) > colors.luminance(base));
  assert.ok(colors.luminance(near) < 0.9);
  assert.ok(colors.luminance(far) < colors.luminance(near));
  const dark = "#101020";
  assert.ok(colors.luminance(colors.shade(dark, 3, 0.2)) > colors.luminance(dark));
  assert.equal(colors.hashColor("x"), colors.hashColor("x"));
  assert.match(colors.randomColor(), /^#[0-9a-f]{6}$/);
  assert.equal(colors.tagSlug("Jan Kowalski!"), "jan-kowalski");
});

test("graph coloring assigns owners, distances, neutral bridges and personas", () => {
  const people = [
    { id: "a", folder: "Alice", color: "#cc3333", tag: "comsift/alice" },
    { id: "b", folder: "Bob", color: "#3333cc", tag: "comsift/bob" },
  ];
  const paths = ["Alice/Alice.md", "Bob/Bob.md", "Shared.md", "Near.md", "Far.md",
    "Alice/Analysis/Profiles/x.md", "Alice/Analysis/Profiles/y.md", "Alice/Analysis/Profiles/z.md"];
  const edges = [["Alice/Alice.md", "Shared.md"], ["Bob/Bob.md", "Shared.md"], ["Alice/Alice.md", "Near.md"], ["Near.md", "Far.md"],
    ["Alice/Analysis/Profiles/x.md", "Alice/Analysis/Profiles/y.md"]];
  const options = { depth: 3, fade: 0.2, bridgeMode: "neutral", bridgeColor: "#888888", personaMix: 0.5 };
  const { notes, groups } = coloring.computeColors(people, paths, edges, options);
  assert.equal(notes.get("Shared.md").color, "#888888");
  assert.deepEqual(notes.get("Shared.md").owners.sort(), ["a", "b"]);
  assert.equal(notes.get("Near.md").distance, 1);
  assert.equal(notes.get("Far.md").distance, 2);
  assert.equal(notes.get("Alice/Analysis/Profiles/x.md").persona, true);
  assert.equal(notes.get("Alice/Analysis/Profiles/z.md").persona, undefined);
  assert.equal(notes.get("Alice/Analysis/Profiles/z.md").color, "#cc3333");
  assert.ok(groups.some(group => group.query === "tag:#comsift/alice"));
  assert.ok(groups.findIndex(group => group.query.includes("Profiles/x.md")) < groups.findIndex(group => group.query === "tag:#comsift/alice"));
  assert.equal(coloring.linkColor(notes.get("Alice/Alice.md"), notes.get("Bob/Bob.md"), options), "#888888");
  assert.equal(coloring.linkColor(notes.get("Near.md"), notes.get("Far.md"), options), notes.get("Near.md").color);
  const mixed = coloring.computeColors(people, paths, edges, { ...options, bridgeMode: "mix" });
  assert.notEqual(mixed.notes.get("Shared.md").color, "#888888");
});

const primary = await load("src/service/primaryNote.ts");
const graphLogic = await load("src/service/graphLogic.ts");

test("legacy title markers become the title property", () => {
  const old = "---\ncomshit_id: x\ntags:\n  - comsift/sample\n---\n<!-- comshit:title -->\n# Sample Person\n\nNotes\n";
  const next = primary.convertLegacyTitle(old);
  assert.equal(next, "---\ncomshit_id: x\ntags:\n  - comsift/sample\ntitle: Sample Person\n---\n\nNotes\n");
  assert.equal(primary.frontmatterTitle(next), "Sample Person");
  assert.equal(primary.frontmatterTitle(primary.withTitle(next, "Ana: B")), "Ana: B");
  assert.equal(primary.withTitle("Body", "X"), "---\ntitle: X\n---\nBody");
});

test("old callout and comment blocks move into the comsift_links property", () => {
  const legacy = "---\na: 1\n---\n> [!comsift-links]- Investigation relationships\n> [[Old]]\n\n# P\n\ntext\n\n<!-- comsift:links:start -->\n> [!comsift-links]- x\n> [[Older]]\n<!-- comsift:links:end -->\n";
  const next = graphLogic.managedLinks(legacy, ["P/x", "P/y"]);
  assert.equal(next, '---\na: 1\ncomsift_links:\n  - "[[P/x]]"\n  - "[[P/y]]"\n---\n# P\n\ntext\n');
  assert.equal(graphLogic.managedLinks(next, ["P/x", "P/y"]), next);
  assert.equal(graphLogic.managedLinks(next, []), "---\na: 1\n---\n# P\n\ntext\n");
  assert.deepEqual(graphLogic.readListProperty(next, "comsift_links"), ["[[P/x]]", "[[P/y]]"]);
});

test("Canvas embed sits at the top with a *** divider, once", () => {
  const note = "---\ntitle: S\n---\nProse\n";
  const next = primary.withCanvasEmbed(note, "S.canvas");
  assert.equal(next, "---\ntitle: S\n---\n![[S.canvas]]\n\n***\n\nProse\n");
  assert.equal(primary.withCanvasEmbed(next, "S.canvas"), next);
  assert.equal(primary.withCanvasEmbed("---\ntitle: S\n---\n![[S.canvas]]\n\nProse\n", "S.canvas"), next);
  assert.equal(primary.withCanvasEmbed(note, "S.canvas", false), "---\ntitle: S\n---\n![[S.canvas]]\n\nProse\n");
});
