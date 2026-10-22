import { createClient, type LlmClient, type LlmSettings } from "./ollama";

export function modelEndpointKey(settings: LlmSettings): string {
  return JSON.stringify([settings.aiProvider ?? "ollama", settings.aiProvider === "openai" ? settings.apiBaseUrl : settings.ollamaUrl,
    settings.apiKey ?? "", settings.apiExtraParams ?? ""]);
}

export interface DiscoveredModels { models: string[]; error?: string }

/** Abort old requests and discard late responses, including providers that ignore abort. */
export class ModelDiscovery {
  private revision = 0;
  private controller: AbortController | null = null;
  constructor(private client: (settings: LlmSettings) => Pick<LlmClient, "models"> = createClient) {}

  cancel(): void {
    this.revision++;
    this.controller?.abort();
    this.controller = null;
  }

  async load(settings: LlmSettings): Promise<DiscoveredModels | null> {
    this.cancel();
    const revision = this.revision;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const models = await this.client({ ...settings }).models(controller.signal);
      if (revision !== this.revision || controller.signal.aborted) return null;
      return { models: [...new Set(models.filter(name => typeof name === "string" && !!name.trim()))].sort((a, b) => a.localeCompare(b)) };
    } catch (error) {
      if (revision !== this.revision || controller.signal.aborted) return null;
      return { models: [], error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
}
