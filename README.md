# comsift

Desktop Obsidian plugin for Canvas mind mapping, folder based investigations, Sherlock and Maigret, native Graph View relationships, local entity resolution, Ollama analysis, and embedded spreadsheets.

## Install

Requires Obsidian 1.8.7 or newer. Install the release assets `main.js`, `manifest.json`, and `styles.css` in `Vault/.obsidian/plugins/comsift/`, then enable the plugin. The Python analysis worker is embedded in `main.js`; no extra plugin file is needed. Spreadsheet support is bundled; `.sheet.md` files inside a user folder are mirrored automatically to hidden CSVs (`<user>/.comsift/sheets/`) that analysis and chat use, so spreadsheets and CSV files can be mixed. Disable the separate Excel community plugin to avoid duplicate view registration.

From source:

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run test:python
```

## Users and migration

Leave **People folder** blank to create people at the vault root, or set a vault-relative parent folder. Choose **New person** from the File Explorer's New menu (or run **New person** from the command palette), enter a name, and the plugin creates:

On first load after updating from the old `Comsift/Users` default, that unchanged legacy default is converted to blank. Choose `Comsift/Users` again in settings if you explicitly want to keep it. Existing person folders are not moved automatically.

```text
Alex/
  Alex.md
  Alex.canvas
  Sherlock/
  Maigret/
  Analysis/
```

The tool and analysis folders appear when used. The primary note stores the person's name in its `title` property and embeds the Canvas at the top (**Embed Canvas in note**, followed by a `***` divider). Editing `title`, or renaming the folder, primary note, or Canvas, synchronizes the other primary names. Notes from older versions with a `<!-- …:title -->` marker are converted on load. The `comsift_id` frontmatter property and plugin registry keep the investigation identity separate from its path. Arbitrary headings do not trigger renames. Canvas JSON owns node positions, dimensions, and arrows. Markdown prose is independent.

For an existing same named Markdown and Canvas pair, use the **Migrate legacy Markdown and Canvas pair** command or file menu item. Migration shows the destination before moving files and copies both originals to `Comsift/Backups/<name>-<timestamp>/` with the root setting, or `<People folder>/Backups/` when configured. It removes old `whereami` JSON sections only when their nodes and edges are confirmed in the Canvas snapshot. Unrecognized or divergent content stays in Markdown. Migration never runs on startup. If migration stops midway, use the snapshot to recover manually.

## Canvas and Graph View

Existing Canvas mind map shortcuts remain available. Sherlock and Maigret run on the selected text node. Their result groups can independently spawn above, below, left, or right of the source node; settings prevent selecting the same direction. Results are written inside the active investigation folder, with unique filenames for repeated scans. Sherlock results become file nodes in Canvas.

The primary note links to its Canvas and Markdown result notes through the managed `comsift_links` property (Graph View indexes links in properties; set *Properties in document* to *Hidden* to keep them out of sight). Older callout and comment blocks are converted. Hand-made relationships go in the `relationships` property via the **Add relationship** / **Remove relationship** commands. In Reading View the callout is hidden by plugin CSS. This uses ordinary `[[wiki links]]`, so Obsidian can index the relationships for its built in Graph View. The plugin never serializes Canvas into Markdown. Arrows between resolvable Markdown file nodes also create managed links from the source note to the target note, including across user folders. Other node types do not create files. Handwritten links outside the managed block remain untouched. Deleting an arrow removes only its generated relationship. Graph View does not encode Canvas arrow direction, labels, or styling.

The link generation and cleanup logic has automated tests. **Actual Graph View indexing, especially links to `.canvas` files and folded callouts, still needs validation in a running Obsidian vault.** Obsidian's Graph View may omit Canvas files depending on its own indexing and filters.

Comsift does not include a vault or Canvas exporter. Use an Obsidian community extension for HTML export.

## Local analysis

Open **Open analysis and chat** or use the ribbon icon. Choose a user folder, put at least two CSV datasets anywhere inside it, and choose **Splink**, **Jina**, or **Combined**. Results are saved as JSON under `Analysis/run-<timestamp>.json`. The analysis panel displays original records, candidate pairs, Splink scores and evidence, and Jina rankings independently. Nothing is merged automatically.

CSV columns can differ. The worker recognizes common aliases for username, display name, bio, platform, profile URL, website, and location. Settings accept a JSON column map, for example:

Use **Match columns** in the analysis toolbar to discover all columns and map them to shared fields without editing JSON. Columns such as `Email address` and `Contact email` can share a custom field such as `email`. Leave a field blank to ignore its column. Equal unmapped custom column names are compared automatically. The button turns red when the datasets have different effective fields; analysis remains available. Uncommon schemas appear first in the mapping dialog. With more than two datasets, mismatching fields are highlighted red; with exactly two, only the toolbar button is red.

Switch **Investigation folders** to **Any datasets in vault**, then **Choose datasets** to compare two or more CSV files or individual spreadsheet tabs from anywhere in the vault. Each source selection has durable runs and reviews under `Comsift/Comparisons/<scope>/Analysis`; confirming matches creates profile notes and graph links in that comparison scope. Returning to a selection restores its history. Folder analysis continues to use the investigation's `Analysis` directory, and switching back restores its saved results. Source and candidate labels include their dataset names.

Re-runs distinguish new candidate pairs from unchanged matches and updated evidence. **Show lower-score results** reveals candidates below the usual candidate threshold and above **Lower-score floor** (default `0.2`). Lowering that floor requires a re-run to collect more candidates. Bulk decisions apply only to loaded pairs in the current source filter and search, with at most the 300 source records shown in the list. AI picks are always reviewed before applying them.

```json
{
  "*": { "username": "handle" },
  "Comsift/Users/Alex/tiktok.csv": {
    "display_name": "nickname",
    "profile_url": "profile_link"
  }
}
```

The analysis worker requires a user managed Python environment. The plugin does not install packages or download model weights. A suggested environment is:

```bash
python3 -m venv .venv
.venv/bin/pip install 'splink>=5,<6' pyarrow transformers torch accelerate
```

Set **Python command** in plugin settings to that environment's Python executable. Splink 5 uses its DuckDB backend for probabilistic linking and trains on suitable imported datasets. Small datasets and custom tables can be compared using local field similarity without statistical training; a configured Jina model adds ranking when enabled. Configure **Jina local model path** to a downloaded `jinaai/jina-reranker-v3.5` directory containing `config.json`. The worker runs Transformers in offline mode and offers CPU or automatic device placement. The model's `trust_remote_code` requirement means you should trust the local model files you chose. Jina relevance scores are ranking signals, not calibrated identity probabilities.

To download Jina into a folder outside the vault, install the Hugging Face CLI in that Python environment, then run:

```bash
.venv/bin/pip install huggingface_hub
.venv/bin/hf download jinaai/jina-reranker-v3.5 --local-dir ~/Documents/comsift-models/jina-reranker-v3.5
```

Enter that absolute directory as **Jina local model path**. Splink has no separate model to download. For Ollama, install Ollama separately and run `ollama pull qwen3.5:9b` or `ollama pull gemma4:e4b`; set the same tag as **Model** in plugin settings.

## AI reasoning and chat

**Provider.** Choose **Ollama (local)** or **OpenAI compatible API** under *Settings → Chat*. The API option works with any `/chat/completions` endpoint (OpenAI, OpenRouter, Groq, Mistral, LM Studio, vLLM, llama.cpp server…): set the base URL (for example `https://api.openai.com/v1`), paste an API key (sent as a Bearer token, stored in this plugin's `data.json`), and pick a model. The chat view lists available models from `/api/tags` (Ollama) or `/models` (API).

Remote API keys are sent only over HTTPS. HTTP with a key is allowed only for `localhost`, `127.0.0.1`, or `::1` endpoints. Avoid syncing or sharing the plugin's `data.json` if it contains an API key.

**Keep model loaded.** Ollama requests send `keep_alive` from the setting (default `30m`), so the model is no longer unloaded right after each decision. Use `0` to unload immediately or `-1` to keep it loaded.

**Extra request parameters.** One `key=value` per line, merged into every request. Dots nest (`options.temperature=0.2`), JSON values are parsed (`stop=["###"]`), `header.Name=value` adds an HTTP header. The **?** button on the setting explains the common keys.

**Context tokens.** A slider in the chat toolbar and in settings, 1024 to 102400 in steps of 1024. Hold Shift while dragging for exact values, or type a number. It sets Ollama's `num_ctx` and how much vault text is sent.

**Decisions.** **Ask AI** sends one source record, its candidates, Splink evidence, Jina ranking, and an explicit `NO_MATCH` option with a JSON schema; the returned candidate ID is validated. **Let AI decide** (single record or all open records) and **Let Jina decide** no longer write immediately: an overview lists every decision with the picked candidate, a dropdown to pick another one (or no match), quick buttons (same person, related, uncertain, later), the model's reasoning, and one **Confirm** button. Cancelling keeps the decisions in `Analysis/decisions.json` without applying them.

**Chat** reads a limited set of text files from the selected user folder and proposes patches, new files, or rewrites as diffs that you approve and can undo. Use **+ folder** to add more folders (also used as extra datasets by the analysis). When notes in different selected folders link to each other, directly or through one shared note, those bridge notes and every note one link away from them are added to the context first. Answers cite notes as `[[Folder/Note]]` and exact lines as `[[Folder/Note#L12]]` or `[[Folder/Note#L12-L18]]`; clicking a line link opens the note with those lines selected (Ctrl/Cmd-click opens a new tab). Line numbers are sent as an `L<n>:` prefix (setting **Line numbers in context**) and stripped from edits automatically.

## Canvas arrows and AI board editing

Arrows have a type: **normal**, **same person** (labelled with the person's name, in their color), **related**, or **uncertain** (yellow by default). Set the related and uncertain arrow colors under **People and Canvas**. Right-click an arrow, or a selection of several arrows, to change the type of all of them at once; the commands *Set selected arrows to: …* do the same from the palette or a hotkey. **Alt + S** / **Alt + R** create a same-person / related child node (configurable). Graph View follows the types: same-person notes take the person's color, related and uncertain ones sit one step away. Arrows are followed through text nodes, so `file → text → file` chains connect in the graph. Sherlock and Maigret results now hang straight off the source node; older "Sherlock"/"Maigret" group nodes are removed on load.

In the analysis view, **Update Canvas arrows** puts profile notes of confirmed and related pairs on the Canvas, beside their dataset, joined by typed arrows (optionally automatic after confirming decisions). Profile notes are one per account (`handle (platform)`); duplicates from several dataset rows are merged on load.

Canvas has a sidebar chat: choose the wand beside undo/redo and help, or open **Chat about selected nodes** from the node/selection menu. The sidebar leaves the board accessible for panning and zooming. **Send** can ask a question, request a summary, or propose changes. Selection-menu chats capture the selected IDs and keep that scope across messages. Normal file chat remains separate.

Proposed changes appear automatically on the actual board as an interactive-view overlay, with dashed previous positions and dimmed original elements. Pan and zoom continue to work; previews are never saved as nodes. Switch between **Previous** and **Proposed**, accept/reject individual actions or the whole proposal, then focus the board and use native Canvas undo/redo for accepted changes. If the board changed after generation, acceptance refuses to overwrite intervening edits.

Under **Settings → Canvas chat**, keep the normal model or configure a separate Ollama/OpenAI-compatible provider, key, model, context size, prompt, and request parameters. **Canvas context assistant model** has its own profile too, including when it uses the same model with different settings. **Relevant context** can use local text relevance, the assistant model, or the existing local Jina reranker. Selectors only choose context; they cannot perform actions. **Everything** bypasses selection, and **Captured selection** cannot be widened by a selector. Large requests that exceed the configured context budget are rejected with guidance instead of silently dropping full-context content.

Jina is useful for ranking node/file text against a question, but textual relevance alone cannot decide the scope of spatial instructions such as arranging all nodes. Explicit scope takes priority. Local Jina selection uses the existing Python/model path and can add startup cost; assistant-model selection adds a model request. The default local relevance selector needs neither.

## One node per person

With **One node per person** (default on) the person's Canvas is filtered out of Graph View (a managed `-path:"…canvas"` search filter) and everything placed on the Canvas is linked from the person's note instead, so note and Canvas act as one node. **Graph click opens** chooses whether clicking that node opens the Canvas (default) or the note. Profile notes are named after the account (`handle (platform)`) and link to their source dataset, so confirmed profiles connect to the sheets on the Canvas; older `Person_dataset_row` profile notes are renamed on load.

## Graph View colors

Every person folder gets a tag (`#comsift/<name>`, prefix configurable) on its Markdown notes and a color. The **New person** dialog has a color picker with a random default; colors can be changed later under *Settings → Graph colors*. The plugin writes managed color groups to `<config folder>/graph.json` (your own groups stay first and take priority):

- the person's own notes use the person color;
- notes linked to them get shades by distance: directly related notes are slightly brighter (capped), further ones dimmer; dark colors get brighter instead of fading out (**Shade depth**, **Fade per step**);
- notes equally close to two people get a neutral color, or a mix of both (**Shared notes**);
- discovered personas — groups of two or more profile notes in `Analysis/Profiles` linked by confirmed reviews — get their own color mixed with the parent's (**Persona color mix**); single profiles keep the tag but no unique color.

**Color graph lines** tints the edges of open graph views with the same scheme (bridges neutral). This relies on undocumented Graph View internals and is best effort: if Obsidian changes them, lines simply keep their default color.

Review buttons save **Confirmed**, **Rejected**, **Uncertain**, or **Review later** to `Analysis/reviews.json`. Confirming creates profile notes for the two CSV records and a managed Markdown relationship for native Graph View. Reversing the review removes that generated relationship.

Imported CSV, biographies, and notes are treated as data, never instructions. The default Ollama URL is local. Choosing a remote Ollama URL or an API provider sends investigation context to that endpoint.

## Security and privacy

Comsift has no telemetry or automatic network requests for analytics. AI requests happen when you use analysis or chat; they send selected records, note text, filenames, Canvas context, and recent chat history to the configured provider. A separately configured context assistant receives bounded node/file excerpts to select relevant content before the Canvas model runs. Ollama defaults to a local address. Sherlock and Maigret run only when invoked and make network requests through your separately installed tools. The Python worker runs locally and reads the model directory you configure. The embedded spreadsheet view uses local vault data.

## Checks and limitations

```bash
npm run build
npm run typecheck
npm run lint
npm test
npm run test:python
```

`npm run lint` runs `eslint-plugin-obsidianmd` (the rule set used by the Obsidian plugin review) and stylelint for `!important`, duplicate properties, and browser support. The automated suite covers link generation and cleanup, cross folder Canvas edges, placement, legacy block preservation, CSV normalization, conservative Jina candidate generation, Ollama schema validation, mocked Ollama and OpenAI compatible APIs (streaming, keys, extra parameters, keep-alive), line links, the context slider, and Graph View color computation. Full Splink and Jina inference require user installed dependencies and weights, so those paths need an integration run in the target environment. Canvas interaction and Graph View indexing need a running Obsidian vault; compilation does not establish their runtime behavior.

## License

GPL 3.0 or later; see [LICENSE](LICENSE), [COPYING](COPYING), and [NOTICE](NOTICE). Embedded spreadsheet code derives from obsidian-excel (GPLv3). The Jina model has its own CC BY NC 4.0 license; it is not bundled.
