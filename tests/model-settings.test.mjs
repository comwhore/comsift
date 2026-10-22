import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const built = await build({ entryPoints: ["src/module/setting.ts"], bundle: true, platform: "node", format: "esm", write: false,
  plugins: [{ name: "obsidian-stub", setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: 'export class Modal {} export class Notice {} export class Setting {} export class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }' }));
  } }],
});
const { DEFAULT_SETTINGS, ComsiftSettingTab } = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].contents).toString("base64"));
function setup() {
  const plugin = { app: {}, node: {}, setting: structuredClone(DEFAULT_SETTINGS), saveSettings: async () => {} };
  const tab = new ComsiftSettingTab(plugin);
  tab.refresh = () => {};
  return { plugin, tab };
}

test("disabled Mermaid generator hides every profile control", () => {
  const { plugin, tab } = setup();
  const section = tab.sections().find(section => section.heading === "Mermaid diagrams");
  assert.equal(section.rows.filter(row => !row.visible || row.visible()).length, 1);
  plugin.setting.mermaidEnabled = true;
  assert.ok(section.rows.filter(row => !row.visible || row.visible()).length > 1);
});

test("all settings model selectors use live provider settings, including inherited profiles", () => {
  const { plugin, tab } = setup();
  plugin.setting.ollamaModel = "main";
  plugin.setting.ollamaUrl = "http://main:11434";
  plugin.setting.mermaidEnabled = true;
  let captured;
  tab.renderModelPicker = (_setting, read, choose) => { captured = { read, choose }; };
  const sections = tab.sections();
  const models = sections.flatMap(section => section.rows).filter(row => row.name === "Model" || row.name.endsWith(" · Model"));
  assert.equal(models.length, 7);
  for (const row of models) {
    row.render({});
    assert.equal(captured.read().ollamaModel, "main");
    assert.equal(captured.read().ollamaUrl, "http://main:11434");
  }
  const diagram = sections.find(section => section.heading === "Mermaid diagrams").rows.find(row => row.name === "Diagram model · Model");
  diagram.render({});
  captured.choose("diagram");
  assert.equal(plugin.setting.mermaidModel.inherit, false);
  assert.equal(plugin.setting.mermaidModel.ollamaModel, "diagram");
  assert.equal(plugin.setting.mermaidModel.ollamaUrl, "http://main:11434");
  assert.equal(plugin.setting.ollamaModel, "main");
});

test("an assistant can take its model from chat, the chat context assistant, or its own settings", async () => {
  const { build } = await import("esbuild");
  const built = await build({ entryPoints: ["src/analysis/modelProfiles.ts"], bundle: true, platform: "node", format: "esm", write: false });
  const m = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].contents).toString("base64"));
  const base = { ...m.DEFAULT_MODEL_PROFILE, ollamaModel: "chat-model", ollamaContext: 4096 };
  const settings = { ...base, chatContextSelectorModel: { ...m.DEFAULT_MODEL_PROFILE, inherit: false, ollamaModel: "ctx-model" },
    canvasModel: { ...m.DEFAULT_MODEL_PROFILE }, contextSelectorModel: { ...m.DEFAULT_MODEL_PROFILE }, mermaidModel: { ...m.DEFAULT_MODEL_PROFILE }, decisionModel: { ...m.DEFAULT_MODEL_PROFILE } };
  assert.equal(m.resolveCanvasSettings(settings).ollamaModel, "chat-model");
  assert.equal(m.resolveSelectorSettings(settings).ollamaModel, "chat-model");
  settings.canvasModel = { ...settings.canvasModel, inheritFrom: "chatContext" };
  assert.equal(m.resolveCanvasSettings(settings).ollamaModel, "ctx-model");
  assert.equal(m.resolveSelectorSettings(settings).ollamaModel, "ctx-model");
  settings.contextSelectorModel = { ...settings.contextSelectorModel, inheritFrom: "chat" };
  assert.equal(m.resolveSelectorSettings(settings).ollamaModel, "chat-model");
  assert.equal(m.modelSource({ inherit: false }, "mermaidModel"), "custom");
  assert.equal(m.modelSource({ inherit: true }, "contextSelectorModel"), "canvas");
});
