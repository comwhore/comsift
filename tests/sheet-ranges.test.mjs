import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const output = await build({ entryPoints: ['src/analysis/sheetRanges.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { parseSheetRange, formatSheetRange, rangeRows, autoSheetRange, readSheetRanges } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].contents).toString('base64'));
const table = { name: 'People', rows: [
 ['FOLLOWING','Display name','Username','Profile link','IN COMMON','Display name','Username','Profile link'],
 ['', 'Alice', 'alice', 'https://example.test/alice', '', 'Bob', 'bob', 'https://example.test/bob'],
 ['', 'Carol', 'carol', '', '', 'Dave', 'dave', ''],
] };
test('rectangular ranges select the requested occurrence of repeated headers', () => {
 const range = parseSheetRange('F1:H3');
 assert.equal(formatSheetRange(range), 'F1:H3');
 assert.deepEqual(rangeRows(table, range), [['Display name','Username','Profile link'], ['Bob','bob','https://example.test/bob'], ['Dave','dave','']]);
 assert.throws(() => parseSheetRange('H3:F1'), /Invalid/);
 assert.throws(() => rangeRows(table, parseSheetRange('F1:H99')), /beyond/);
});
test('current selection expands to the correct header and remaining rows only in selected columns', () => {
 assert.deepEqual(autoSheetRange(table, { sri:1,sci:5,eri:1,eci:7 }), { sri:0,sci:5,eri:2,eci:7 });
 assert.deepEqual(readSheetRanges('{"sheet#People":["$F$1:$H$3"]}'), {'sheet#People':['F1:H3']});
 assert.throws(() => readSheetRanges('{"bad":true}'), /lists/);
});
const { normalizeRect, headerRowOf, lastDataRow, sheetColumns, rangeColumnNames, columnsToRange, toggleColumn, columnLetter } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].contents).toString('base64'));
test('dragging in any direction gives the same rectangle', () => {
 const expected = { sri: 1, sci: 2, eri: 4, eci: 5 };
 assert.deepEqual(normalizeRect({ row: 1, col: 2 }, { row: 4, col: 5 }), expected);
 assert.deepEqual(normalizeRect({ row: 4, col: 5 }, { row: 1, col: 2 }), expected);
 assert.deepEqual(normalizeRect({ row: 4, col: 2 }, { row: 1, col: 5 }), expected);
 assert.deepEqual(normalizeRect({ row: 3, col: 3 }, { row: 3, col: 3 }), { sri: 3, sci: 3, eri: 3, eci: 3 });
});
test('column names convert to ranges and back, picking the repeated block requested', () => {
 assert.equal(headerRowOf(table), 0);
 assert.equal(headerRowOf({ name: 'T', rows: [['Report'], ['Username', 'Bio'], ['alice', 'hi']] }), 1);
 assert.deepEqual(sheetColumns(table, 0).slice(0, 2), [{ index: 0, letter: 'A', name: 'FOLLOWING' }, { index: 1, letter: 'B', name: 'Display name' }]);
 assert.deepEqual(columnsToRange(table, ['Username', 'Display name']), { sri: 0, sci: 1, eri: 2, eci: 2 });
 assert.deepEqual(columnsToRange(table, ['Display name', 'Username', 'Profile link'], 0, 4), parseSheetRange('F1:H3'));
 assert.deepEqual(columnsToRange(table, ['g', 'h']), parseSheetRange('G1:H3'));
 assert.deepEqual(rangeColumnNames(table, parseSheetRange('F1:H3')), ['Display name', 'Username', 'Profile link']);
 assert.deepEqual(rangeColumnNames({ name: 'T', rows: [['a', '', 'c'], ['1', '2', '3']] }, parseSheetRange('A1:C2')), ['a', 'B', 'c']);
 assert.throws(() => columnsToRange(table, ['Display name', 'Profile link']), /next to each other/);
 assert.throws(() => columnsToRange(table, ['Email']), /No column named Email/);
 assert.throws(() => columnsToRange(table, []), /at least one/);
});
test('data rows end at the first empty row below the header', () => {
 const gappy = { name: 'T', rows: [['Username'], ['alice'], ['bob'], [''], ['Totals']] };
 assert.equal(lastDataRow(gappy, 0, 0, 0), 2);
 assert.equal(lastDataRow({ name: 'T', rows: [['Username']] }, 0, 0, 0), 0);
 assert.equal(lastDataRow(table, 0, 5, 7), 2);
});
test('toggling columns grows a block or trims its edges, never splits it', () => {
 const range = parseSheetRange('B1:D3');
 assert.equal(formatSheetRange(toggleColumn(range, 5)), 'B1:F3');
 assert.equal(formatSheetRange(toggleColumn(range, 0)), 'A1:D3');
 assert.equal(formatSheetRange(toggleColumn(range, 1)), 'C1:D3');
 assert.equal(formatSheetRange(toggleColumn(range, 3)), 'B1:C3');
 assert.equal(toggleColumn(range, 2), null);
 assert.equal(toggleColumn(parseSheetRange('B1:B3'), 1), null);
 assert.equal(columnLetter(27), 'AB');
});
