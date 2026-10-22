import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
async function load(entry) {
  const built = await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", write: false, plugins: [{ name: "obsidian-stub", setup(b) {
    b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const loadMermaid = async () => ({ parse: async source => !source.includes(\"INVALID\") });" }));
  } }] });
  return import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].contents).toString("base64"));
}
const m = await load("src/analysis/mermaid.ts");
const profiles = await load("src/analysis/modelProfiles.ts");
const plugin = { setting: { ...profiles.DEFAULT_MODEL_PROFILE, ollamaModel: "main", mermaidModel: { ...profiles.DEFAULT_MODEL_PROFILE, prompt: "Only diagrams" } } };

test("flowchart punctuation is quoted while shape, edges and existing quoted labels stay intact", () => {
  const source = 'flowchart LR\nA[Foo (detail)] --> B((Other (note)))\nC["Keep B[unchanged]"] --> D{A: B?}\nA -->|label C(raw)| B\nstyle A fill:#fff,color:#000';
  const expected = 'flowchart LR\nA["Foo (detail)"] --> B(("Other (note)"))\nC["Keep B[unchanged]"] --> D{"A: B?"}\nA -->|label C(raw)| B\nstyle A fill:#fff,color:#000';
  assert.equal(m.normalizeMermaid(source), expected);
  assert.equal(m.normalizeMermaid(expected), expected);
  assert.equal(m.normalizeMermaid('sequenceDiagram\nA->>B: Call(foo)'), 'sequenceDiagram\nA->>B: Call(foo)');
});

test("markdown normalization changes Mermaid only and strips response explanations", () => {
  const markdown = 'Text\n```js\nA[Foo (bar)]\n```\n```mermaid\nflowchart TD\nA[Foo (bar)] --> B[End]\n```\nMore';
  assert.match(m.normalizeMermaidMarkdown(markdown), /```js\nA\[Foo \(bar\)\]/);
  assert.match(m.normalizeMermaidMarkdown(markdown), /A\["Foo \(bar\)"\] --> B\["End"\]/);
  assert.equal(m.extractMermaid('Here is the diagram:\n```mermaid\nflowchart TD\nA[Foo (bar)]\n```\nExplanation'), 'flowchart TD\nA["Foo (bar)"]');
  assert.throws(() => m.extractMermaid('Here is an explanation only.'), /did not return Mermaid/);
  assert.throws(() => m.extractMermaid('flowchart TD\nA-->B\nclick A "javascript:alert(1)"'), /unsupported/);
  assert.throws(() => m.extractMermaid('%%{init: {"securityLevel":"loose"}}%%\nflowchart TD\nA-->B'), /unsupported/);
});

test("separate Mermaid generation preserves custom prompt and repairs syntax only once", async () => {
  const calls = [], checked = [];
  const source = await m.generateMermaid(plugin, "Alice knows Bob", undefined, {
    client: { async chatStream(messages) { calls.push(structuredClone(messages)); return calls.length === 1 ? "Not Mermaid" : '```mermaid\nflowchart LR\nA[Alice] --> B[Bob]\n```'; } },
    validate: async source => { checked.push(source); },
  });
  assert.equal(calls.length, 2);
  assert.ok(calls[0][0].content.startsWith("Only diagrams\n"));
  assert.equal(source, 'flowchart LR\nA["Alice"] --> B["Bob"]');
  assert.equal(checked.length, 1);
  let attempts = 0;
  await assert.rejects(m.generateMermaid(plugin, "Alice", undefined, {
    client: { async chatStream() { attempts++; return "No diagram"; } }, validate: async () => {},
  }), /could not be generated/);
  assert.equal(attempts, 2);
});

test("direct replies and proposed edits validate normalized diagrams without a generator request", async () => {
  let calls = 0;
  const markdown = '<edit action="create" path="diagram.md">\n```mermaid\nflowchart LR\nA[Name (source)] --> B[Target]\n```\n</edit>';
  const result = await m.repairMermaidMarkdown(plugin, markdown, undefined, undefined, {
    client: { async chatStream() { calls++; throw new Error("Unexpected model request"); } },
    validate: async source => { assert.match(source, /A\["Name \(source\)"\]/); },
  });
  assert.equal(calls, 0);
  assert.match(result, /<edit action="create" path="diagram.md">/);
  assert.match(result, /A\["Name \(source\)"\]/);
});

test("invalid direct diagram gets one validated repair with Canvas profile settings preserved", async () => {
  let calls = 0, validated = 0;
  const result = await m.repairMermaidMarkdown(plugin, '```mermaid\nflowchart LR\nBAD\n```', undefined, { ...plugin.setting, ollamaModel: "canvas" }, {
    client: { async chatStream(messages) { calls++; assert.match(messages[0].content, /Keep every node/); return "flowchart LR\nA[fixed] --> B[target]"; } },
    validate: async source => { validated++; if (source.includes("BAD")) throw new Error("Parse failed"); },
  });
  assert.equal(calls, 1); assert.equal(validated, 2); assert.match(result, /A\["fixed"\]/);
  const failed = await m.repairMermaidMarkdown(plugin, '```mermaid\nflowchart LR\nBAD\n```', undefined, undefined, {
    client: { async chatStream() { return 'flowchart LR\nclick A "https://unexpected.example"'; } },
    validate: async () => { throw new Error("Parse failed"); },
  });
  assert.match(failed, /^```text\nflowchart LR\nBAD\n```\n\n\*This diagram has a syntax error/);
});

test("Mermaid profile inherits chat independently and can isolate provider and output budget", () => {
  assert.equal(profiles.resolveMermaidSettings(plugin.setting).ollamaModel, "main");
  const settings = { ...plugin.setting, mermaidModel: { ...profiles.DEFAULT_MODEL_PROFILE, inherit: false, ollamaModel: "diagram", ollamaMaxTokens: 1024, aiProvider: "openai", apiKey: "diagram-key", prompt: "Custom" } };
  const resolved = profiles.resolveMermaidSettings(settings);
  assert.equal(resolved.ollamaModel, "diagram"); assert.equal(resolved.ollamaMaxTokens, 1024);
  assert.equal(resolved.apiKey, "diagram-key"); assert.equal(resolved.prompt, "Custom");
  assert.equal(plugin.setting.ollamaModel, "main");
});

test("repair that changes known labels or relationships falls back to inert source", async () => {
  const original = 'flowchart LR\nA[Alice] --> B[Bob]\nINVALID';
  const result = await m.repairMermaidMarkdown(plugin, `Prose\n\`\`\`mermaid\n${original}\n\`\`\``, undefined, undefined, {
    client: { async chatStream() { return 'flowchart LR\nA[Alice] --> B[Someone else]'; } },
    validate: async source => { if (source.includes("INVALID")) throw new Error("Invalid syntax"); },
  });
  assert.equal(result, `Prose\n\`\`\`text\n${original}\n\`\`\`\n\n*This diagram has a syntax error and could not be fixed, so it is shown as text.*`);
});

test("a diagram the chat model drew itself is dropped when the diagram tool already produced one", async () => {
  const trusted = 'flowchart LR\nA["x"] --> B["y"]';
  const out = await m.delegateMermaidMarkdown(plugin, `Intro\n\`\`\`mermaid\n${trusted}\n\`\`\`\nDraft:\n\`\`\`mermaid\ngraph TD\nZ-->Y\n\`\`\`\nEnd`, "q", [`\`\`\`mermaid\n${trusted}\n\`\`\``]);
  assert.ok(out.includes(trusted));
  assert.ok(!out.includes("Z-->Y"));
  assert.match(out, /Draft:\s*\nEnd/);
});
