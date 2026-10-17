import { Modal, Notice } from "obsidian";
import type ComsiftPlugin from "../main";
import { CANONICAL, fieldName, mappedField, columnMismatches } from "./columnMapping";

/** Select exact datasets, including individual workbook tabs, from anywhere in the vault. */
export class DatasetPickerModal extends Modal {
  private active = false;
  constructor(private plugin: ComsiftPlugin, private selected: string[], private choose: (paths: string[]) => void) {
    super(plugin.app);
  }

  onOpen() {
    this.active = true;
    this.setTitle("Choose datasets from the vault");
    this.modalEl.addClass("comsift-dataset-modal");
    const chosen = new Set(this.selected);
    const search = this.contentEl.createEl("input", { type: "search", placeholder: "Filter files or sheet names…" });
    const list = this.contentEl.createDiv({ cls: "comsift-dataset-list" });
    const footer = this.contentEl.createDiv({ cls: "comsift-review-actions" });
    const apply = footer.createEl("button", { text: "Use selected datasets", cls: "mod-cta" });
    footer.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    const rows: Array<{ name: string; columns: string[] }> = [];
    const draw = () => {
      list.empty();
      const needle = search.value.trim().toLowerCase();
      for (const dataset of rows.filter(row => row.name.toLowerCase().includes(needle))) {
        const row = list.createEl("label", { cls: "comsift-dataset-option" });
        const box = row.createEl("input", { type: "checkbox" });
        box.checked = chosen.has(dataset.name) || chosen.has(dataset.name.split("#")[0]);
        box.onchange = () => {
          chosen.delete(dataset.name.split("#")[0]);
          if (box.checked) chosen.add(dataset.name); else chosen.delete(dataset.name);
          refresh();
        };
        row.createSpan({ text: dataset.name });
        row.createSpan({ cls: "comsift-source-meta", text: `${dataset.columns.length} columns` });
      }
      if (!rows.length) list.createDiv({ cls: "comsift-empty", text: "No CSV files or spreadsheets found." });
    };
    const refresh = () => { apply.textContent = `Use ${chosen.size} selected dataset${chosen.size === 1 ? "" : "s"}`; apply.disabled = chosen.size < 2; };
    apply.disabled = true;
    list.setText("Reading dataset columns…");
    void this.plugin.analysis.discoverColumns(this.plugin.analysis.listDatasets().map(file => file.path)).then(found => {
      if (!this.active) return;
      rows.push(...found);
      // Expand selected workbooks so tabs can be deselected independently.
      for (const dataset of rows) if (chosen.has(dataset.name.split("#")[0])) chosen.add(dataset.name);
      for (const path of [...chosen]) if (!rows.some(row => row.name === path)) chosen.delete(path);
      draw(); refresh();
    }).catch(error => { if (this.active) list.setText((error as Error).message); });
    search.oninput = draw;
    apply.onclick = () => { this.choose([...chosen]); this.close(); };
  }

  onClose() { this.active = false; this.contentEl.empty(); }
}

/** Map all discovered columns to shared fields; equal shared names are compared across datasets. */
export class ColumnMappingModal extends Modal {
  private active = false;
  constructor(private plugin: ComsiftPlugin, private paths: string[], private saved: () => void) { super(plugin.app); }

  onOpen() {
    this.active = true;
    this.setTitle("Match columns across datasets");
    this.modalEl.addClass("comsift-dataset-modal");
    this.contentEl.createEl("p", { text: "Give columns that mean the same thing the same shared field name. Choose a discovered column name or type a new one. Leave a field blank to ignore that column." });
    const host = this.contentEl.createDiv({ cls: "comsift-mapping-list" });
    host.setText("Discovering columns…");
    void this.plugin.analysis.discoverColumns(this.paths).then(datasets => {
      if (!this.active) return;
      host.empty();
      let mappings: Record<string, Record<string, string>>;
      try { mappings = JSON.parse(this.plugin.setting.columnMapping) as typeof mappings; }
      catch { throw new Error("The existing column mapping is invalid JSON. Correct it in settings first."); }
      if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) throw new Error("Column mapping must be an object.");
      const choices = [...new Set([...CANONICAL, ...datasets.flatMap(dataset => dataset.columns.map(fieldName))])].sort();
      const options = host.createEl("datalist", { attr: { id: "comsift-shared-fields" } });
      choices.forEach(value => options.createEl("option", { value }));
      const rows: Array<{ dataset: string; column: string; input: HTMLInputElement }> = [];
      for (const dataset of columnMismatches(datasets, this.plugin.setting.columnMapping)) {
        const section = host.createEl("details", { attr: { open: "" } });
        section.createEl("summary", { text: dataset.name });
        const table = section.createEl("table", { cls: "comsift-compare" });
        const head = table.createEl("tr");
        head.createEl("th", { text: "Found column" }); head.createEl("th", { text: "Shared field" });
        const mapping = { ...(mappings["*"] ?? {}), ...(mappings[dataset.name] ?? {}) };

        for (const column of dataset.columns) {
          const row = table.createEl("tr", { cls: datasets.length > 2 && dataset.mismatching.includes(column) ? "comsift-column-mismatch" : "" }); row.createEl("td", { text: column });
          const value = mappedField(column, mapping);
          const input = row.createEl("td").createEl("input", { type: "text", value,
            attr: { list: "comsift-shared-fields", "aria-label": `Shared field for ${dataset.name}: ${column}` } });
          rows.push({ dataset: dataset.name, column, input });
        }
      }
      const footer = this.contentEl.createDiv({ cls: "comsift-review-actions" });
      footer.createEl("button", { text: "Save mapping", cls: "mod-cta" }).onclick = () => {
        const next = { ...mappings };
        for (const dataset of datasets) next[dataset.name] = {};
        for (const row of rows) {
          const field = fieldName(row.input.value);
          const target = next[row.dataset];
          if (["__proto__", "constructor", "prototype", "_ignore"].includes(field)) { new Notice("Choose a different shared field name."); return; }
          if (!field) { target._ignore = [target._ignore, row.column].filter(Boolean).join("\n"); continue; }
          if (Object.prototype.hasOwnProperty.call(target, field)) { new Notice(`Two columns in ${row.dataset} use “${field}”. Give them different fields.`); return; }
          target[field] = row.column;
        }
        this.plugin.setting.columnMapping = JSON.stringify(next);
        void this.plugin.saveSettings().then(() => { this.saved(); this.close(); }).catch(error => new Notice((error as Error).message));
      };
      footer.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    }).catch(error => { if (this.active) host.setText((error as Error).message); });
  }

  onClose() { this.active = false; this.contentEl.empty(); }
}
