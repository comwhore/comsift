import type { LlmSettings } from "./ollama";
import type { ComsiftSettings } from "../module/setting";

export type ModelProfile = LlmSettings & { inherit: boolean; ollamaThink: boolean; prompt: string };

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
  return profile.inherit ? { ...baseModelSettings(settings), prompt: profile.prompt } : profile;
}

export function resolveSelectorSettings(settings: ComsiftSettings): ResolvedModel {
  const profile = { ...DEFAULT_MODEL_PROFILE, ...settings.contextSelectorModel };
  return profile.inherit ? { ...resolveCanvasSettings(settings), prompt: profile.prompt } : profile;
}
