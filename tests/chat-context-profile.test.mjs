import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const built = await build({ entryPoints: ["src/analysis/modelProfiles.ts"], bundle: true, platform: "node", format: "esm", write: false });
const { DEFAULT_MODEL_PROFILE, resolveChatContextSettings } = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].contents).toString("base64"));

test("chat context assistant inherits chat independently of Canvas and keeps its editable prompt", () => {
  const settings = {
    ...DEFAULT_MODEL_PROFILE, ollamaModel: "main", apiKey: "main-key", ollamaMaxTokens: 5000,
    canvasModel: { ...DEFAULT_MODEL_PROFILE, inherit: false, ollamaModel: "canvas" },
    chatContextSelectorModel: { ...DEFAULT_MODEL_PROFILE, prompt: "Choose relevant evidence" },
  };
  const resolved = resolveChatContextSettings(settings);
  assert.equal(resolved.ollamaModel, "main");
  assert.equal(resolved.apiKey, "main-key");
  assert.equal(resolved.ollamaMaxTokens, 5000);
  assert.equal(resolved.prompt, "Choose relevant evidence");
  settings.chatContextSelectorModel = { ...settings.chatContextSelectorModel, inherit: false, ollamaModel: "selector", apiKey: "selector-key", ollamaMaxTokens: 2048 };
  const independent = resolveChatContextSettings(settings);
  assert.equal(independent.ollamaModel, "selector");
  assert.equal(independent.apiKey, "selector-key");
  assert.equal(independent.ollamaMaxTokens, 2048);
  assert.equal(settings.apiKey, "main-key");
  assert.equal(settings.canvasModel.ollamaModel, "canvas");
});
