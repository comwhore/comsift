// Pure helpers: .sheet.md (x-spreadsheet JSON) → CSV.

export interface SheetTable { name: string; rows: string[][] }

type Cells = Record<string, { text?: unknown } | undefined>;
interface RawSheet { name?: string; rows?: Record<string, { cells?: Cells } | number | undefined> }

export function isSheetPath(path: string): boolean {
  return path.toLowerCase().endsWith(".sheet.md");
}

/** Parse the JSON array that follows the managed heading of a .sheet.md file. Returns [] when unparseable. */
export function parseSheetMd(text: string): SheetTable[] {
  const start = text.search(/^\[/m);
  if (start === -1) return [];
  let data: unknown;
  try { data = JSON.parse(text.slice(start).trim()); } catch { return []; }
  if (!Array.isArray(data)) return [];
  const tables: SheetTable[] = [];
  (data as RawSheet[]).forEach((sheet, index) => {
    if (!sheet || typeof sheet !== "object" || !sheet.rows || typeof sheet.rows !== "object") return;
    const grid = new Map<number, Map<number, string>>();
    let width = 0;
    for (const [rowKey, row] of Object.entries(sheet.rows)) {
      const r = Number(rowKey);
      if (!Number.isInteger(r) || !row || typeof row !== "object" || !row.cells) continue;
      for (const [colKey, cell] of Object.entries(row.cells)) {
        const c = Number(colKey);
        const raw: unknown = cell?.text;
        const value = typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean" ? String(raw) : "";
        if (!Number.isInteger(c) || value === "") continue;
        if (!grid.has(r)) grid.set(r, new Map());
        grid.get(r)!.set(c, value);
        width = Math.max(width, c + 1);
      }
    }
    if (!grid.size) return;
    const height = Math.max(...grid.keys()) + 1;
    const rows: string[][] = [];
    for (let r = 0; r < height; r++) {
      rows.push(Array.from({ length: width }, (_, c) => grid.get(r)?.get(c) ?? ""));
    }
    tables.push({ name: (sheet.name || `sheet${index + 1}`).trim(), rows });
  });
  return tables;
}

export function toCsv(rows: string[][]): string {
  const cell = (value: string) => /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return rows.map(row => row.map(cell).join(",")).join("\n") + "\n";
}

export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|#]/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "sheet";
}
