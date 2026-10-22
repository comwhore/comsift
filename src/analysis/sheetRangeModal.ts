import { Modal } from "obsidian";
import type ComsiftPlugin from "../main";
import {
  autoSheetRange, columnLetter, formatSheetRange, headerRowOf, lastDataRow, normalizeRect, parseSheetRange, rangeColumnNames, rangeRows, readSheetRanges,
  sheetColumns, sheetWidth, toggleColumn, type SheetCell, type SheetRange,
} from "./sheetRanges";

interface SheetSelection { name: string; range: SheetRange }

/** Read a selection only from its actual workbook and tab, never from another open sheet. */
export function currentSheetSelection(plugin: ComsiftPlugin, names?: Set<string>): SheetSelection | null {
  const activePath = plugin.app.workspace.getActiveFile?.()?.path;
  const leaves = [...plugin.app.workspace.getLeavesOfType("excel-view")].sort((a, b) => {
    const file = (leaf: typeof a) => (leaf.view as unknown as { file?: { path: string } }).file?.path;
    return Number(file(b) === activePath) - Number(file(a) === activePath);
  });
  for (const leaf of leaves) {
    const view = leaf.view as unknown as { file?: { path: string }; cellsSelected?: Partial<SheetRange> & { sheet?: { name?: string } } };
    const selected = view.cellsSelected;
    if (!view.file?.path || !selected?.sheet?.name) continue;
    const { sri, sci, eri, eci } = selected;
    if (![sri, sci, eri, eci].every(value => typeof value === "number" && Number.isInteger(value) && value >= 0)) continue;
    const name = `${view.file.path}#${selected.sheet.name}`;
    if (names && !names.has(name)) continue;
    const range = { sri: sri!, sci: sci!, eri: eri!, eci: eci! };
    if (range.sri > range.eri || range.sci > range.eci) continue;
    return { name, range };
  }
  return null;
}

const GRID_ROWS = 30;
const GRID_COLUMNS = 60;
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const inside = (range: SheetRange, row: number, col: number) => row >= range.sri && row <= range.eri && col >= range.sci && col <= range.eci;

/** Parse the typed ranges, keeping the valid ones so the grid can still show them. */
function typedRanges(text: string): SheetRange[] {
  return text.split(/[;\n]+/).map(value => value.trim()).filter(Boolean).flatMap(value => {
    try { return [parseSheetRange(value)]; } catch { return []; }
  });
}

/** Select independent rectangles with their own header rows, preserving CSV inputs unchanged. */
export class SheetRangeModal extends Modal {
  private active = false;
  constructor(private plugin: ComsiftPlugin, private paths: string[], private saved: () => void) { super(plugin.app); }

  onOpen() {
    this.active = true;
    this.setTitle("Spreadsheet ranges");
    this.modalEl.addClass("comsift-dataset-modal", "comsift-ranges-modal");
    this.contentEl.createEl("p", { cls: "comsift-ranges-intro", text: "Pick the columns to import or compare. Each block is one table with its header row on top. " +
      "Use a separate block for each repeated set of columns. CSV files and connection profiles keep their full contents." });
    const host = this.contentEl.createDiv();
    host.setText("Reading spreadsheet tabs…");
    void this.plugin.analysis.sheetTables(this.paths).then(tables => {
      if (!this.active) return;
      host.empty();
      if (!tables.length) { host.createEl("p", { text: "No spreadsheet tabs in this selection. Choose a .sheet.md workbook with Choose datasets first. CSV files can be used directly." }); return; }
      const ranges = readSheetRanges(this.plugin.setting.sheetRanges);
      const selected = currentSheetSelection(this.plugin, new Set(tables.map(table => table.name)));
      const draft = new Map<string, string[]>();
      for (const table of tables) {
        if (ranges[table.name]?.length) draft.set(table.name, [...ranges[table.name]]);
        else if (selected?.name === table.name) {
          try { draft.set(table.name, [formatSheetRange(autoSheetRange(table, selected.range))]); }
          catch { draft.set(table.name, []); }
        } else draft.set(table.name, []);
      }
      const wholeSheets = new Map([...draft].map(([name, values]) => [name, values.length === 0]));
      const chooser = host.createEl("select", { cls: "dropdown comsift-ranges-tab", attr: { "aria-label": "Spreadsheet tab" } });
      for (const table of tables) chooser.createEl("option", { text: table.name, value: table.name });
      if (selected && tables.some(table => table.name === selected.name)) chooser.value = selected.name;
      const editor = host.createDiv({ cls: "comsift-ranges-editor" });
      const error = host.createDiv({ cls: "comsift-hint" });
      let saveCurrent = () => {};
      const draw = () => {
        editor.empty(); error.setText("");
        const table = tables.find(table => table.name === chooser.value)!;
        const current = draft.get(table.name) ?? [];
        const label = editor.createEl("label", { cls: "comsift-dataset-option comsift-ranges-whole" });
        const whole = label.createEl("input", { type: "checkbox" });
        whole.checked = wholeSheets.get(table.name) ?? true;
        label.createSpan({ text: "Use whole sheet" });
        label.createSpan({ cls: "comsift-source-meta", text: `${Math.max(0, table.rows.length - 1)} rows · ${sheetWidth(table)} columns` });

        const toolbar = editor.createDiv({ cls: "comsift-ranges-toolbar" });
        const blockList = toolbar.createDiv({ cls: "comsift-ranges-blocks" });
        const tools = toolbar.createDiv({ cls: "comsift-ranges-tools" });
        const addBlock = tools.createEl("button", { text: "Add block" });
        const exact = tools.createEl("button", { text: "Use current selection" });
        const infer = tools.createEl("button", { text: "Find table around selection" });
        exact.disabled = infer.disabled = selected?.name !== table.name;
        const namesHead = editor.createDiv({ cls: "comsift-ranges-label" });
        const names = editor.createDiv({ cls: "comsift-ranges-names" });
        editor.createDiv({ cls: "comsift-ranges-help", text: "Click a column name or letter to add or remove it, shift-click to select a span, drag across cells for a rectangle, click a row number to make it the header row." });

        const scroller = editor.createDiv({ cls: "comsift-ranges-grid" });
        const grid = scroller.createEl("table");
        const advanced = editor.createEl("details", { cls: "comsift-ranges-advanced" });
        advanced.createEl("summary", { text: "Type the ranges instead" });
        const input = advanced.createEl("textarea", { attr: { rows: "2", placeholder: ["A1:D200", "J1:L200"].join("; "), "aria-label": "Ranges including header rows" } });
        input.value = current.join("; ");
        input.disabled = whole.checked;
        const preview = editor.createDiv({ cls: "comsift-ranges-summary" });

        let activeBlock = 0, adding = false, anchor: number | null = null;
        let drag: { start: SheetCell; end: SheetCell } | null = null;
        const blocks = () => whole.checked ? [] : typedRanges(input.value);

        // Grid: first rows of the sheet with column letters and row numbers.
        const shownRows = Math.min(GRID_ROWS, table.rows.length), shownColumns = Math.min(GRID_COLUMNS, sheetWidth(table));
        const cells: HTMLElement[][] = [];
        const letters: HTMLElement[] = [];
        const numbers: HTMLElement[] = [];
        const head = grid.createEl("thead").createEl("tr");
        head.createEl("th", { cls: "comsift-ranges-corner" });
        for (let c = 0; c < shownColumns; c++) {
          const button = head.createEl("th").createEl("button", { text: columnLetter(c), attr: { "aria-label": `Add or remove column ${columnLetter(c)}` } });
          button.onclick = (event: MouseEvent) => pickColumn(c, event.shiftKey);
          letters.push(button);
        }
        const body = grid.createEl("tbody");
        for (let r = 0; r < shownRows; r++) {
          const line = body.createEl("tr");
          const number = line.createEl("th").createEl("button", { text: String(r + 1), attr: { "aria-label": `Use row ${r + 1} as the header row` } });
          number.onclick = () => pickHeader(r);
          numbers.push(number);
          cells.push([]);
          for (let c = 0; c < shownColumns; c++) {
            const value = table.rows[r]?.[c] ?? "";
            const cell = line.createEl("td", { text: value, attr: value ? { title: value } : {} });
            cell.onmousedown = (event: MouseEvent) => { if (event.button !== 0) return; event.preventDefault(); drag = { start: { row: r, col: c }, end: { row: r, col: c } }; paint(); };
            cell.onmouseenter = (event: MouseEvent) => {
              if (!drag) return;
              if (!(event.buttons & 1)) { finishDrag(event.shiftKey); return; }
              drag.end = { row: r, col: c }; paint();
            };
            cells[r].push(cell);
          }
        }
        if (table.rows.length > shownRows || sheetWidth(table) > shownColumns) editor.createDiv({ cls: "comsift-ranges-help",
          text: `Showing the first ${shownRows} rows and ${shownColumns} columns. Dragging to the last row shown extends the block to the end of the data.` });
        scroller.onmouseup = (event: MouseEvent) => finishDrag(event.shiftKey);

        const update = (list: SheetRange[], next: number) => {
          whole.checked = false; input.disabled = false;
          input.value = list.map(formatSheetRange).join("; ");
          activeBlock = Math.max(0, Math.min(next, list.length - 1)); adding = false;
          showPreview();
        };
        const place = (range: SheetRange) => {
          const list = blocks();
          if (adding || !list.length) update([...list, range], list.length);
          else { list[activeBlock] = range; update(list, activeBlock); }
        };
        const newBlock = (sci: number, eci: number, header = headerRowOf(table)): SheetRange => ({ sri: header, sci, eci, eri: lastDataRow(table, header, sci, eci) });
        const pickColumn = (col: number, span: boolean) => {
          const list = blocks();
          const current = list[activeBlock];
          if (adding || !current) { anchor = col; place(newBlock(col, col)); return; }
          let next: SheetRange | null;
          if (span && anchor !== null) {
            const sci = Math.min(anchor, col), eci = Math.max(anchor, col);
            next = { ...current, sci, eci, eri: Math.max(current.eri, lastDataRow(table, current.sri, sci, eci)) };
          } else {
            next = toggleColumn(current, col);
            if (next) next.eri = Math.max(next.eri, lastDataRow(table, next.sri, next.sci, next.eci));
            else if (current.sci === current.eci) { list.splice(activeBlock, 1); anchor = null; update(list, activeBlock - 1); return; }
            else { error.setText("A block is one rectangle, so only its first or last column can be removed here. To leave out a column in the middle, turn it off in the column settings. Each block becomes separate records, so start another block only for a repeated set of columns."); return; }
          }
          anchor = col;
          list[activeBlock] = next; update(list, activeBlock);
        };
        const pickHeader = (row: number) => {
          const list = blocks();
          const current = list[activeBlock];
          if (adding || !current) {
            const used = (table.rows[row] ?? []).map((cell, index) => cell.trim() ? index : -1).filter(index => index >= 0);
            if (!used.length) { error.setText(`Row ${row + 1} is empty. Pick a row with column names.`); return; }
            place(newBlock(used[0], used[used.length - 1], row));
            return;
          }
          list[activeBlock] = { ...current, sri: row, eri: row < current.eri ? current.eri : lastDataRow(table, row, current.sci, current.eci) };
          update(list, activeBlock);
        };
        const finishDrag = (span: boolean) => {
          if (!drag) return;
          const { start, end } = drag;
          drag = null;
          if (start.row === end.row && start.col === end.col) { pickColumn(start.col, span); return; }
          const rect = normalizeRect(start, end);
          // A one-row drag picks header cells; reaching the last shown row means "to the end of the data".
          if (rect.eri === rect.sri || (rect.eri === shownRows - 1 && table.rows.length > shownRows)) rect.eri = Math.max(rect.eri, lastDataRow(table, rect.sri, rect.sci, rect.eci));
          anchor = rect.eci;
          place(rect);
        };

        const paint = () => {
          const list = blocks();
          const current = adding ? undefined : list[activeBlock];
          const dragged = drag ? normalizeRect(drag.start, drag.end) : null;
          cells.forEach((line, r) => line.forEach((cell, c) => {
            cell.toggleClass("is-selected", list.some(range => inside(range, r, c)));
            cell.toggleClass("is-active", !!current && inside(current, r, c));
            cell.toggleClass("is-header", list.some(range => range.sri === r && c >= range.sci && c <= range.eci));
            cell.toggleClass("is-dragging", !!dragged && inside(dragged, r, c));
          }));
          letters.forEach((button, c) => button.toggleClass("is-active", !!current && c >= current.sci && c <= current.eci));
          numbers.forEach((button, r) => button.toggleClass("is-active", !!current && current.sri === r));
          if (drag) return;

          blockList.empty();
          list.forEach((range, index) => {
            const chip = blockList.createDiv({ cls: "comsift-ranges-block" + (index === activeBlock && !adding ? " is-active" : "") });
            chip.createEl("button", { cls: "comsift-ranges-block-name", text: `Block ${index + 1}: ${formatSheetRange(range)}` }).onclick = () => { activeBlock = index; adding = false; anchor = null; paint(); };
            const remove = chip.createEl("button", { cls: "comsift-ranges-block-remove", text: "×", attr: { "aria-label": `Remove block ${index + 1}` } });
            remove.onclick = () => { list.splice(index, 1); update(list, activeBlock > index ? activeBlock - 1 : activeBlock); };
          });
          if (adding) blockList.createSpan({ cls: "comsift-ranges-block is-active is-pending", text: `Block ${list.length + 1}: pick columns` });
          if (!list.length && !adding) blockList.createSpan({ cls: "comsift-source-meta", text: whole.checked ? "Whole sheet" : "No blocks yet" });
          addBlock.toggleClass("is-active", adding);

          const header = current?.sri ?? headerRowOf(table);
          namesHead.setText(current ? `Columns in block ${activeBlock + 1} (header row ${header + 1})` : `Columns (header row ${header + 1})`);
          names.empty();
          for (const column of sheetColumns(table, header)) {
            const on = !!current && column.index >= current.sci && column.index <= current.eci;
            const chip = names.createEl("button", { cls: "comsift-ranges-name" + (on ? " is-active" : "") + (column.name ? "" : " is-blank"),
              attr: { "aria-pressed": String(on), "aria-label": `${on ? "Remove" : "Add"} column ${column.letter}${column.name ? ` (${column.name})` : ""}` } });
            chip.createSpan({ cls: "comsift-ranges-letter", text: column.letter });
            chip.createSpan({ text: column.name || "(blank)" });
            chip.onclick = (event: MouseEvent) => pickColumn(column.index, event.shiftKey);
          }
        };

        saveCurrent = () => {
          const values = whole.checked ? [] : input.value.split(/[;\n]+/).map(value => value.trim()).filter(Boolean);
          draft.set(table.name, values);
          wholeSheets.set(table.name, whole.checked);
        };
        const showPreview = () => {
          saveCurrent(); preview.empty(); error.setText("");
          try {
            const values = draft.get(table.name) ?? [];
            if (!whole.checked && !values.length) throw new Error("Pick at least one column, or use the whole sheet.");
            for (const value of values) {
              const range = parseSheetRange(value);
              const rows = rangeRows(table, range);
              const names = rangeColumnNames(table, range);
              preview.createDiv({ cls: "comsift-source-meta", text: `${formatSheetRange(range)}: ${Math.max(0, rows.length - 1)} data rows · ${names.join(", ")}` });
            }
            if (whole.checked) preview.createDiv({ cls: "comsift-source-meta", text: `Whole sheet: ${Math.max(0, table.rows.length - 1)} data rows` });
          } catch (cause) { error.setText(message(cause)); }
          if (typedRanges(input.value).length !== (draft.get(table.name) ?? []).length) advanced.open = true;
          if (activeBlock >= blocks().length) activeBlock = Math.max(0, blocks().length - 1);
          paint();
        };
        input.oninput = showPreview;
        whole.onchange = () => { input.disabled = whole.checked; adding = false; showPreview(); };
        addBlock.onclick = () => { adding = !adding; anchor = null; if (adding && whole.checked) { whole.checked = false; input.disabled = false; } paint(); };
        const useSelection = (expand: boolean) => {
          if (!selected || selected.name !== table.name) return;
          try { place(expand ? autoSheetRange(table, selected.range) : selected.range); }
          catch (cause) { error.setText(message(cause)); }
        };
        exact.onclick = () => useSelection(false);
        infer.onclick = () => useSelection(true);
        showPreview();
      };
      chooser.onchange = () => { saveCurrent(); draw(); };
      const footer = host.createDiv({ cls: "comsift-review-actions comsift-ranges-footer" });
      const save = footer.createEl("button", { text: "Save ranges", cls: "mod-cta" });
      save.onclick = () => {
        saveCurrent();
        try {
          const next = { ...ranges };
          for (const table of tables) {
            const values = draft.get(table.name) ?? [];
            if (!wholeSheets.get(table.name) && !values.length) throw new Error(`Pick columns for ${table.name}, or use the whole sheet.`);
            if (!values.length) delete next[table.name];
            else next[table.name] = values.map(value => {
              const range = parseSheetRange(value);
              if (range.eri <= range.sri) throw new Error("Each range needs a header row and at least one data row.");
              rangeRows(table, range);
              return formatSheetRange(range);
            });
          }
          // An empty custom field is a typo, not a request to import the whole workbook.
          const activeWhole = editor.querySelector<HTMLInputElement>('input[type="checkbox"]');
          if (activeWhole && !activeWhole.checked && !(draft.get(chooser.value)?.length)) throw new Error("Pick at least one column, or use the whole sheet.");
          const previous = this.plugin.setting.sheetRanges;
          this.plugin.setting.sheetRanges = JSON.stringify(next);
          save.disabled = true;
          void this.plugin.saveSettings().then(() => { this.saved(); this.close(); }).catch(cause => {
            this.plugin.setting.sheetRanges = previous;
            save.disabled = false;
            error.setText(cause instanceof Error ? cause.message : String(cause));
          });
        } catch (cause) { error.setText(cause instanceof Error ? cause.message : String(cause)); }
      };
      footer.createEl("button", { text: "Cancel" }).onclick = () => this.close();
      draw();
    }).catch(cause => { if (this.active) host.setText(cause instanceof Error ? cause.message : String(cause)); });
  }

  onClose() { this.active = false; this.contentEl.empty(); }
}
