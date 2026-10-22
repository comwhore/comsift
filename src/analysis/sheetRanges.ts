import type { SheetTable } from "./sheets";

export interface SheetRange { sri: number; sci: number; eri: number; eci: number }
const column = (text: string) => [...text.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
const letter = (index: number): string => { let value = index + 1, out = ""; while (value > 0) { value--; out = String.fromCharCode(65 + value % 26) + out; value = Math.floor(value / 26); } return out; };
export function parseSheetRange(text: string): SheetRange {
  const match = text.trim().match(/^\$?([a-z]+)\$?(\d+)(?::\$?([a-z]+)\$?(\d+))?$/i);
  if (!match) throw new Error("Use a range such as J1:L200, including the header row.");
  const range = { sri: Number(match[2]) - 1, sci: column(match[1]), eri: Number(match[4] ?? match[2]) - 1, eci: column(match[3] ?? match[1]) };
  if (range.sri < 0 || range.eri < range.sri || range.eci < range.sci || range.eri > 100000 || range.eci > 16383) throw new Error("Invalid sheet range.");
  return range;
}
export function formatSheetRange(range: SheetRange): string { return `${letter(range.sci)}${range.sri + 1}:${letter(range.eci)}${range.eri + 1}`; }
export function rangeRows(table: SheetTable, range: SheetRange): string[][] {
  if (range.eri >= table.rows.length || range.eci >= table.rows.reduce((width, row) => Math.max(width, row.length), 0)) throw new Error(`Range ${formatSheetRange(range)} extends beyond ${table.name}'s populated cells.`);
  return table.rows.slice(range.sri, range.eri + 1).map(row => Array.from({ length: range.eci - range.sci + 1 }, (_, c) => row[range.sci + c] ?? ""));
}
export function readSheetRanges(text: string | undefined): Record<string, string[]> {
  if (!text) return {};
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Sheet ranges must be an object.");
  return Object.fromEntries(Object.entries(value).map(([name, ranges]) => {
    if (!Array.isArray(ranges) || !ranges.every((range): range is string => typeof range === "string")) throw new Error("Sheet ranges must be lists of A1 ranges.");
    return [name, ranges.map(range => formatSheetRange(parseSheetRange(range)))];
  }));
}
/** Preserve selected columns, infer their header above the selection, extend to populated data below. */
export function autoSheetRange(table: SheetTable, selected: SheetRange): SheetRange {
  const width = table.rows.reduce((width, row) => Math.max(width, row.length), 0);
  if (selected.sci < 0 || selected.eci >= width) throw new Error("Select populated columns first.");
  const known = /^(?:display[ _]name|user(?:[ _]?name)?|handle|profile[ _](?:link|url)|bio|name|location|platform|email|id)$/i;
  let header = -1;
  for (let r = Math.min(selected.sri, table.rows.length - 1); r >= 0; r--) {
    if ((table.rows[r] ?? []).slice(selected.sci, selected.eci + 1).some(cell => known.test(cell.trim()))) { header = r; break; }
  }
  if (header < 0) header = selected.sri;
  let end = Math.min(Math.max(selected.eri, header + 1), table.rows.length - 1);
  while (end + 1 < table.rows.length && table.rows[end + 1].slice(selected.sci, selected.eci + 1).some(cell => cell.trim())) end++;
  return { ...selected, sri: header, eri: end };
}

export interface SheetCell { row: number; col: number }
export interface SheetColumn { index: number; letter: string; name: string }

export const columnLetter = letter;
export const sheetWidth = (table: SheetTable) => table.rows.reduce((width, row) => Math.max(width, row.length), 0);
const filled = (table: SheetTable, row: number, sci: number, eci: number) => (table.rows[row] ?? []).slice(sci, eci + 1).some(cell => cell.trim());

/** Rectangle spanned by two dragged-over cells, whichever corner the drag started from. */
export function normalizeRect(a: SheetCell, b: SheetCell): SheetRange {
  return { sri: Math.min(a.row, b.row), sci: Math.min(a.col, b.col), eri: Math.max(a.row, b.row), eci: Math.max(a.col, b.col) };
}

/** The header is the row with the most filled cells among the first ten; ties go to the earliest row. */
export function headerRowOf(table: SheetTable): number {
  let best = 0, count = -1;
  for (let r = 0; r < Math.min(10, table.rows.length); r++) {
    const n = table.rows[r].filter(cell => cell.trim()).length;
    if (n > count) { best = r; count = n; }
  }
  return best;
}

/** Last row of the block of filled rows below a header, at least one data row when the sheet has one. */
export function lastDataRow(table: SheetTable, header: number, sci: number, eci: number): number {
  let end = Math.min(header + 1, table.rows.length - 1);
  while (end + 1 < table.rows.length && filled(table, end + 1, sci, eci)) end++;
  return Math.max(end, header);
}

/** Header names of every column, using the letter when the header cell is blank. */
export function sheetColumns(table: SheetTable, header: number): SheetColumn[] {
  return Array.from({ length: sheetWidth(table) }, (_, index) => ({ index, letter: letter(index), name: (table.rows[header]?.[index] ?? "").trim() }));
}

/** Column names covered by a range, read from its own header row. */
export function rangeColumnNames(table: SheetTable, range: SheetRange): string[] {
  return sheetColumns(table, range.sri).slice(range.sci, range.eci + 1).map(column => column.name || column.letter);
}

/**
 * Range covering the named header columns, rows down to the end of the data.
 * Names must sit next to each other because a range is one rectangle; repeated names pick the first occurrence at or after `from`.
 */
export function columnsToRange(table: SheetTable, names: string[], header = headerRowOf(table), from = 0): SheetRange {
  if (!names.length) throw new Error("Choose at least one column.");
  const columns = sheetColumns(table, header);
  const indexes = names.map(name => {
    const wanted = name.trim().toLowerCase();
    const hit = columns.find(column => column.index >= from && (column.name.toLowerCase() === wanted || column.letter.toLowerCase() === wanted));
    if (!hit) throw new Error(`No column named ${name} in row ${header + 1}.`);
    return hit.index;
  }).sort((a, b) => a - b);
  if (indexes.some((index, i) => i > 0 && index !== indexes[i - 1] + 1)) throw new Error("Columns in one range must be next to each other. Add another block for the rest.");
  const sci = indexes[0], eci = indexes[indexes.length - 1];
  return { sri: header, sci, eri: lastDataRow(table, header, sci, eci), eci };
}

/** Add a column to a range (filling any gap) or remove it from either edge. Returns null for a middle column. */
export function toggleColumn(range: SheetRange, col: number): SheetRange | null {
  if (col < range.sci) return { ...range, sci: col };
  if (col > range.eci) return { ...range, eci: col };
  if (range.sci === range.eci) return null;
  if (col === range.sci) return { ...range, sci: col + 1 };
  if (col === range.eci) return { ...range, eci: col - 1 };
  return null;
}
