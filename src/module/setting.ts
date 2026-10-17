import { Modal, Notice, PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";
import ComsiftPlugin from "../main";
import { convertHotkey2Array } from "../tool";
import { DEFAULT_CHAT_PROMPT, DEFAULT_DECISION_PROMPT, DEFAULT_CANVAS_PROMPT, DEFAULT_CONTEXT_SELECTOR_PROMPT } from "../analysis/prompts";
import { parseExtraParams } from "../analysis/ollama";
import { contextSlider } from "../analysis/contextSlider";
import { DEFAULT_MODEL_PROFILE, baseModelSettings, resolveCanvasSettings, type ModelProfile } from "../analysis/modelProfiles";

export type CanvasDirection = "top" | "bottom" | "left" | "right";
export type AiProvider = "ollama" | "openai";

export interface ComsiftSettings {
  canvasModel: ModelProfile;
  contextSelectorModel: ModelProfile;
  canvasContextMode: "needed" | "everything" | "selected";
  canvasContextSelector: "local" | "model" | "jina";
  canvasContextNodes: number;
  autoFocus: boolean;
  hotkeys: Record<M.NodeActionName, string>;
  ROW_GAP: number; COLUMN_GAP: number; EPSILON: number; OFFSET_WEIGHT: number; MACRO_TASK_DELAY: number;
  sherlockCommand: string; sherlockExtraArgs: string; sherlockTimeout: number;
  sherlockIncludeNsfw: boolean; sherlockProxy: string; sherlockPosition: CanvasDirection;
  maigretCommand: string; maigretExtraArgs: string; maigretThreads: number;
  maigretProxy: string; maigretRetries: number; maigretTimeout: number; maigretPosition: CanvasDirection;
  usersFolder: string; graphDebounceMs: number;
  pythonCommand: string;
  columnMapping: string;
  analysisMode: "splink" | "jina" | "combined";
  splinkThreshold: number;
  analysisLowThreshold: number;
  autoConfirmThreshold: number;
  autoConfirmHighThreshold: number;
  jinaDecideThreshold: number;
  ollamaThink: boolean;
  ollamaMaxTokens: number;
  chatPrompt: string;
  decisionPrompt: string;
  jinaModelPath: string;
  jinaDevice: "cpu" | "auto";
  /** Which backend answers chat and decisions. */
  aiProvider: AiProvider;
  ollamaUrl: string;
  /** Model name for either provider. */
  ollamaModel: string;
  /** Context window in tokens (Ollama num_ctx; also sizes how much vault text is sent). */
  ollamaContext: number;
  ollamaTimeout: number;
  ollamaDevice: "cpu" | "auto";
  /** How long Ollama keeps the model loaded after a request ("30m", "1h", "-1" = forever). */
  ollamaKeepAlive: string;
  apiBaseUrl: string;
  apiKey: string;
  /** Line separated key=value additions to every model request. */
  apiExtraParams: string;
  /** Additional folders whose files join the chat / analysis context. */
  extraFolders: string[];
  /** Prefix context lines with L<n>: so the assistant can link to exact lines. */
  chatLineNumbers: boolean;
  graphColors: boolean;
  graphColorLinks: boolean;
  graphTagPrefix: string;
  graphDepth: number;
  graphFade: number;
  graphBridgeMode: "neutral" | "mix";
  graphBridgeColor: string;
  graphPersonaMix: number;
  /** Show a person's note and Canvas as one Graph View node (the Canvas is filtered out, its links move to the note). */
  graphMergeCanvas: boolean;
  /** What clicking a person's node in Graph View opens. */
  primaryOpens: "canvas" | "note";
  /** Embed the Canvas at the top of the person's note. */
  embedCanvas: boolean;
  /** Add a *** divider below the Canvas embed. */
  embedDivider: boolean;
  /** Canvas colors for typed arrows. */
  relatedArrowColor: string;
  uncertainArrowColor: string;
  /** Redraw Canvas arrows from reviews after decisions are applied. */
  autoCanvasArrows: boolean;
}

export const DEFAULT_SETTINGS: ComsiftSettings = {
  canvasModel: { ...DEFAULT_MODEL_PROFILE, prompt: DEFAULT_CANVAS_PROMPT },
  contextSelectorModel: { ...DEFAULT_MODEL_PROFILE, ollamaContext: 4096, ollamaMaxTokens: 1024, prompt: DEFAULT_CONTEXT_SELECTOR_PROMPT },
  canvasContextMode: "needed", canvasContextSelector: "local", canvasContextNodes: 40,
  autoFocus: false,
  hotkeys: {
    CreateChild: "Tab", CreateChildSame: "Alt + S", CreateChildRelated: "Alt + R", CreateBeforeSib: "Shift + Enter", CreateAfterSib: "Enter",
    RunSherlock: "Alt + Shift + Enter", Focus: "F", ArrowUp: "Alt + ArrowUp",
    ArrowDown: "Alt + ArrowDown", ArrowLeft: "Alt + ArrowLeft", ArrowRight: "Alt + ArrowRight",
  },
  ROW_GAP: 20, COLUMN_GAP: 200, EPSILON: 1, OFFSET_WEIGHT: 1.1, MACRO_TASK_DELAY: 50,
  sherlockCommand: "python -m sherlock", sherlockExtraArgs: "", sherlockTimeout: 60,
  sherlockIncludeNsfw: true, sherlockProxy: "", sherlockPosition: "right",
  maigretCommand: "maigret", maigretExtraArgs: "", maigretThreads: 100,
  maigretProxy: "", maigretRetries: 1, maigretTimeout: 30, maigretPosition: "left",
  usersFolder: "", graphDebounceMs: 500,
  pythonCommand: "python3", columnMapping: "{}", analysisMode: "combined",
  splinkThreshold: 0.5, analysisLowThreshold: 0.2, autoConfirmThreshold: 0.7, autoConfirmHighThreshold: 0.98, jinaDecideThreshold: 0.75, ollamaThink: false, ollamaMaxTokens: -1,
  chatPrompt: DEFAULT_CHAT_PROMPT, decisionPrompt: DEFAULT_DECISION_PROMPT, jinaModelPath: "", jinaDevice: "cpu",
  aiProvider: "ollama",
  ollamaUrl: "http://127.0.0.1:11434", ollamaModel: "",
  ollamaContext: 8192, ollamaTimeout: 120,
  ollamaDevice: "auto",
  ollamaKeepAlive: "30m",
  apiBaseUrl: "https://api.openai.com/v1",
  apiKey: "",
  apiExtraParams: "",
  extraFolders: [],
  chatLineNumbers: true,
  graphColors: true,
  graphColorLinks: true,
  graphTagPrefix: "comsift",
  graphDepth: 3,
  graphFade: 0.22,
  graphBridgeMode: "neutral",
  graphBridgeColor: "#8a8f98",
  graphPersonaMix: 0.5,
  graphMergeCanvas: true,
  primaryOpens: "canvas",
  embedCanvas: true,
  embedDivider: true,
  relatedArrowColor: "#008f0a",
  uncertainArrowColor: "#e3b341",
  autoCanvasArrows: false,
};

const EXTRA_PARAMS_HELP = [
  ["Format", "One key=value per line. Lines starting with # are ignored."],
  ["Values", "JSON is parsed when it can be: numbers (top_k=40), booleans (think=true), arrays (stop=[\"###\"]) and objects. Anything else is sent as text."],
  ["Nesting", "Dots create nested objects: options.temperature=0.2 becomes { \"options\": { \"temperature\": 0.2 } }."],
  ["Headers", "header.Name=value adds an HTTP header, e.g. header.HTTP-Referer=https://example.com for OpenRouter."],
  ["Ollama", "Sampling goes under options.*: options.temperature, options.top_p, options.top_k, options.repeat_penalty, options.seed, options.num_thread. keep_alive overrides the keep-alive setting."],
  ["API (OpenAI compatible)", "Top-level keys: temperature, top_p, presence_penalty, frequency_penalty, seed, max_tokens, reasoning_effort (low/medium/high), user."],
  ["Precedence", "These values are merged last, so they override what the plugin would send. model, messages and stream are best left alone."],
] as const;

class ParamsHelpModal extends Modal {
  onOpen() {
    this.setTitle("Extra request parameters");
    const list = this.contentEl.createEl("dl", { cls: "comsift-help-list" });
    for (const [term, text] of EXTRA_PARAMS_HELP) {
      list.createEl("dt", { text: term });
      list.createEl("dd", { text });
    }
    this.contentEl.createEl("pre", { cls: "comsift-help-example",
      text: "# Example\noptions.temperature=0.3\noptions.top_k=40\nseed=7\nheader.X-Title=comsift" });
  }
  onClose() { this.contentEl.empty(); }
}

interface Row { name: string; desc?: string; render: (setting: Setting) => void; visible?: () => boolean }
interface Section { heading?: string; rows: Row[] }

type TextKey = "usersFolder" | "sherlockCommand" | "sherlockExtraArgs" | "sherlockProxy" | "maigretCommand" |
  "maigretExtraArgs" | "maigretProxy" | "pythonCommand" | "columnMapping" | "jinaModelPath" | "ollamaUrl" |
  "ollamaModel" | "ollamaKeepAlive" | "apiBaseUrl" | "graphTagPrefix";
type NumberKey = "graphDebounceMs" | "sherlockTimeout" | "maigretThreads" | "maigretRetries" | "maigretTimeout" |
  "splinkThreshold" | "analysisLowThreshold" | "autoConfirmHighThreshold" | "ollamaTimeout" | "ollamaMaxTokens" | "graphDepth" | "graphFade" | "graphPersonaMix";
type ToggleKey = "autoFocus" | "sherlockIncludeNsfw" | "chatLineNumbers" | "graphColors" | "graphColorLinks" | "graphMergeCanvas" | "embedCanvas" | "embedDivider" | "autoCanvasArrows";

export class ComsiftSettingTab extends PluginSettingTab {
  private cleanups: Array<() => void> = [];

  constructor(private plugin: ComsiftPlugin) { super(plugin.app, plugin); }

  /** Declarative definitions (Obsidian 1.13+): searchable in the settings modal. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return this.sections().map(section => ({
      type: "group" as const,
      heading: section.heading,
      items: section.rows.map(row => ({
        name: row.name, desc: row.desc, visible: row.visible,
        render: (setting: Setting) => { row.render(setting); },
      })),
    }));
  }

  /** Fallback renderer for Obsidian versions before 1.13. */
  display() { this.renderLegacy(); }

  hide() {
    this.cleanups.splice(0).forEach(cleanup => cleanup());
  }

  private renderLegacy() {
    this.cleanups.splice(0).forEach(cleanup => cleanup());
    const { containerEl } = this;
    containerEl.empty();
    for (const section of this.sections()) {
      if (section.heading) new Setting(containerEl).setName(section.heading).setHeading();
      for (const row of section.rows) {
        if (row.visible && !row.visible()) continue;
        const setting = new Setting(containerEl).setName(row.name);
        if (row.desc) setting.setDesc(row.desc);
        row.render(setting);
      }
    }
  }

  /** Re-render after a change that affects which rows are shown. */
  private refresh() {
    const declarative = (this as unknown as { update?: () => void }).update;
    if (typeof declarative === "function" && this.getSettingDefinitions().length) declarative.call(this);
    else this.renderLegacy();
  }

  private save() { return this.plugin.saveSettings(); }

  private sections(): Section[] {
    const node = this.plugin.node;
    const isApi = () => this.plugin.setting.aiProvider === "openai";
    return [
      { rows: [
        this.toggle("Auto focus", "Focus the cursor on new Canvas nodes.", "autoFocus"),
        this.hotkey("Create child node", "CreateChild", () => node.createChildren()),
        this.hotkey("Create same-person child", "CreateChildSame", () => node.createSameChild()),
        this.hotkey("Create related child", "CreateChildRelated", () => node.createRelatedChild()),
        this.hotkey("Create sibling before", "CreateBeforeSib", () => node.createBeforeSibNode()),
        this.hotkey("Create sibling after", "CreateAfterSib", () => node.createAfterSibNode()),
        this.hotkey("Run Sherlock", "RunSherlock", () => this.plugin.runSherlockFromSelection()),
      ] },
      { heading: "People and Canvas", rows: [
        this.text("People folder", "Leave blank for the vault root; otherwise enter a vault-relative parent folder for new people and migrations.", "usersFolder"),
        this.number("Graph debounce (ms)", "Delay before Canvas edge links update.", "graphDebounceMs"),
        this.toggle("One node per person", "Show each person's note and Canvas as a single Graph View node: the Canvas is filtered out of the graph and everything on it links from the note.", "graphMergeCanvas",
          () => { void this.plugin.graph.syncAllNow(); }),
        this.choice("Graph click opens", "What opens when you click a person's node in Graph View.", "primaryOpens", [["canvas", "Canvas"], ["note", "Note"]]),
        this.toggle("Embed Canvas in note", "Show the person's Canvas at the top of their note, below the relationships.", "embedCanvas",
          () => { void this.plugin.investigations.normalizePrimaries(); }),
        this.toggle("Divider under embed", "Add a *** line below the embedded Canvas.", "embedDivider",
          () => { void this.plugin.investigations.normalizePrimaries(); }),
        this.color("Related arrow color", "Canvas color for arrows marked related.", "relatedArrowColor"),
        this.color("Uncertain arrow color", "Canvas color for arrows marked uncertain.", "uncertainArrowColor"),
      ] },
      { heading: "Graph colors", rows: [
        this.toggle("Color people in Graph View", "Each person folder gets a tag and a color group in Graph View; linked notes get shades of that color by distance.", "graphColors", () => this.plugin.graphColors?.schedule()),
        this.toggle("Color graph lines", "Tint the lines of open graph views with the color of the person they belong to (best effort; uses Graph View internals).", "graphColorLinks", () => this.plugin.graphColors?.schedule()),
        this.text("Tag prefix", "Person tags look like #prefix/name.", "graphTagPrefix", () => this.plugin.graphColors?.schedule()),
        this.number("Shade depth", "How many links away from a person notes are still shaded (1 to 6).", "graphDepth", () => this.plugin.graphColors?.schedule()),
        this.number("Fade per step", "How much dimmer each further link gets (0.05 to 0.5). Dark colors get brighter instead.", "graphFade", () => this.plugin.graphColors?.schedule()),
        this.choice("Shared notes", "Notes equally close to two people.", "graphBridgeMode",
          [["neutral", "Neutral color"], ["mix", "Mix both colors"]], () => this.plugin.graphColors?.schedule()),
        this.color("Neutral color", "Used for notes connecting two people when shared notes are neutral.", "graphBridgeColor",
          () => this.plugin.graphColors?.schedule()),
        this.number("Persona color mix", "How much of the parent person's color a discovered persona keeps (0 to 1).", "graphPersonaMix", () => this.plugin.graphColors?.schedule()),
        { name: "Person colors", desc: "Pick a color for each person. New people get a random color.", render: setting => this.renderPersonColors(setting) },
        { name: "Apply now", desc: "Rewrite the color groups and tags immediately.", render: setting => {
          setting.addButton(button => button.setButtonText("Apply").onClick(() => { void this.plugin.graphColors?.apply(true); }));
        } },
      ] },
      { heading: "Sherlock", rows: [
        this.text("Command", "Executable and arguments, e.g. python -m sherlock.", "sherlockCommand"),
        this.text("Extra arguments", "Additional Sherlock arguments.", "sherlockExtraArgs"),
        this.text("Proxy", "Optional proxy URL.", "sherlockProxy"),
        this.number("Timeout (seconds)", "Per-request timeout.", "sherlockTimeout"),
        this.toggle("Include NSFW sites", "Include default NSFW site list.", "sherlockIncludeNsfw"),
        this.direction("Canvas position", "Place Sherlock results relative to the source node.", "sherlockPosition", "maigretPosition"),
      ] },
      { heading: "Maigret", rows: [
        this.text("Command", "Executable and arguments, e.g. maigret.", "maigretCommand"),
        this.text("Extra arguments", "Additional Maigret arguments.", "maigretExtraArgs"),
        this.text("Proxy", "Optional proxy URL.", "maigretProxy"),
        this.number("Connections", "Maximum concurrent connections.", "maigretThreads"),
        this.number("Retries", "Retry count.", "maigretRetries"),
        this.number("Timeout (seconds)", "Per-request timeout.", "maigretTimeout"),
        this.direction("Canvas position", "Place Maigret results relative to the source node.", "maigretPosition", "sherlockPosition"),
      ] },
      { heading: "Data analysis", rows: [
        this.text("Python command", "Python environment containing optional Splink and Jina dependencies.", "pythonCommand"),
        this.text("Column mapping", "JSON: dataset name (or *) → canonical field → CSV column.", "columnMapping"),
        this.toggle("Update Canvas arrows after decisions", "After confirming decisions, add same-person and related arrows between profile nodes on the person's Canvas.", "autoCanvasArrows"),
        this.choice("Default mode", "Run engines independently or together.", "analysisMode",
          [["splink", "Splink only"], ["jina", "Jina only"], ["combined", "Combined"]]),
        this.number("Auto-confirm threshold", "Automatically confirm new undecided matches at this score or above; 0 disables it. Default 0.98.", "autoConfirmHighThreshold"),
        this.prompt("Decision system prompt", "Instructions used when the model reasons about candidates (Ask AI / Let AI decide).", "decisionPrompt", DEFAULT_DECISION_PROMPT),
      ] },
      { heading: "Splink", rows: [
        this.number("Low candidate floor", "Retain weaker similarities for optional review (0–1).", "analysisLowThreshold"),
        this.number("Candidate threshold", "Minimum Splink match probability for review; dataset specific, not universal confidence.", "splinkThreshold"),
      ] },
      { heading: "Jina", rows: [
        this.text("Local model path", "Directory you downloaded containing jina-reranker-v3.5.", "jinaModelPath"),
        this.choice("Device", "CPU avoids occupying GPU memory.", "jinaDevice", [["cpu", "CPU"], ["auto", "Automatic"]]),
      ] },
      { heading: "Chat", rows: [
        this.choice("Provider", "Local Ollama, or any OpenAI compatible API with a key (OpenAI, OpenRouter, Groq, Mistral, LM Studio, vLLM…).", "aiProvider",
          [["ollama", "Ollama (local)"], ["openai", "OpenAI compatible API"]], () => this.refresh()),
        { ...this.text("Ollama URL", "Local Ollama server by default.", "ollamaUrl"), visible: () => !isApi() },
        { ...this.text("API base URL", "Ends before /chat/completions, e.g. https://api.openai.com/v1 or https://openrouter.ai/api/v1.", "apiBaseUrl"), visible: isApi },
        { name: "API key", desc: "Sent as a Bearer token. Stored in this plugin's data.json inside your vault; leave empty for local servers that need none.", visible: isApi,
          render: setting => void setting.addText(input => {
            input.inputEl.type = "password";
            input.setPlaceholder("Paste your key").setValue(this.plugin.setting.apiKey).onChange(value => { void (async () => {
              this.plugin.setting.apiKey = value.trim();
              await this.save();
            })(); });
          }) },
        this.text("Model", "Model name, e.g. qwen3.5:9b for Ollama or gpt-4.1-mini for an API. The chat view lists available models.", "ollamaModel"),
        { name: "Context tokens", desc: "Context window. Steps by 1024; hold Shift while dragging for exact values or type one.", render: setting => {
          setting.controlEl.addClass("comsift-context-control");
          contextSlider(setting.controlEl, this.plugin.setting.ollamaContext, value => {
            this.plugin.setting.ollamaContext = value;
            void this.save();
          }, cleanup => this.cleanups.push(cleanup));
        } },
        { ...this.text("Keep model loaded", "Ollama keep_alive after each request: 30m, 2h, 0 to unload immediately, -1 to keep it loaded.", "ollamaKeepAlive"), visible: () => !isApi() },
        this.number("Timeout (seconds)", "Maximum wait for a model response.", "ollamaTimeout"),
        this.number("Max output tokens", "-1 = no limit. Ollama: num_predict; API: max_tokens. Raise the context instead of lowering this if answers get cut off.", "ollamaMaxTokens"),
        { ...this.choice("Device", "CPU forces zero GPU layers; automatic lets Ollama choose.", "ollamaDevice",
          [["auto", "Automatic"], ["cpu", "CPU"]]), visible: () => !isApi() },
        { name: "Extra request parameters", desc: "Merged into every request. Use the info button for the format.", render: setting => this.renderExtraParams(setting) },
        this.toggle("Line numbers in context", "Lets the assistant link to exact lines ([[note#L12]]). Costs a few extra tokens per line.", "chatLineNumbers"),
        this.prompt("Chat system prompt", "Instructions for the folder chat. {folder} is replaced with the selected folders. The edit-tag rules at the end are what lets the assistant propose file changes; keep them if you want edits.",
          "chatPrompt", DEFAULT_CHAT_PROMPT),
      ] },
      { heading: "Canvas chat", rows: [
        ...this.modelProfileSection("canvasModel", "Action model", "Use the normal chat model and settings").rows,
        { name: "Default context", desc: "Selected nodes stay captured when opening chat from their menu.", render: setting => {
          setting.addDropdown(input => input.addOption("needed", "Relevant context").addOption("everything", "Everything").addOption("selected", "Selected nodes")
            .setValue(this.plugin.setting.canvasContextMode).onChange(value => {
              this.plugin.setting.canvasContextMode = value as ComsiftSettings["canvasContextMode"]; void this.save();
            }));
        } },
        { name: "Context selector", desc: "Local relevance is fast. An assistant model can reason about relevance; Jina ranks node text locally. Explicit selection and Everything bypass selection.", render: setting => {
          setting.addDropdown(input => input.addOption("local", "Local relevance").addOption("model", "Assistant model").addOption("jina", "Jina (local)")
            .setValue(this.plugin.setting.canvasContextSelector).onChange(value => {
              this.plugin.setting.canvasContextSelector = value as ComsiftSettings["canvasContextSelector"]; void this.save();
            }));
        } },
        { name: "Relevant node budget", desc: "Target number of nodes for relevant context (1–200). Captured selected nodes always remain available.", render: setting => {
          setting.addText(input => input.setValue(String(this.plugin.setting.canvasContextNodes)).onChange(value => {
            const count = Number(value); if (!Number.isInteger(count) || count < 1 || count > 200) return;
            this.plugin.setting.canvasContextNodes = count; void this.save();
          }));
        } },
        ...this.modelProfileSection("contextSelectorModel", "Context assistant", "Use the Canvas chat model and settings").rows,
      ] },
    ];
  }

  private modelProfileSection(key: "canvasModel" | "contextSelectorModel", heading: string, inheritLabel: string): Section {
    const defaultPrompt = key === "canvasModel" ? DEFAULT_CANVAS_PROMPT : DEFAULT_CONTEXT_SELECTOR_PROMPT;
    const read = (): ModelProfile => ({ ...DEFAULT_MODEL_PROFILE, ...this.plugin.setting[key] });
    const independent = () => !read().inherit;
    const update = (patch: Partial<ModelProfile>, refresh = false) => {
      this.plugin.setting[key] = { ...read(), ...patch };
      void this.save().then(() => { if (refresh) this.refresh(); });
    };
    const text = (name: string, field: "ollamaUrl" | "ollamaModel" | "apiBaseUrl" | "apiKey" | "ollamaKeepAlive", desc?: string): Row => ({
      name, desc, visible: independent, render: setting => {
        setting.addText(input => {
          if (field === "apiKey") input.inputEl.type = "password";
          input.setValue(read()[field] ?? "").onChange(value => update({ [field]: value.trim() }));
        });
      },
    });
    const numeric = (name: string, field: "ollamaContext" | "ollamaTimeout" | "ollamaMaxTokens", minimum: number): Row => ({
      name, visible: independent, render: setting => {
        setting.addText(input => input.setValue(String(read()[field] ?? -1)).onChange(value => {
          const number = Number(value); if (Number.isInteger(number) && number >= minimum) update({ [field]: number });
        }));
      },
    });
    const rows: Row[] = [
      { name: inheritLabel, desc: "Turn off to use a separate provider, model, context size, prompt, and request parameters. Current values are copied when you turn it off.", render: setting => {
        setting.addToggle(input => input.setValue(read().inherit).onChange(value => {
          if (value) update({ inherit: true }, true);
          else update({ ...baseModelSettings(key === "canvasModel" ? this.plugin.setting : resolveCanvasSettings(this.plugin.setting)), inherit: false, prompt: read().prompt }, true);
        }));
      } },
      { name: "Provider", visible: independent, render: setting => {
        setting.addDropdown(input => input.addOption("ollama", "Ollama (local)").addOption("openai", "OpenAI compatible API")
          .setValue(read().aiProvider ?? "ollama").onChange(value => update({ aiProvider: value as AiProvider }, true)));
      } },
      { ...text("Ollama URL", "ollamaUrl"), visible: () => independent() && read().aiProvider !== "openai" },
      { ...text("API base URL", "apiBaseUrl"), visible: () => independent() && read().aiProvider === "openai" },
      { ...text("API key", "apiKey", "Stored in plugin data.json. Remote credentials require HTTPS."), visible: () => independent() && read().aiProvider === "openai" },
      text("Model", "ollamaModel", "May be the same model as normal chat while using different settings."),
      numeric("Context tokens", "ollamaContext", 1024),
      numeric("Timeout (seconds)", "ollamaTimeout", 1),
      numeric("Max output tokens", "ollamaMaxTokens", -1),
      text("Keep model loaded", "ollamaKeepAlive"),
      { name: "Think", visible: independent, render: setting => {
        setting.addToggle(input => input.setValue(read().ollamaThink).onChange(value => update({ ollamaThink: value })));
      } },
      { name: "Device", visible: independent, render: setting => {
        setting.addDropdown(input => input.addOption("auto", "Automatic").addOption("cpu", "CPU")
          .setValue(read().ollamaDevice ?? "auto").onChange(value => update({ ollamaDevice: value as "auto" | "cpu" })));
      } },
      { name: "Extra request parameters", desc: "Independent key=value parameters and header.Name=value headers for this model.", visible: independent, render: setting => {
        setting.addTextArea(input => input.setValue(read().apiExtraParams ?? "").onChange(value => {
          try { parseExtraParams(value); update({ apiExtraParams: value }); } catch (error) { new Notice((error as Error).message); }
        }));
      } },
      { name: "System prompt", desc: "Independent instructions for this model. Restore the default with the reset button.", render: setting => {
        let area: HTMLTextAreaElement | null = null;
        setting.settingEl.addClass("comsift-prompt-setting");
        setting.addTextArea(input => {
          area = input.inputEl;
          input.inputEl.rows = 10;
          input.inputEl.addClass("comsift-prompt-input");
          input.setValue(read().prompt).onChange(value => update({ prompt: value }));
        });
        setting.addExtraButton(button => button.setIcon("rotate-ccw").setTooltip("Restore the original prompt").onClick(() => {
          update({ prompt: defaultPrompt });
          if (area) area.value = defaultPrompt;
          new Notice("Prompt restored to the default.");
        }));
      } },
    ];
    return { heading, rows: rows.map(row => ({ ...row, name: `${heading} · ${row.name}` })) };
  }

  private renderExtraParams(setting: Setting) {
    setting.settingEl.addClass("comsift-params-setting");
    const info = setting.settingEl.createEl("button", { cls: "clickable-icon comsift-params-info",
      attr: { type: "button", "aria-label": "How extra request parameters work" } });
    info.setText("?");
    info.onclick = () => new ParamsHelpModal(this.app).open();
    const error = setting.descEl.createDiv({ cls: "comsift-params-error" });
    setting.addTextArea(input => {
      input.setPlaceholder("options.temperature=0.3\nseed=7").setValue(this.plugin.setting.apiExtraParams);
      input.inputEl.rows = 6;
      input.inputEl.addClass("comsift-params-input");
      input.onChange(value => { void (async () => {
        try { parseExtraParams(value); error.setText(""); }
        catch (problem) { error.setText((problem as Error).message); return; }
        this.plugin.setting.apiExtraParams = value;
        await this.save();
      })(); });
    });
  }

  private renderPersonColors(setting: Setting) {
    const list = setting.controlEl.createDiv({ cls: "comsift-person-colors" });
    const people = Object.values(this.plugin.state.investigations);
    if (!people.length) list.createSpan({ cls: "setting-item-description", text: "No people yet." });
    for (const item of people) {
      const row = list.createDiv({ cls: "comsift-person-color" });
      const picker = row.createEl("input", { type: "color", attr: { "aria-label": `Color for ${item.folderPath}` } });
      picker.value = this.plugin.graphColors?.colorOf(item) ?? "#7f6df2";
      row.createSpan({ text: item.folderPath.split("/").at(-1) ?? item.folderPath });
      picker.onchange = () => {
        item.color = picker.value;
        void this.plugin.saveState().then(() => this.plugin.graphColors?.schedule());
      };
    }
  }

  private prompt(name: string, desc: string, key: "chatPrompt" | "decisionPrompt", fallback: string): Row {
    return { name, desc, render: setting => {
      setting.settingEl.addClass("comsift-prompt-setting");
      let area: HTMLTextAreaElement | null = null;
      setting.addTextArea(input => {
        area = input.inputEl;
        input.setValue(this.plugin.setting[key]).onChange(value => { void (async () => {
          this.plugin.setting[key] = value;
          await this.save();
        })(); });
        input.inputEl.rows = 10;
        input.inputEl.addClass("comsift-prompt-input");
      });
      setting.addExtraButton(button => button.setIcon("rotate-ccw").setTooltip("Restore the original prompt").onClick(() => { void (async () => {
        this.plugin.setting[key] = fallback;
        if (area) area.value = fallback;
        await this.save();
        new Notice("Prompt restored to the default.");
      })(); }));
    } };
  }

  private direction(name: string, desc: string, key: "sherlockPosition" | "maigretPosition", other: "sherlockPosition" | "maigretPosition"): Row {
    return { name, desc, render: setting => void setting.addDropdown(dropdown => {
      for (const direction of ["top", "bottom", "left", "right"] as CanvasDirection[]) {
        if (direction !== this.plugin.setting[other] || direction === this.plugin.setting[key]) dropdown.addOption(direction, direction[0].toUpperCase() + direction.slice(1));
      }
      dropdown.setValue(this.plugin.setting[key]).onChange(value => { void (async () => {
        this.plugin.setting[key] = value as CanvasDirection;
        await this.save();
        this.refresh();
      })(); });
    }) };
  }

  private toggle(name: string, desc: string, key: ToggleKey, after?: () => void): Row {
    return { name, desc, render: setting => void setting.addToggle(toggle =>
      toggle.setValue(this.plugin.setting[key]).onChange(value => { void (async () => {
        this.plugin.setting[key] = value;
        await this.save();
        after?.();
      })(); })) };
  }

  private text(name: string, desc: string, key: TextKey, after?: () => void): Row {
    return { name, desc, render: setting => void setting.addText(input =>
      input.setValue(this.plugin.setting[key]).onChange(value => { void (async () => {
        this.plugin.setting[key] = value.trim();
        await this.save();
        after?.();
      })(); })) };
  }

  private color(name: string, desc: string, key: "graphBridgeColor" | "relatedArrowColor" | "uncertainArrowColor", after?: () => void): Row {
    return { name, desc, render: setting => void setting.addColorPicker(picker =>
      picker.setValue(this.plugin.setting[key]).onChange(value => { void (async () => {
        this.plugin.setting[key] = value;
        await this.save();
        after?.();
      })(); })) };
  }

  private number(name: string, desc: string, key: NumberKey, after?: () => void): Row {
    return { name, desc, render: setting => void setting.addText(input =>
      input.setValue(String(this.plugin.setting[key])).onChange(value => { void (async () => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < (key === "ollamaMaxTokens" ? -1 : 0)) return;
        this.plugin.setting[key] = parsed;
        await this.save();
        after?.();
      })(); })) };
  }

  private choice<K extends "analysisMode" | "jinaDevice" | "ollamaDevice" | "aiProvider" | "graphBridgeMode" | "primaryOpens">(
    name: string, desc: string, key: K, options: Array<[ComsiftSettings[K], string]>, after?: () => void): Row {
    return { name, desc, render: setting => void setting.addDropdown(dropdown => {
      for (const [value, label] of options) dropdown.addOption(value, label);
      dropdown.setValue(this.plugin.setting[key]).onChange(value => { void (async () => {
        this.plugin.setting[key] = value as ComsiftSettings[K];
        await this.save();
        after?.();
      })(); });
    }) };
  }

  private hotkey(title: string, key: M.NodeActionName, callback: () => void): Row {
    return { name: title, desc: "Enter, Tab, Ctrl + K, Alt + ArrowRight.", render: setting => {
      let next = this.plugin.setting.hotkeys[key];
      setting
        .addText(input => input.setValue(next).onChange(value => { next = value; }))
        .addButton(button => button.setButtonText("Save").onClick(() => { void (async () => {
          try {
            const [modifier, hotkey] = convertHotkey2Array(next);
            this.plugin.setting.hotkeys[key] = next;
            await this.save();
            this.plugin.keymap.unregisterAll();
            this.plugin.keymap.registerAll({ [key]: () => this.plugin.keymap.register(modifier, hotkey, callback) });
            new Notice("Saved hotkey.");
          } catch (error) { new Notice((error as Error).message); }
        })(); }));
    } };
  }
}
