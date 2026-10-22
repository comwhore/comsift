// Pure helpers for cell embeds such as `![[Example.sheet#A1:B2]]` and for locating the cells of an
// imported row (header row + that row) so a person card can show them.
import { formatSheetRange, parseSheetRange, type SheetRange } from "./sheetRanges";
import type { SheetTable } from "./sheets";

export interface CellRef {
  /** Sheet (tab) name; the first sheet when missing. */
  sheet?: string;
  /** One or more rectangles, rendered one after another (e.g. a header row and a data row). */
  ranges: SheetRange[];
}

const CELL = String.raw`\$?[A-Za-z]{1,3}\$?\d{1,6}`;
const RANGE = `${CELL}(?::${CELL})?`;
const REF = new RegExp(`^(?:(?:'((?:[^']|'')+)'|([^!#|]+))!)?(${RANGE}(?:\\s*,\\s*${RANGE})*)$`);

/**
 * Parse an embed subpath: `A1`, `A1:B2`, `Sheet1!A1:B2`, `'My sheet'!A1` or several ranges joined with
 * commas (`Sheet1!A1:C1,A7:C7`). Returns null when the subpath is not a cell reference (for example a
 * plain sheet name, which the spreadsheet's own embed handles).
 */
export function parseCellRef(subpath: string): CellRef | null {
  const text = subpath.trim().replace(/^#/, "").trim();
  const match = text.match(REF);
  if (!match) return null;
  const sheet = match[1] !== undefined ? match[1].replace(/''/g, "'") : match[2]?.trim();
  try {
    const ranges = match[3].split(",").map(part => parseSheetRange(part.trim()));
    return sheet ? { sheet, ranges } : { ranges };
  } catch { return null; }
}

/** `X.sheet#Sheet1!A1` → path and subpath. The alias part (`|…`) is dropped. */
export function splitEmbedLink(link: string): { path: string; subpath: string } {
  const noAlias = link.split("|")[0];
  const hash = noAlias.indexOf("#");
  return hash < 0 ? { path: noAlias.trim(), subpath: "" } : { path: noAlias.slice(0, hash).trim(), subpath: noAlias.slice(hash + 1).trim() };
}

/** Link text for a cell reference, quoting sheet names that contain spaces or punctuation. */
export function formatCellRef(ref: CellRef): string {
  const sheet = ref.sheet === undefined ? "" : /^[\w.-]+$/.test(ref.sheet) ? `${ref.sheet}!` : `'${ref.sheet.replace(/'/g, "''")}'!`;
  return sheet + ref.ranges.map(range => {
    const text = formatSheetRange(range);
    const [start, end] = text.split(":");
    return start === end ? start : text;
  }).join(",");
}

/** Where the spreadsheet view should go for a reference: 0-based rectangle plus optional tab name. */
export interface CellTarget { sheet?: string; sri: number; sci: number; eri: number; eci: number }

/**
 * The cells to select when a reference is opened in the spreadsheet. Several ranges (a header row and a
 * data row, as on person cards) select the last one; `block` picks another one, e.g. the double-clicked part.
 */
export function cellTarget(ref: CellRef, block = ref.ranges.length - 1): CellTarget | null {
  const range = ref.ranges[Math.max(0, Math.min(block, ref.ranges.length - 1))];
  if (!range) return null;
  const target = { sri: Math.min(range.sri, range.eri), sci: Math.min(range.sci, range.eci), eri: Math.max(range.sri, range.eri), eci: Math.max(range.sci, range.eci) };
  return ref.sheet === undefined ? target : { sheet: ref.sheet, ...target };
}

/** `#Sheet1!B4:C6` (a link subpath, with or without `#`) → target, or null when it is not a cell reference. */
export function cellTargetFromSubpath(subpath: string): CellTarget | null {
  const ref = parseCellRef(subpath);
  return ref ? cellTarget(ref) : null;
}

export function pickSheet(tables: SheetTable[], name?: string): SheetTable | undefined {
  if (!name) return tables[0];
  return tables.find(table => table.name === name) ?? tables.find(table => table.name.toLowerCase() === name.toLowerCase());
}

export interface CellBlock {
  range: SheetRange;
  /** Cell text; cells outside the populated area are empty strings. */
  rows: string[][];
}

/** Cells for each rectangle of a reference. Large rectangles are capped at `limit` rows. */
export function cellBlocks(table: SheetTable, ranges: SheetRange[], limit = 200): CellBlock[] {
  return ranges.map(range => {
    const rows: string[][] = [];
    for (let r = range.sri; r <= Math.min(range.eri, range.sri + limit - 1); r++) {
      const row = table.rows[r] ?? [];
      rows.push(Array.from({ length: range.eci - range.sci + 1 }, (_, c) => row[range.sci + c] ?? ""));
    }
    return { range, rows };
  });
}

/** Minimal RFC 4180 CSV reader (quotes, doubled quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === "") quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += char;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Where one imported row lives: the file, the sheet and the cells to show. */
export interface SourceCells {
  /** File path without the `#sheet` part. */
  path: string;
  sheet?: string;
  /** Header row first (when found), then the data row. */
  ranges: SheetRange[];
}

/** The parts of a record's `dataset`: `X.sheet.md#Sheet1@J1:L200` → path, sheet and selected range. */
export function datasetParts(dataset: string): { path: string; sheet?: string; range?: SheetRange } {
  const hash = dataset.indexOf("#");
  if (hash < 0) return { path: dataset };
  const path = dataset.slice(0, hash);
  const [sheet, selection] = dataset.slice(hash + 1).split("@");
  let range: SheetRange | undefined;
  if (selection) { try { range = parseSheetRange(selection); } catch { range = undefined; } }
  return range ? { path, sheet, range } : { path, sheet };
}

/**
 * Find the header and data cells of an imported row. `row` is the 0-based sheet row stored on the record
 * (range offsets already applied). `raw` maps the original header text to the cell value; it picks the
 * columns, so a sheet with several side-by-side sections (FOLLOWING / FOLLOWERS …) shows the right one.
 */
export function sourceCells(rows: string[][], record: { dataset: string; row: number; raw?: Record<string, string> }): SourceCells | null {
  const { path, sheet, range } = datasetParts(record.dataset);
  const data = rows[record.row];
  if (!data) return null;
  const minCol = range?.sci ?? 0, maxCol = range?.eci ?? Math.max(0, ...rows.map(row => row.length - 1));
  const top = range?.sri ?? 0;
  const all = Object.keys(record.raw ?? {}).filter(key => key.trim());
  // Section label columns (empty values) may sit in the row above the header; retry without them.
  const keySets = [all, all.filter(key => (record.raw?.[key] ?? "").trim())].filter((keys, i, sets) => keys.length && (i === 0 || keys.length !== sets[0].length));
  let best: { header: number; cols: number[]; score: number; span: number } | null = null;
  for (const keys of keySets) for (let header = record.row - 1; !best && header >= top; header--) {
    const line = rows[header] ?? [];
    const starts = [];
    for (let c = minCol; c <= maxCol; c++) if ((line[c] ?? "").trim() === keys[0].trim()) starts.push(c);
    for (const start of starts) {
      const cols = [start];
      for (const key of keys.slice(1)) {
        let found = -1;
        for (let c = cols[cols.length - 1] + 1; c <= maxCol; c++) if ((line[c] ?? "").trim() === key.trim()) { found = c; break; }
        if (found < 0) break;
        cols.push(found);
      }
      if (cols.length !== keys.length) continue;
      const score = keys.filter((key, i) => (data[cols[i]] ?? "").trim() === (record.raw?.[key] ?? "").trim()).length;
      const span = cols[cols.length - 1] - cols[0];
      // The nearest header row above the data wins; within it, the best matching columns.
      if (!best || score > best.score || (score === best.score && span < best.span)) best = { header, cols, score, span };
    }
  }
  if (best) {
    const sci = best.cols[0], eci = best.cols[best.cols.length - 1];
    return { path, sheet, ranges: [{ sri: best.header, eri: best.header, sci, eci }, { sri: record.row, eri: record.row, sci, eci }] };
  }
  // Older records keep no header names: use the populated part of the row, and as its header the first
  // row above it that fills at least half of those columns.
  let first = -1, last = -1;
  for (let c = minCol; c <= maxCol; c++) if ((data[c] ?? "").trim()) { if (first < 0) first = c; last = c; }
  if (first < 0) return null;
  const row = { sri: record.row, eri: record.row, sci: first, eci: last };
  for (let header = top; header < record.row; header++) {
    const filled = (rows[header] ?? []).slice(first, last + 1).filter(cell => cell.trim()).length;
    if (filled * 2 >= last - first + 1) return { path, sheet, ranges: [{ ...row, sri: header, eri: header }, row] };
  }
  return { path, sheet, ranges: [row] };
}
