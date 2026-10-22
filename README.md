# Comsift

An Obsidian plugin for researching people from public profiles. Each person gets a folder with a note and a Canvas board. You run Sherlock and Maigret from the board, compare profile exports to find accounts that belong to the same person, and ask a local or remote AI model about your notes. The AI can propose edits to notes and boards, and you approve every change.

Desktop only. Requires Obsidian 1.8.7 or newer.

## Install

1. Copy `main.js`, `manifest.json` and `styles.css` from a release into `<vault>/.obsidian/plugins/comsift/`.
2. Enable Comsift in Community plugins.
3. Install and enable [Better Embedded Canvas](https://community.obsidian.md/plugins/better-embedded-canvas) and [Advanced Canvas](https://community.obsidian.md/plugins/advanced-canvas). Comsift warns on startup if they are missing. Their current releases need Obsidian 1.13 or newer.
4. If you use the separate Excel community plugin, disable it. Comsift bundles its own spreadsheet view.

From source: `npm ci && npm run build`. Checks: `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:python`.

## People

Use **New person** (File Explorer's New menu or the command palette). It creates:

```text
Alex/
  Alex.md        note: person card, the Canvas embed, ***, then ## Notes
  Alex.canvas    the board
  Sherlock/ Maigret/ Analysis/    created when used
```

Renaming the folder, note, Canvas or the note's `title` property keeps the other names in sync. Set **People folder** in settings to put new people in a subfolder.

### Person cards

Each connection note (`Alex/Connections/…`) and each person's note shows a card: name, platform, handle, aliases, identity fields (username, user ID, profile link, website…), the people and accounts it is linked to, and its sources. In the file the card is just an empty ` ```comsift-person ``` ` block; everything it shows comes from the note's properties, so Graph View still sees every link. Write your own notes under **## Notes** below the card. Comsift never changes that part.

- **Same as…**, **Related to…** and **Uncertain…** link the note to a person or to another account. The link is saved as `comsift_same`, `comsift_related` or `comsift_uncertain` in the note's properties. The other note's card shows it too. **Remove link…** removes one.
- **Sources** shows the imported row: the header and that row's cells from the sheet or CSV. The copy button copies the matching cell embed.
- Profile pictures are not loaded unless you turn on *Settings → People and Canvas → Load profile pictures*. Without it the card shows initials.
- A person's note is laid out as: properties, the card, the Canvas embed, one `***` line (*Divider before Notes*), then **## Notes** with your text. Older people's notes are rearranged on startup (your text is kept; extra `***` lines around the card and embed are dropped) after a backup to `profile-backups/<time>-person-notes/notes.json`.
- Every account Maigret (or Sherlock) finds becomes a connection note with a card, sourced to its result note and marked **uncertain** towards the person (a candidate, not verified). An account that matches an existing connection note is added to that note instead. Results saved before this are imported once on startup; **Create profiles from Maigret results** runs it again.
- Notes in the older layout (`<!-- comsift:profile:start -->` … `end -->`) are converted once on startup. Text you wrote before or after the old block moves under **## Notes**. The original files are saved to `.obsidian/plugins/comsift/profile-backups/<time>-person-cards/notes.json` first.

### Cell embeds

Embed cells from a spreadsheet in any note: `![[Example.sheet#A1]]`, `![[Example.sheet#A1:B2]]`, `![[Example.sheet#Sheet1!A1:B2]]` (`.sheet.md` works too). Join ranges with commas to show non-adjacent rows, for example a header and one row: `![[Example.sheet#Sheet1!A1:D1,A7:D7]]`. The table updates when the sheet changes. Click its title or double-click the cells to open the sheet with those cells selected (Ctrl/Cmd-click: new tab). Links such as `[[Example.sheet#Sheet1!B4:C6]]` open the same way. A plain sheet name (`![[Example.sheet#Sheet1]]`) still embeds the whole sheet.

To convert an existing note and Canvas pair, use **Migrate legacy Markdown and Canvas pair**. It shows the destination first and backs up both files to `Comsift/Backups/`.

## Canvas

- **Alt + Shift + Enter** runs Sherlock on the selected text node, **Alt + Shift + M** runs Maigret. Both can be rebound. Results appear next to the node, in a direction you choose per tool.
- Arrows have a type: normal, same person, related or uncertain. Right-click an arrow to change its type. **Alt + S** and **Alt + R** create a same-person or related child node.
- Arrows between file nodes create `[[wiki links]]` between the notes, so Obsidian's Graph View shows the relationships. With **One node per person** on, the person's Canvas is hidden from the graph and the note stands in for it.
- Graph View colors (also in Clew). Configure under *Settings → Graph colors*:
  - **The person** — their note, their Canvas and every note verified as the same person (same-person arrows, or a `comsift_same` mark linking to the person or to one of their verified notes, followed through chains) — have exactly the person's color.
  - **Custom people**: profiles in the person's folder that are marked (or linked with same-person arrows) as the same person as each other share a color of their own, derived from the person's color. *Persona color mix* sets how close it stays. A promoted profile becomes a person with its own color.
  - **Notable profiles**: a profile with its own connections gets a third shade of the person's color (and a bigger node in Clew, up to 2.5×). Its score: +1 per person or profile linked to it by hand (marks, arrows, links), +1 per file of its own, +1 per extra friend list it appears on (one per account the lists came from; a CSV and its sheet count once), +log2(rows) for a friend list exported from it. *Notable connection threshold* (default 1) sets where it starts.
  - **Everything else in the person's folder** (single connection profiles such as friend-list rows, related or uncertain connections, Sherlock and Maigret results, analysis, sheets, chats, other notes) is the person's color slightly darker, or slightly lighter for dark colors.
  - **Notes outside** are shaded by how many links away they are. Related and uncertain arrows and marks (`comsift_related`, `comsift_uncertain`) count as one link.
- **Who a file belongs to**: a friend-list export named `<handle> <platform>.sheet.md` (or `.csv`) and Maigret/Sherlock results for `<handle>` belong to the profile with that account in the person's folder (or to another person with that name). That profile links to the file, the rows from it link to that profile, and the person's note stops linking to the file and to rows that only came from such files. Files you link to (or from) a single profile hang off that profile too. A handle that is the person's own (an alias, an account or the folder name) keeps the file the person's. Set `comsift_owner: "[[Profile]]"` in a file's properties to choose the owner yourself (point it at the person's note to keep it theirs). The first run backs up every note it changes to the plugin's `profile-backups` folder.
- Optional: [Clew](https://github.com/christian-luger-at/obsidian-clew). If it's enabled, Comsift adds the same person colors to Clew's *Color & size* groups (named `Comsift · …`). Your own Clew groups stay first, so they win. Clew's add-group button stops at 10 groups and counts these, so turn off *Settings → Graph colors → Colors in Clew* if you need to add your own. Not required.

## Compare datasets

Open the analysis panel from the ribbon icon. Put two or more CSV files (or `.sheet.md` spreadsheets) in a person's folder, or pick any files in the vault, then run **Splink**, **Jina** or **Combined**. You see candidate pairs with scores and evidence. Nothing merges automatically. Mark pairs as confirmed, related, rejected, uncertain or later. Confirming creates profile notes and links.

- **Columns** is filled in automatically from column names and sample values (profile links, emails, @handles, IDs, dates); section labels, totals and empty columns are skipped. You rarely need to open it. When you do, each column shows sample values, what it is used as, and three switches: **Identity** (same value = same person; username, user ID and profile link always count), **Match** (use it to find the same person in other datasets) and **AI** (show it to the model). A preview shows one resulting profile. Choices are remembered for datasets with the same columns, and **Copy to other datasets** applies them in bulk.
- **Ask Ollama** or **Ask AI** (named after your provider) lets the model pick a match. Nothing is saved until you confirm, and you can override its pick.

The worker needs a Python environment you manage:

```bash
python3 -m venv .venv
.venv/bin/pip install 'splink>=5,<6' pyarrow transformers torch accelerate
```

Set **Python command** in settings to `.venv/bin/python`. For Jina, download `jinaai/jina-reranker-v3.5` with `hf download` into a folder outside the vault and set **Jina local model path**. Jina scores rank candidates, they are not probabilities. Splink needs no model download.

## Chat

Choose **Ollama (local)** or **OpenAI compatible API** under *Settings → Chat model*. The API option works with any `/chat/completions` endpoint. Keys are stored in the plugin's `data.json` and sent only over HTTPS (or to localhost).

**Chat** answers questions about files in the folder you select and proposes note edits for you to approve. Type `@` to include a whole file or folder. Anything outside the selected folder is used only when you `@` it. Optional extras:

- **Context assistant**: a second model picks relevant notes and boards before each reply.
- **Mermaid diagrams**: a separate model writes diagram code when the chat model asks for one.
- **Continue in Canvas** hands the conversation to Canvas chat.

**Canvas chat** (the wand icon in the Canvas controls, or **Chat about selected nodes**) proposes board changes. They appear as a preview on the board, and you accept or reject each one.

Chat and Canvas chat each have their own model, context size, thinking and prompt settings. See [chat context and handoffs](docs/chat-context-and-handoffs.md).

## Privacy

No telemetry. The optional update checker requests the latest stable GitHub release once a day; disable Check for updates in settings to stop these requests. AI requests send the records, note text, file names and Canvas content you chose to the provider you configured, which is local Ollama by default. Sherlock and Maigret use your own installed copies and make network requests only when you run them. Analysis runs locally.

## Credits and license

Thanks to [Better Embedded Canvas](https://github.com/kotaindah55/better-embedded-canvas) and [Advanced Canvas](https://github.com/Developer-Mike/obsidian-advanced-canvas). Comsift needs both: they add the Canvas embeds and styling the AI features build on, and they make Canvas nicer to use anyway.

Optional integration: [Clew](https://github.com/christian-luger-at/obsidian-clew) by Christian Luger, a graph view with its own coloring. Comsift works without it.

GPL 3.0 or later. See [LICENSE](LICENSE), [COPYING](COPYING) and [NOTICE](NOTICE). The spreadsheet view derives from obsidian-excel (GPLv3). The Jina model is CC BY NC 4.0 and is not bundled.

Profile editing, independent column controls, connection rebuilding and main-person matching are described in [Profile and analysis controls](docs/october-22-profile-workflow.md). Folder transfer is described in [Person folders](docs/person-folder-portability.md).
