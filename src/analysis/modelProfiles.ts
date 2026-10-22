import type { LlmSettings } from "./ollama";
import type { ComsiftSettings } from "../module/setting";

export type InheritSource = "chat" | "chatContext" | "canvas";
export type ModelSource = InheritSource | "custom";
export type ModelProfile = LlmSettings & { inherit: boolean; inheritFrom?: InheritSource; ollamaThink: boolean; prompt: string };

/** What an assistant uses when it has no model of its own. The Canvas context assistant follows the Canvas model by default. */
const DEFAULT_SOURCE: Record<string, InheritSource> = { contextSelectorModel: "canvas" };
export function modelSource(profile: Pick<ModelProfile, "inherit" | "inheritFrom">, key: string): ModelSource {
  return profile.inherit ? profile.inheritFrom ?? DEFAULT_SOURCE[key] ?? "chat" : "custom";
}
export function parentSettings(settings: ComsiftSettings, from: InheritSource): ResolvedModel {
  if (from === "chatContext") return resolveChatContextSettings(settings);
  if (from === "canvas") return resolveCanvasSettings(settings);
  return baseModelSettings(settings);
}

export const DEFAULT_MODEL_PROFILE: ModelProfile = {
  inherit: true, aiProvider: "ollama", ollamaUrl: "http://127.0.0.1:11434", ollamaModel: "",
  ollamaContext: 8192, ollamaTimeout: 120, ollamaDevice: "auto", ollamaKeepAlive: "30m", ollamaMaxTokens: -1,
  apiBaseUrl: "https://api.openai.com/v1", apiKey: "", apiExtraParams: "", ollamaThink: false, prompt: "",
};

export type ResolvedModel = LlmSettings & { ollamaThink: boolean; prompt: string };

export function baseModelSettings(settings: LlmSettings & { ollamaThink?: boolean }): ResolvedModel {
  return {
    aiProvider: settings.aiProvider, ollamaUrl: settings.ollamaUrl, ollamaModel: settings.ollamaModel,
    ollamaContext: settings.ollamaContext, ollamaTimeout: settings.ollamaTimeout, ollamaDevice: settings.ollamaDevice,
    ollamaKeepAlive: settings.ollamaKeepAlive, ollamaMaxTokens: settings.ollamaMaxTokens,
    apiBaseUrl: settings.apiBaseUrl, apiKey: settings.apiKey, apiExtraParams: settings.apiExtraParams,
    ollamaThink: settings.ollamaThink ?? false, prompt: "",
  };
}

export function resolveCanvasSettings(settings: ComsiftSettings): ResolvedModel {
  const profile = { ...DEFAULT_MODEL_PROFILE, ...settings.canvasModel };
  const resolved = profile.inherit ? { ...parentSettings(settings, modelSource(profile, "canvasModel") as InheritSource), prompt: profile.prompt } : profile;
  return { ...resolved, ollamaThink: profile.ollamaThink };
}

export function resolveSelectorSettings(settings: ComsiftSettings): ResolvedModel {
  const profile = { ...DEFAULT_MODEL_PROFILE, ...settings.contextSelectorModel };
  const resolved = profile.inherit ? { ...parentSettings(settings, modelSource(profile, "contextSelectorModel") as InheritSource), prompt: profile.prompt } : profile;
  return { ...resolved, ollamaThink: profile.ollamaThink };
}

/** Decision analysis inherits Chat independently of the Canvas action model. */
export function resolveDecisionSettings(settings: ComsiftSettings): ResolvedModel {
  const profile = { ...DEFAULT_MODEL_PROFILE, ...settings.decisionModel };
  const resolved = profile.inherit ? { ...parentSettings(settings, modelSource(profile, "decisionModel") as InheritSource), prompt: profile.prompt } : profile;
  return { ...resolved, ollamaThink: profile.ollamaThink, decisionPrompt: profile.prompt || settings.decisionPrompt, decisionIgnoredFields: settings.decisionIgnoredFields };
}

/** Normal chat context collection inherits the chat provider and model. */
export function resolveChatContextSettings(settings: ComsiftSettings): ResolvedModel {
  const profile = { ...DEFAULT_MODEL_PROFILE, ...settings.chatContextSelectorModel };
  return profile.inherit ? { ...baseModelSettings(settings), prompt: profile.prompt } : profile;
}

export function resolveMermaidSettings(settings: ComsiftSettings): ResolvedModel {
  const profile = { ...DEFAULT_MODEL_PROFILE, ...settings.mermaidModel };
  // A diagram model that was switched on but never chosen falls back to the chat model instead of failing silently.
  return profile.inherit || !profile.ollamaModel.trim() ? { ...parentSettings(settings, modelSource({ inherit: true, inheritFrom: profile.inheritFrom }, "mermaidModel") as InheritSource), prompt: profile.prompt } : profile;
}
