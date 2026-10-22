import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const built = await build({ entryPoints: ["src/analysis/modelDiscovery.ts"], bundle: true, platform: "node", format: "esm", write: false });
const { ModelDiscovery, modelEndpointKey } = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].contents).toString("base64"));
const settings = { aiProvider: "ollama", ollamaUrl: "http://localhost:11434", ollamaModel: "saved-not-listed", ollamaContext: 4096, ollamaTimeout: 10 };

test("discovery uses current provider endpoint and deduplicates model names", async () => {
  const seen = [];
  const discovery = new ModelDiscovery(value => { seen.push(value); return { models: async () => ["z", "a", "a", ""] }; });
  assert.deepEqual(await discovery.load(settings), { models: ["a", "z"] });
  assert.equal(seen[0].ollamaUrl, settings.ollamaUrl);
  await discovery.load({ ...settings, ollamaUrl: "http://another:11434" });
  assert.equal(seen[1].ollamaUrl, "http://another:11434");
  assert.equal(settings.ollamaModel, "saved-not-listed");
  assert.notEqual(modelEndpointKey(settings), modelEndpointKey({ ...settings, ollamaUrl: "http://another:11434" }));
});

test("late model responses cannot replace a newer provider and canceled requests disappear", async () => {
  const pending = [];
  const discovery = new ModelDiscovery(() => ({ models: signal => new Promise(resolve => pending.push({ signal, resolve })) }));
  const first = discovery.load(settings);
  const second = discovery.load({ ...settings, ollamaUrl: "http://new:11434" });
  assert.equal(pending[0].signal.aborted, true);
  pending[1].resolve(["new"]); assert.deepEqual(await second, { models: ["new"] });
  pending[0].resolve(["old"]); assert.equal(await first, null);
  const third = discovery.load(settings); discovery.cancel(); pending[2].resolve(["closed"]);
  assert.equal(await third, null);
});

test("provider failures become accessible picker errors without dropping the saved model", async () => {
  const discovery = new ModelDiscovery(() => ({ models: async () => { throw new Error("Connection refused"); } }));
  assert.deepEqual(await discovery.load(settings), { models: [], error: "Connection refused" });
  assert.equal(settings.ollamaModel, "saved-not-listed");
});
