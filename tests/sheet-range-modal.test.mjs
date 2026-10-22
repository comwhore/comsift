import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

class El {
  constructor(tag = "div", options = {}) { this.tag = tag; this.children = []; this.text = options.text ?? ""; this.value = options.value ?? ""; this.type = options.type ?? ""; this.disabled = false; this.checked = false; }
  createEl(tag, options = {}) { const el = new El(tag, options); this.children.push(el); if (this.tag === "select" && tag === "option" && !this.value) this.value = el.value; return el; }
  createDiv(options = {}) { return this.createEl("div", options); }
  createSpan(options = {}) { return this.createEl("span", options); }
  empty() { this.children = []; }
  setText(text) { this.text = text; }
  addClass() {}
  toggleClass() {}
  setAttr() {}
  all(match) { return this.children.flatMap(child => [...(match(child) ? [child] : []), ...child.all(match)]); }
  querySelector() { return this.all(el => el.tag === "input" && el.type === "checkbox")[0] ?? null; }
}
globalThis.sheetModalEl = () => new El();
async function load(entry) {
  const bundle = await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", write: false, plugins: [{ name: "stub", setup(b) {
    b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: 'export class Notice {} export function setIcon() {} export function setTooltip() {} export class Setting {} export class Modal { constructor(app) { this.app = app; this.contentEl = globalThis.sheetModalEl(); this.modalEl = globalThis.sheetModalEl(); } setTitle(t) { this.title = t; } open() { this.onOpen(); } close() { this.onClose(); } }' }));
  } }] });
  return import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].contents).toString("base64"));
}
const { SheetRangeModal, currentSheetSelection } = await load("src/analysis/sheetRangeModal.ts");
const { DatasetPickerModal } = await load("src/analysis/datasetModals.ts");
const tick = () => new Promise(resolve => setImmediate(resolve));
const tables = [{ name: "people.sheet.md#Accounts", rows: [["username", "bio", "", "username", "bio"], ["alice", "a", "", "alice_alt", "a"], ["bob", "b", "", "bob2", "b"]] }];
const leaf = (path, name, range) => ({ view: { file: { path }, cellsSelected: { sheet: { name }, ...range } } });
function plugin() {
  return { app: { workspace: { getLeavesOfType: () => [] } }, setting: { sheetRanges: "{}" }, analysis: { sheetTables: async () => tables }, saveSettings: async () => {} };
}
const element = (modal, tag) => modal.contentEl.all(el => el.tag === tag)[0];
const button = (modal, text) => modal.contentEl.all(el => el.tag === "button" && el.text === text)[0];

test("range modal prefills the matching workbook selection and expands only its selected columns", async () => {
  const p = plugin();
  p.app.workspace.getLeavesOfType = () => [leaf("other.sheet.md", "Accounts", { sri: 0, sci: 0, eri: 1, eci: 1 }), leaf("people.sheet.md", "Accounts", { sri: 1, sci: 3, eri: 1, eci: 4 })];
  const selected = currentSheetSelection(p, new Set([tables[0].name]));
  assert.equal(selected.name, tables[0].name);
  let saved = 0;
  const modal = new SheetRangeModal(p, ["people.sheet.md"], () => saved++);
  modal.open(); await tick();
  assert.equal(element(modal, "textarea").value, "D1:E3");
  assert.equal(element(modal, "input").checked, false);
  button(modal, "Save ranges").onclick(); await tick();
  assert.deepEqual(JSON.parse(p.setting.sheetRanges), { [tables[0].name]: ["D1:E3"] });
  assert.equal(saved, 1);
});

test("separate repeated-header rectangles persist and invalid ranges do not save", async () => {
  const p = plugin();
  let saves = 0; p.saveSettings = async () => saves++;
  const modal = new SheetRangeModal(p, ["people.sheet.md"], () => {});
  modal.open(); await tick();
  const whole = element(modal, "input"), input = element(modal, "textarea");
  assert.equal(whole.checked, true);
  whole.checked = false; whole.onchange();
  input.value = "A1:B3; D1:E3"; input.oninput();
  button(modal, "Save ranges").onclick(); await tick();
  assert.deepEqual(JSON.parse(p.setting.sheetRanges)[tables[0].name], ["A1:B3", "D1:E3"]);
  assert.equal(saves, 1);
  const invalid = new SheetRangeModal(p, ["people.sheet.md"], () => {});
  invalid.open(); await tick();
  element(invalid, "textarea").value = "A1:Z90";
  button(invalid, "Save ranges").onclick(); await tick();
  assert.equal(saves, 1);
  assert.deepEqual(JSON.parse(p.setting.sheetRanges)[tables[0].name], ["A1:B3", "D1:E3"]);
});

test("dataset picker accepts a single connection profile and collapses rectangle suffixes to their tab", async () => {
  const p = plugin();
  p.analysis.canonicalDatasetPaths = paths => paths;
  p.analysis.listDatasets = () => [{ path: "Person/Connections/alice.md" }, { path: "people.sheet.md" }];
  p.analysis.discoverColumns = async () => [{ name: "Person/Connections/alice.md", columns: ["username"] }, { name: "people.sheet.md#Accounts@A1:B3", columns: ["username", "bio"] }, { name: "people.sheet.md#Accounts@D1:E3", columns: ["username", "platform"] }];
  let selected;
  const modal = new DatasetPickerModal(p, ["Person/Connections/alice.md"], paths => { selected = paths; });
  modal.open(); await tick();
  const apply = modal.contentEl.all(el => el.tag === "button" && el.text.startsWith("Use "))[0];
  assert.equal(apply.disabled, false);
  apply.onclick();
  assert.deepEqual(selected, ["Person/Connections/alice.md"]);
  const tabModal = new DatasetPickerModal(p, ["people.sheet.md#Accounts"], paths => { selected = paths; });
  tabModal.open(); await tick();
  tabModal.contentEl.all(el => el.tag === "button" && el.text.startsWith("Use "))[0].onclick();
  assert.deepEqual(selected, ["people.sheet.md#Accounts"]);
});

test('range selection prefers the active eligible workbook over an older open selection', () => {
 const p=plugin();
 p.app.workspace.getActiveFile=()=>({path:'current.sheet.md'});
 p.app.workspace.getLeavesOfType=()=>[
  leaf('old.sheet.md','Accounts',{sri:0,sci:0,eri:1,eci:1}),
  leaf('current.sheet.md','Accounts',{sri:1,sci:3,eri:1,eci:4})];
 assert.equal(currentSheetSelection(p).name,'current.sheet.md#Accounts');
});

test("grid clicks build blocks and keep the typed ranges in sync", async () => {
  const p = plugin();
  const modal = new SheetRangeModal(p, ["people.sheet.md"], () => {});
  modal.open(); await tick();
  const input = element(modal, "textarea");
  button(modal, "D").onclick({ shiftKey: false });
  assert.equal(input.value, "D1:D3");
  assert.equal(element(modal, "input").checked, false);
  button(modal, "E").onclick({ shiftKey: true });
  assert.equal(input.value, "D1:E3");
  button(modal, "Add block").onclick();
  button(modal, "A").onclick({ shiftKey: false });
  button(modal, "B").onclick({ shiftKey: true });
  assert.equal(input.value, "D1:E3; A1:B3");
  button(modal, "2").onclick();
  assert.equal(input.value, "D1:E3; A2:B3");
  button(modal, "1").onclick();
  input.value = "D1:E3"; input.oninput();
  button(modal, "Save ranges").onclick(); await tick();
  assert.deepEqual(JSON.parse(p.setting.sheetRanges)[tables[0].name], ["D1:E3"]);
});
