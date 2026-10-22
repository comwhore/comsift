import { Modal } from "obsidian";
import type ComsiftPlugin from "../main";

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
    const chosen = new Set(this.plugin.analysis.canonicalDatasetPaths(this.selected));
    const search = this.contentEl.createEl("input", { type: "search", placeholder: "Filter files, sheet names or connection profiles…" });
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
      if (!rows.length) list.createDiv({ cls: "comsift-empty", text: "No CSV files, spreadsheets or connection profiles found." });
    };
    const refresh = () => { apply.textContent = `Use ${chosen.size} selected dataset${chosen.size === 1 ? "" : "s"}`; apply.disabled = chosen.size < 1; };
    apply.disabled = true;
    list.setText("Reading dataset columns…");
    void this.plugin.analysis.discoverColumns(this.plugin.analysis.listDatasets().map(file => file.path)).then(found => {
      if (!this.active) return;
      // Several configured rectangles still represent one selectable workbook tab.
      const merged = new Map<string, Set<string>>();
      for (const dataset of found) {
        const name = dataset.name.replace(/@[A-Z]+\d+:[A-Z]+\d+$/i, "");
        const columns = merged.get(name) ?? new Set<string>();
        dataset.columns.forEach(column => columns.add(column));
        merged.set(name, columns);
      }
      rows.push(...[...merged].map(([name, columns]) => ({ name, columns: [...columns] })));
      const normalized = this.plugin.analysis.canonicalDatasetPaths([...chosen]);
      chosen.clear(); normalized.forEach(path => chosen.add(path));
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

export { ColumnMappingModal } from "./columnModal";
