import { Modal, Notice, Setting, setIcon, setTooltip } from "obsidian";
import type ComsiftPlugin from "../main";
import {
  ROLE_LABELS, IDENTITY_ROLES, choiceField, choicesToMapping, columnConflicts, copyChoices, datasetLabel, detectColumn,
  fieldName, findLayout, hasIdentity, isProfileDataset, layoutKey, parseMappings, previewProfile, resolveColumns,
  savedMappingFor, type ColumnChoice, type DatasetColumns,
} from "./columnMapping";

/** Icon columns: what each switch does, shown as a tooltip and read by screen readers. */
const FLAG_COLUMNS: Array<[string, string, string]> = [
  ["user", "Identity", "Identity: the same value means the same account. Use this to identify one account; matching can be enabled separately."],
  ["link", "Match", "Match: use this column when looking for the same person in other datasets."],
  ["bot", "AI", "AI: show this field to the AI model."],
];

/** A whole-cell checkbox, so the click target is the cell rather than the box. */
function flagCell(row: HTMLElement, label: string, checked: boolean, disabled: boolean, change: (checked: boolean) => void) {
  const cell = row.createEl("td", { cls: "comsift-columns-flag" });
  const wrap = cell.createEl("label", { cls: "comsift-columns-check" + (disabled ? " is-disabled" : "") });
  const box = wrap.createEl("input", { type: "checkbox", attr: { "aria-label": label } });
  box.checked = checked; box.disabled = disabled;
  box.onchange = () => change(box.checked);
  return box;
}

const ROLE_GROUPS: Array<[string, string[]]> = [
  ["Identifies the account", ["username", "user_id", "profile_url"]],
  ["About the person", ["display_name", "bio", "location", "website", "created", "avatar_url", "followers", "verified", "platform", "relation", "avatar_hash"]],
  ["Other", ["other", "skip"]],
];

interface Group { key: string; datasets: DatasetColumns[]; info: DatasetColumns; choices: ColumnChoice[]; requireIdentity: boolean; example: number; origin: string }

/** Merge samples of datasets that share one column layout so suggestions and previews see all of them. */
function mergeInfo(datasets: DatasetColumns[]): DatasetColumns {
  const first = datasets[0];
  const info: DatasetColumns = { name: first.name, columns: first.columns, samples: {}, filled: {}, distinct: {}, rows: 0, examples: [] };
  for (const dataset of datasets) {
    info.rows! += dataset.rows ?? 0;
    info.examples!.push(...(dataset.examples ?? []));
    for (const column of first.columns) {
      info.samples![column] = [...new Set([...(info.samples![column] ?? []), ...(dataset.samples?.[column] ?? [])])].slice(0, 8);
      info.filled![column] = (info.filled![column] ?? 0) + (dataset.filled?.[column] ?? 0);
      info.distinct![column] = Math.max(info.distinct![column] ?? 0, dataset.distinct?.[column] ?? 0);
    }
  }
  if (!datasets.some(dataset => dataset.samples)) { delete info.samples; delete info.filled; delete info.distinct; info.rows = 0; }
  return info;
}

/** Choose what each column means. Everything starts filled in from headers, values and remembered layouts. */
export class ColumnMappingModal extends Modal {
  private active = false;
  constructor(private plugin: ComsiftPlugin, private paths: string[], private saved: () => void) { super(plugin.app); }

  onOpen() {
    this.active = true;
    this.setTitle("Columns");
    this.modalEl.addClass("comsift-dataset-modal", "comsift-columns-modal");
    this.contentEl.createEl("p", { cls: "comsift-columns-intro", text: "Each row becomes one connection profile. Identity columns decide when two rows are the same account. " +
      "Everything is filled in from column names and values; change only what looks wrong." });
    const summary = this.contentEl.createDiv({ cls: "comsift-columns-summary" });
    const host = this.contentEl.createDiv({ cls: "comsift-mapping-list" });
    host.setText("Reading columns…");
    void this.plugin.analysis.discoverColumns(this.paths).then(datasets => {
      if (!this.active) return;
      host.empty();
      try { JSON.parse(this.plugin.setting.columnMapping || "{}"); }
      catch { host.setText("The saved column mapping is not valid JSON. Fix it in settings first."); return; }
      this.build(datasets, host, summary);
    }).catch(error => { if (this.active) host.setText((error as Error).message); });
  }

  private build(datasets: DatasetColumns[], host: HTMLElement, summary: HTMLElement) {
    const mappings = parseMappings(this.plugin.setting.columnMapping);
    const hidden = new Set(this.plugin.setting.decisionIgnoredFields.split(",").map(fieldName).filter(Boolean));
    const profiles = datasets.filter(dataset => isProfileDataset(dataset.name));
    const groups: Group[] = [];
    for (const dataset of datasets.filter(dataset => !isProfileDataset(dataset.name))) {
      const saved = savedMappingFor(mappings, dataset.name);
      const layout = findLayout(dataset.columns, mappings);
      const choices = resolveColumns(dataset, saved, layout);
      const requireIdentity = (saved._require_identity ?? layout?._require_identity) === "1";
      // Datasets with the same columns and the same choices are edited together.
      const key = layoutKey(dataset.columns) + JSON.stringify([requireIdentity, choices.map(c => [c.role, c.name, c.identity, c.match])]);
      const group = groups.find(entry => entry.key === key);
      const origin = choices.some(c => c.source === "saved") ? "Saved" : choices.some(c => c.source === "layout") ? "Remembered layout" : "Automatic";
      if (group) group.datasets.push(dataset);
      else groups.push({ key, datasets: [dataset], info: dataset, choices, requireIdentity, example: 0, origin });
    }
    for (const group of groups) group.info = mergeInfo(group.datasets);

    const drawSummary = () => {
      const problems = groups.reduce((sum, group) => sum + columnConflicts(group.choices).length, 0);
      summary.setText(`${datasets.length} dataset${datasets.length === 1 ? "" : "s"} · ${groups.length} column layout${groups.length === 1 ? "" : "s"} · ` +
        (problems ? `${problems} problem${problems === 1 ? "" : "s"} to fix` : "nothing to fix"));
      summary.toggleClass("mod-warning", problems > 0);
    };

    const aiBoxes: Array<{ group: Group; column: string; box: HTMLInputElement }> = [];
    groups.forEach((group, index) => {
      const section = host.createEl("details", { cls: "comsift-columns-group" });
      if (index === 0 || columnConflicts(group.choices).length) section.setAttr("open", "");
      const head = section.createEl("summary");
      const names = group.datasets.map(dataset => datasetLabel(dataset.name));
      head.createSpan({ text: names[0] + (names.length > 1 ? ` and ${names.length - 1} more` : "") });
      const badge = head.createSpan({ cls: "comsift-columns-badge" });
      if (names.length > 1) section.createDiv({ cls: "comsift-columns-datasets", text: names.join(", ") });
      const problems = section.createDiv({ cls: "comsift-columns-problems" });
      const actions = section.createDiv({ cls: "comsift-columns-actions" });
      const table = section.createEl("table", { cls: "comsift-compare comsift-columns-table" });
      const options = section.createDiv({ cls: "comsift-columns-options" });
      const preview = section.createDiv({ cls: "comsift-columns-preview" });

      const refresh = () => {
        const conflicts = columnConflicts(group.choices);
        problems.empty();
        for (const text of conflicts) problems.createDiv({ cls: "comsift-columns-problem", text });
        if (!hasIdentity(group.choices)) problems.createDiv({ cls: "comsift-columns-note",
          text: "No identity column: every row becomes its own profile and duplicates are never merged." });
        badge.setText(conflicts.length ? `${conflicts.length} to fix` : group.origin);
        badge.toggleClass("mod-warning", conflicts.length > 0);
        drawPreview(); drawSummary();
      };

      const drawTable = () => {
        table.empty();
        const colgroup = table.createEl("colgroup");
        for (const cls of ["is-name", "is-samples", "is-role", "is-flag", "is-flag", "is-flag"]) colgroup.createEl("col", { cls });
        const header = table.createEl("tr");
        for (const text of ["Column", "Sample values", "Use as"]) header.createEl("th", { text });
        for (const [icon, name, tip] of FLAG_COLUMNS) {
          const th = header.createEl("th", { cls: "comsift-columns-flag", attr: { "aria-label": name } });
          setIcon(th, icon);
          setTooltip(th, tip);
        }
        for (const choice of group.choices) {
          const row = table.createEl("tr", { cls: choice.role === "skip" ? "is-skipped" : "" });
          const name = row.createEl("td");
          name.createDiv({ cls: "comsift-columns-name", text: choice.column });
          const why = name.createDiv({ cls: "comsift-columns-reason" });
          why.setText(choice.source === "auto" ? `${choice.reason} · ${choice.confidence}` : choice.reason);
          const detected = choice.detected;
          const differs = detected.role !== choice.role || (detected.role === "other" && detected.name !== choice.name);
          if (differs && detected.confidence !== "low") {
            const suggest = name.createEl("button", { cls: "comsift-columns-suggest", text: `Suggested: ${ROLE_LABELS[detected.role]}${detected.role === "other" ? ` (${detected.name})` : ""}`,
              attr: { title: detected.reason } });
            suggest.onclick = () => { Object.assign(choice, { role: detected.role, name: detected.name, identity: detected.identity, match: true, source: "saved", reason: "Changed here" }); drawTable(); refresh(); };
          }
          const samples = group.info.samples?.[choice.column] ?? [];
          const filled = group.info.filled?.[choice.column];
          row.createEl("td", { cls: "comsift-columns-samples", text: samples.slice(0, 3).join(" · ") || (filled === 0 ? "(empty)" : ""),
            attr: { title: samples.join("\n") + (filled !== undefined && group.info.rows ? `\n${filled} of ${group.info.rows} rows filled` : "") } });

          const roleCell = row.createEl("td");
          const select = roleCell.createEl("select", { cls: "dropdown", attr: { "aria-label": `Use ${choice.column} as` } });
          for (const [label, roles] of ROLE_GROUPS) {
            const optgroup = select.createEl("optgroup", { attr: { label } });
            for (const role of roles) optgroup.createEl("option", { value: role, text: ROLE_LABELS[role] });
          }
          select.value = choice.role;
          if (choice.role === "other") {
            const custom = roleCell.createEl("input", { type: "text", value: choice.name || fieldName(choice.column),
              attr: { "aria-label": `Field name for ${choice.column}`, title: "Columns with the same field name are compared across datasets." } });
            custom.onchange = () => { choice.name = fieldName(custom.value) || fieldName(choice.column); custom.value = choice.name; choice.source = "saved"; refresh(); };
          }
          select.onchange = () => {
            const guess = detectColumn(choice.column, group.info);
            choice.role = select.value; choice.source = "saved"; choice.reason = "Changed here";
            choice.name = select.value === "other" ? (guess.role === "other" ? guess.name : fieldName(choice.column)) : "";
            choice.identity = IDENTITY_ROLES.has(choice.role) || (select.value === "other" && guess.role === "other" && guess.identity);
            drawTable(); refresh();
          };

          const skip = choice.role === "skip";
          flagCell(row, `${choice.column} identifies one account`, !skip && choice.identity, skip,
            checked => { choice.identity = checked; choice.source = "saved"; drawTable(); refresh(); });
          flagCell(row, `Use ${choice.column} for matching`, !skip && choice.match, skip,
            checked => { choice.match = checked; choice.source = "saved"; refresh(); });
          const ai = flagCell(row, `Show ${choice.column} to the AI`, !skip && !hidden.has(choiceField(choice)), skip,
            checked => { if (checked) hidden.delete(choiceField(choice)); else hidden.add(choiceField(choice)); });
          aiBoxes.push({ group, column: choice.column, box: ai });
        }
      };

      const drawPreview = () => {
        preview.empty();
        const examples = group.info.examples ?? [];
        const head = preview.createDiv({ cls: "comsift-columns-preview-head" });
        if (!examples.length) { head.setText("No rows to preview."); return; }
        const row = examples[group.example % examples.length];
        head.createSpan({ cls: "comsift-columns-preview-title", text: "Preview" });
        head.createSpan({ cls: "comsift-columns-preview-count", text: `Row ${group.example % examples.length + 1} of the first ${examples.length}` });
        if (examples.length > 1) head.createEl("button", { cls: "comsift-columns-small", text: "Next row" }).onclick = () => { group.example++; drawPreview(); };
        const result = previewProfile(group.choices, row, group.requireIdentity);
        const card = preview.createDiv({ cls: "comsift-columns-card" });
        if (!result.isPerson) { card.createDiv({ cls: "comsift-columns-note", text: "This row has no identity value and would be skipped." }); return; }
        card.createDiv({ cls: "comsift-columns-card-title", text: result.title });
        const list = (title: string, entries: Array<[string, string]>) => {
          if (!entries.length) return;
          card.createDiv({ cls: "comsift-columns-card-label", text: title });
          const ul = card.createEl("ul");
          for (const [key, value] of entries) { const li = ul.createEl("li"); li.createSpan({ cls: "comsift-columns-key", text: `${key}: ` }); li.createSpan({ text: value }); }
        };
        list("Identity", result.identity);
        list("Details", result.details);
        if (result.unmatched.length) card.createDiv({ cls: "comsift-columns-note", text: `Kept, not used for matching: ${result.unmatched.join(", ")}` });
        if (result.skipped.length) card.createDiv({ cls: "comsift-columns-note", text: `Skipped columns: ${result.skipped.join(", ")}` });
      };

      new Setting(options).setClass("comsift-columns-row-filter").setName("Skip rows with no identity value")
        .setDesc("Rows without a username, ID or other identity value, such as totals or notes, are left out.")
        .addToggle(toggle => toggle.setValue(group.requireIdentity).onChange(value => { group.requireIdentity = value; refresh(); }));
      actions.createEl("button", { cls: "comsift-columns-small", text: "Use all suggestions", attr: { title: "Reset this layout to the automatic choices." } }).onclick = () => {
        group.choices = resolveColumns(group.info);
        group.choices.forEach(choice => { choice.source = "saved"; });
        drawTable(); refresh();
      };
      if (groups.length > 1) actions.createEl("button", { cls: "comsift-columns-small", text: "Copy to other datasets", attr: { title: "Apply these choices to columns with the same names in the other datasets." } }).onclick = () => {
        for (const other of groups) if (other !== group) other.choices = copyChoices(group.choices, other.choices);
        host.dispatchEvent(new CustomEvent("comsift-columns-redraw"));
        new Notice("Copied to columns with the same names.");
      };
      host.addEventListener("comsift-columns-redraw", () => { drawTable(); refresh(); });
      drawTable(); refresh();
    });

    if (profiles.length) host.createDiv({ cls: "comsift-columns-note",
      text: `${profiles.length} saved connection profile${profiles.length === 1 ? " keeps its" : "s keep their"} own fields and ${profiles.length === 1 ? "is" : "are"} not listed here.` });
    if (!groups.length && !profiles.length) host.setText("No columns found in the selected datasets.");
    drawSummary();

    let remember = true;
    new Setting(this.contentEl).setClass("comsift-columns-remember").setName("Remember for datasets with these columns")
      .setDesc("New datasets with the same column names start with these choices.")
      .addToggle(toggle => toggle.setValue(remember).onChange(value => { remember = value; }));
    const footer = this.contentEl.createDiv({ cls: "comsift-review-actions comsift-columns-footer" });
    footer.createEl("button", { text: "Save", cls: "mod-cta" }).onclick = () => {
      const broken = groups.find(group => columnConflicts(group.choices).length);
      if (broken) { new Notice(columnConflicts(broken.choices)[0]); return; }
      const next = { ...mappings };
      for (const group of groups) {
        const mapping = choicesToMapping(group.choices, { requireIdentity: group.requireIdentity });
        for (const dataset of group.datasets) next[dataset.name] = { ...mapping };
        if (remember) next[layoutKey(group.info.columns)] = { ...mapping };
      }
      this.plugin.setting.columnMapping = JSON.stringify(next);
      // Fields not shown here keep their AI visibility.
      for (const { group, column, box } of aiBoxes) {
        const choice = group.choices.find(entry => entry.column === column);
        if (!choice || choice.role === "skip" || !box.isConnected) continue;
        if (box.checked) hidden.delete(choiceField(choice)); else hidden.add(choiceField(choice));
      }
      this.plugin.setting.decisionIgnoredFields = [...hidden].join(", ");
      void this.plugin.saveSettings().then(() => { this.saved(); this.close(); }).catch(error => new Notice((error as Error).message));
    };
    footer.createEl("button", { text: "Cancel" }).onclick = () => this.close();
  }

  onClose() { this.active = false; this.contentEl.empty(); }
}
