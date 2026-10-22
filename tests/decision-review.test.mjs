import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

class El {
  constructor(tag = "div") { this.tag = tag; this.children = []; this.text = ""; this.cls = ""; this.scrollTop = 0; this.dataset = {}; this.attributes = {}; this.parentElement = null; this.isConnected = true; this.classList = { contains: name => this.cls.split(" ").includes(name) }; }
  get className() { return this.cls; }
  set className(value) { this.cls = value; }
  createEl(tag, options = {}) { const el = new El(tag); el.text = options.text ?? ""; el.cls = options.cls ?? ""; el.value = options.value ?? ""; el.type = options.type; el.parentElement = this; for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value); this.children.push(el); return el; }
  createDiv(options = {}) { return this.createEl("div", options); }
  createSpan(options = {}) { return this.createEl("span", options); }
  empty() { for (const child of this.children) { child.parentElement = null; child.isConnected = false; } this.children = []; }
  addClass(...names) { this.cls = [...new Set([...this.cls.split(" ").filter(Boolean), ...names])].join(" "); }
  setAttribute(key, value) { this.attributes[key] = String(value); if (key.startsWith("data-")) this.dataset[key.slice(5)] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; this.isConnected = false; }
  before() {}
  matches(selector) { if (selector === "details[data-choice]") return this.tag === "details" && this.dataset.choice !== undefined; if (selector.startsWith(".")) return selector.slice(1).split(".").every(name => this.cls.split(" ").includes(name)); return this.tag === selector; }
  querySelector(selector) { return this.find(el => el.matches(selector)); }
  querySelectorAll(selector) { return this.all(el => el.matches(selector)); }
  find(match) { for (const child of this.children) { if (match(child)) return child; const found = child.find(match); if (found) return found; } return null; }
  all(match, out = []) { for (const child of this.children) { if (match(child)) out.push(child); child.all(match, out); } return out; }
}
const bundle = await build({ entryPoints: ["src/analysis/decisionReview.ts"], bundle: true, platform: "node", format: "esm", write: false, plugins: [{ name: "stub", setup(b) {
  b.onResolve({filter:/^\.\/reviewSessions$/},()=>({path:"sessions",namespace:"sessions"}));
  b.onLoad({filter:/.*/,namespace:"sessions"},()=>({contents:"globalThis.liveReviewSessions=new Map(); let next=0; export function registerReviewSession(session){const id='review-'+(++next);globalThis.liveReviewSessions.set(id,session);return id;} export function forgetReviewSession(id){globalThis.liveReviewSessions.delete(id);}"}));
  b.onResolve({filter:/^\.\/chatMarkdown$/},()=>({path:"renderer",namespace:"renderer"}));
  b.onLoad({filter:/.*/,namespace:"renderer"},()=>({contents:"export function chatMarkdown(app,host,path,owner){ return {setMarkdown(text){globalThis.summaryMarkdown=text;host.text=text;},dispose(){globalThis.summaryDisposals=(globalThis.summaryDisposals??0)+1;}};}"}));
  b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
  b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export class Notice {} export function setIcon() {} export class Component { load(){} unload(){} addChild(){} removeChild(){} } export class Modal { constructor(app) { this.app = app; this.contentEl = globalThis.makeEl(); this.modalEl = globalThis.makeEl(); } setTitle(t) { this.title = t; } open() { this.onOpen(); } close() { this.onClose(); } }" }));
} }] });
globalThis.makeEl = () => new El();
globalThis.document = {createElement: tag => new El(tag)};
const { DecisionReviewModal } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].contents).toString("base64"));

const record = (id, username) => ({ id, fields: { username } });
const entry = { source: record("s", "alice"), candidates: [record("a", "alice1"), record("b", "alice2")],
  reasoned: { decision: { candidate_id: "a", explanation: "x", supporting_evidence: [], conflicting_evidence: [], uncertain: false,
    verdicts: [{ candidate_id: "a", verdict: "same", reason: "r" }, { candidate_id: "b", verdict: "different", reason: "r" }] } } };

const active = modal => modal.contentEl.all(el => el.cls.split(" ").includes("comsift-review-row"))
  .map(card => card.all(el => el.tag === "button" && el.cls.includes("is-active")).map(button => button.text).join());
const press = (modal, card, label) => modal.contentEl.all(el => el.cls.split(" ").includes("comsift-review-row"))[card].all(el => el.tag === "button").find(button => button.text === label).onclick();

test("each candidate starts from its own verdict and can be changed on its own card", () => {
  const modal = new DecisionReviewModal({}, [entry], "Ollama", () => {});
  modal.open();
  assert.deepEqual(active(modal), ["Same person", "Rejected"]);
  press(modal, 1, "Same person");
  press(modal, 0, "Later");
  assert.deepEqual(active(modal), ["Later", "Same person"]);
  assert.ok(!modal.contentEl.all(el => el.tag === "button").some(button => button.text.startsWith("Reset")));
});

test("Reject N decisions discards everything, while closing the window only keeps it for later", () => {
  const log = [];
  const modal = new DecisionReviewModal({}, [entry], "Ollama", () => log.push("confirm"), () => log.push("kept"), ids => log.push(["reject", ids]));
  modal.open();
  const button = modal.contentEl.all(el => el.tag === "button").find(el => /^Reject \d+ decisions?$/.test(el.text));
  assert.equal(button.text, "Reject 2 decisions");
  button.onclick();
  assert.deepEqual(log, [["reject", ["s"]]]);
  const other = new DecisionReviewModal({}, [entry], "Ollama", () => log.push("confirm"), () => log.push("kept"), () => log.push("rejected again"));
  other.open(); other.close();
  assert.deepEqual(log.slice(1), ["kept"]);
});

test("summary and AI decisions omit bulk status buttons and keep per-candidate Later", () => {
  const modal = new DecisionReviewModal({}, [entry], "Ollama", () => {});
  modal.open();
  assert.ok(!active(modal).some(label => label.includes("Later")));
  const buttons = modal.contentEl.all(el => el.tag === "button");
  assert.ok(!buttons.some(button => ["Review all later", "Mark all uncertain"].includes(button.text)));
  press(modal, 0, "Later");
  assert.deepEqual(active(modal), ["Later", "Rejected"]);
});

test("Cancel keeps staged statuses without applying choices", () => {
  const kept = [], applied = [];
  const choices = entry.candidates.map(candidate => ({ source: entry.source, candidate, status: "related", reasoned: entry.reasoned, reason: "chosen" }));
  const modal = new DecisionReviewModal({}, [], "AI", values => applied.push(values), values => kept.push(values), undefined, choices, undefined, undefined, "ai");
  modal.open();
  press(modal, 0, "Uncertain");
  modal.contentEl.all(el => el.tag === "button").find(el => el.text === "Cancel").onclick();
  assert.equal(applied.length, 0);
  assert.deepEqual(kept[0].map(choice => choice.status), ["uncertain", "related"]);
});

test("AI summary uses Markdown renderer and disposes it on close", async () => {
  globalThis.summaryDisposals=0;
  const markdown="## Summary\n\n```mermaid\ngraph TD\n A-->B\n```";
  const modal=new DecisionReviewModal({},[entry],"Summary",()=>{},undefined,undefined,undefined,async()=>markdown);
  modal.open();
  const button=modal.contentEl.all(el=>el.tag==="button").find(el=>el.text==="Summarize with AI");
  await button.onclick();assert.equal(globalThis.summaryMarkdown,markdown);
  assert.ok(modal.contentEl.find(el=>el.cls.includes("comsift-review-ai-summary")&&el.cls.includes("markdown-rendered")));
  modal.close();assert.equal(globalThis.summaryDisposals,1);
});
test("late summary completion cannot update a closed modal", async () => {
  let resolve;const pending=new Promise(done=>{resolve=done;});
  const modal=new DecisionReviewModal({},[entry],"Summary",()=>{},undefined,undefined,undefined,()=>pending);
  modal.open();const button=modal.contentEl.all(el=>el.tag==="button").find(el=>el.text==="Summarize with AI");
  const running=button.onclick();modal.close();globalThis.summaryMarkdown="unchanged";resolve("late answer");await running;
  assert.equal(globalThis.summaryMarkdown,"unchanged");
});

test('expand opens the overall review and the removed copy button stays absent',async()=>{
 const opened=[];
 const app={workspace:{getLeaf:kind=>{assert.equal(kind,'tab');return {setViewState:async state=>opened.push(state)};}}};

 const modal=new DecisionReviewModal(app,[entry],'AI',()=>{},undefined,undefined,undefined,async()=> '## Why\n\nShared username.');
 modal.onOpen();
 const buttons=modal.contentEl.all(el=>el.tag==='button');
 await buttons.find(el=>el.text==='Summarize with AI').onclick();
 assert.equal(buttons.find(el=>el.text==='Copy AI summary'), undefined);
 modal.modalEl.children.find(el=>el.className?.includes('comsift-summary-expand')).onclick();
 assert.equal(opened[0].type,'comsift-review-summary');
 assert.match(opened[0].state.markdown,/alice1/);assert.match(opened[0].state.markdown,/Shared username/);
 modal.onClose();
});

test('closing and reopening retains choices and even a summary completed while hidden', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const modal = new DecisionReviewModal({}, [entry], 'AI', () => {}, undefined, undefined, undefined, () => pending);
  modal.open();
  modal.contentEl.all(el => el.tag === 'button').find(el => el.text === 'Related').onclick();
  const running = modal.contentEl.all(el => el.tag === 'button').find(el => el.text === 'Summarize with AI').onclick();
  modal.close();
  resolve('Retained summary');
  await running;
  modal.open();
  assert.equal(globalThis.summaryMarkdown, 'Retained summary');
  assert.ok(modal.contentEl.all(el => el.tag === 'button').some(el => el.text === 'Related' && el.cls === 'is-active'));
  modal.close();
});

test('AI review hides expand; summary hides Cancel; closing never confirms either mode', () => {
  for (const mode of ['ai', 'summary']) {
    let applied = 0;
    const modal = new DecisionReviewModal({}, [entry], mode, () => applied++, undefined, undefined, undefined, undefined, undefined, mode);
    modal.open();
    const expand = modal.modalEl.children.find(el => el.className?.includes('comsift-summary-expand'));
    assert.equal(!!expand, mode === 'summary');
    assert.equal(modal.contentEl.all(el => el.tag === 'button').some(el => el.text === 'Cancel'), mode === 'ai');
    press(modal, 0, 'Related');
    modal.close();
    assert.equal(applied, 0);
    modal.open();
    assert.equal(active(modal)[0], 'Related');
    modal.close();
    assert.equal(applied, 0);
  }
});

test('review footers do not contain the reassessment launch button', () => {
 for(const mode of ['ai','summary']) {
  const tools={model:'demo',prompt:'Compare evidence',redecide:async choices=>choices};
  const modal=new DecisionReviewModal({},[entry],mode,()=>{},undefined,undefined,undefined,undefined,undefined,mode,tools);
  modal.open();
  assert.equal(modal.contentEl.all(el=>el.tag==='button').some(el=>el.text==='Redecide with AI'),false);
  modal.close();
 }
});

const button = (modal, label) => modal.contentEl.all(el => el.tag === "button").find(el => el.text === label);
const rows = modal => modal.contentEl.querySelectorAll(".comsift-review-row");

test('status chips filter cards and AI summary input without discarding hidden choices', async () => {
  const summarized = [], confirmed = [];
  const modal = new DecisionReviewModal({}, [entry], 'Summary', choices => confirmed.push(choices), undefined, undefined, undefined,
    async choices => { summarized.push(choices); return 'Only visible decisions.'; });
  modal.open();
  button(modal, '1 same person').onclick();
  assert.deepEqual(active(modal), ['Rejected']);
  assert.equal(button(modal, '1 same person').getAttribute('aria-pressed'), 'false');
  assert.equal(button(modal, 'Confirm visible (1)').disabled, false);
  await button(modal, 'Summarize with AI').onclick();
  assert.deepEqual(summarized[0].map(choice => choice.candidate.id), ['b']);
  await button(modal, 'Confirm 2 decisions').onclick();
  assert.deepEqual(confirmed[0].map(choice => choice.candidate.id), ['a', 'b']);
});

test('Confirm visible applies only displayed choices and leaves hidden choices available', async () => {
  const confirmed = [];
  const modal = new DecisionReviewModal({}, [entry], 'Summary', choices => confirmed.push(choices));
  modal.open();
  button(modal, '1 rejected').onclick();
  await button(modal, 'Confirm visible (1)').onclick();
  assert.deepEqual(confirmed[0].map(choice => choice.candidate.id), ['a']);
  assert.equal(rows(modal).length, 0);
  assert.ok(button(modal, 'Confirm 1 decisions'));
  button(modal, '1 rejected').onclick();
  assert.deepEqual(active(modal), ['Rejected']);
  await button(modal, 'Confirm 1 decisions').onclick();
  assert.deepEqual(confirmed[1].map(choice => choice.candidate.id), ['b']);
});

test('pending confirmation shows spinner, disables confirmations and blocks closing until save finishes', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  let cancelled = 0, saves = 0;
  const modal = new DecisionReviewModal({}, [entry], 'Summary', () => { saves++; return pending; }, () => cancelled++);
  modal.open();
  button(modal, '1 rejected').onclick();
  const saving = button(modal, 'Confirm visible (1)').onclick();
  const visible = button(modal, 'Confirm visible (1)');
  assert.equal(visible.disabled, true);
  assert.equal(visible.getAttribute('aria-busy'), 'true');
  assert.ok(visible.querySelector('.comsift-review-spinner'));
  assert.equal(button(modal, 'Confirm 2 decisions').disabled, true);
  await button(modal, 'Confirm 2 decisions').onclick();
  assert.equal(saves, 1);
  modal.close();
  assert.equal(cancelled, 0);
  assert.equal(rows(modal).length, 1);
  resolve(); await saving;
  assert.equal(button(modal, 'Confirm 1 decisions').disabled, false);
  button(modal, '1 rejected').onclick();
  assert.deepEqual(active(modal), ['Rejected']);
});

test('failed confirmation keeps choices and allows retry after removing spinner', async () => {
  const modal = new DecisionReviewModal({}, [entry], 'Summary', async () => { throw new Error('Save failed'); });
  modal.open();
  await button(modal, 'Confirm 2 decisions').onclick();
  assert.deepEqual(active(modal), ['Same person', 'Rejected']);
  assert.equal(button(modal, 'Confirm 2 decisions').disabled, false);
  assert.equal(button(modal, 'Confirm 2 decisions').querySelector('.comsift-review-spinner'), null);
  assert.equal(modal.contentEl.querySelector('.comsift-error').text, 'Save failed');
});

test('changing a verdict preserves scroll ancestors, list position and expanded reasoning', () => {
  const modal = new DecisionReviewModal({}, [entry], 'Summary', () => {});
  const ancestor = new El(); modal.contentEl.parentElement = ancestor;
  modal.open();
  ancestor.scrollTop = 450; modal.contentEl.scrollTop = 320;
  modal.contentEl.querySelector('.comsift-review-list').scrollTop = 225;
  const details = modal.contentEl.querySelectorAll('details[data-choice]'); details[1].open = true;
  press(modal, 1, 'Related');
  assert.equal(ancestor.scrollTop, 450);
  assert.equal(modal.contentEl.scrollTop, 320);
  assert.equal(modal.contentEl.querySelector('.comsift-review-list').scrollTop, 225);
  const updated = modal.contentEl.querySelectorAll('details[data-choice]');
  assert.equal(updated[0].open, false); assert.equal(updated[1].open, true);
});

test('late AI summary cannot restore stale decisions after a status change', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const modal = new DecisionReviewModal({}, [entry], 'Summary', () => {}, undefined, undefined, undefined, () => pending);
  modal.open();
  const summarizing = button(modal, 'Summarize with AI').onclick();
  press(modal, 0, 'Related');
  resolve('Stale same-person summary'); await summarizing;
  assert.equal(button(modal, 'Summarize with AI').disabled, false);
  modal.close(); modal.open();
  assert.equal(modal.contentEl.querySelector('.comsift-review-ai-summary').text, '');
  assert.equal(button(modal, 'Summarize with AI').disabled, false);
});

test('fullscreen moves a pending save to a live tab and finishes without a second application', async () => {
  let resolve, mountedId, saves = 0, cancelled = 0;
  const pending = new Promise(done => { resolve = done; });
  const host = new El();
  const app = {workspace: {getLeaf: kind => {
    assert.equal(kind, 'tab');
    return {setViewState: async state => {
      mountedId = state.state.reviewId;
      globalThis.liveReviewSessions.get(mountedId).mount(host);
    }};
  }}};
  const modal = new DecisionReviewModal(app, [entry], 'Summary', () => { saves++; return pending; }, () => cancelled++);
  modal.open();
  const saving = button(modal, 'Confirm 2 decisions').onclick();
  modal.modalEl.querySelector('.comsift-summary-expand').onclick();
  await Promise.resolve(); await Promise.resolve();
  const tab = {contentEl: host};
  assert.equal(modal.contentEl.children.length, 0);
  assert.deepEqual(active(tab), ['Same person', 'Rejected']);
  assert.equal(button(tab, 'Confirm 2 decisions').disabled, true);
  assert.ok(button(tab, 'Confirm 2 decisions').querySelector('.comsift-review-spinner'));
  await button(tab, 'Confirm 2 decisions').onclick();
  assert.equal(saves, 1); assert.equal(cancelled, 0);
  resolve(); await saving;
  assert.equal(host.children[0].text, 'Decisions saved.');
  assert.equal(host.all(el => el.tag === 'button').length, 0);
  assert.equal(saves, 1);
  globalThis.liveReviewSessions.get(mountedId).unmount();
  assert.equal(globalThis.liveReviewSessions.has(mountedId), false);
});

test('Redecide starts with all five categories selected and sends all current choices', async () => {
  const calls = [];
  const tools = {model:'original-model', prompt:'Original instructions', redecide:async (choices, options) => {
    calls.push({choices, options}); return [];
  }};
  const modal = new DecisionReviewModal({}, [entry], 'AI', () => {}, undefined, undefined, undefined, undefined, undefined, 'ai', tools);
  modal.open(); modal.openReassessment();
  const boxes = modal.contentEl.all(el => el.tag === 'input' && el.type === 'checkbox');
  assert.equal(boxes.length, 5); assert.ok(boxes.every(box => box.checked));
  await button(modal, 'Run reassessment').onclick();
  assert.deepEqual(calls[0].choices.map(choice => choice.candidate.id), ['a', 'b']);
  assert.deepEqual(calls[0].options, {model:'original-model', prompt:'Original instructions'});
  assert.deepEqual(active(modal), ['Same person', 'Rejected']);
});

test('Redecide passes selected categories and edited model/prompt while preserving other pairs', async () => {
  const calls = [];
  const tools = {model:'original-model', prompt:'Original instructions', redecide:async (choices, options) => {
    calls.push({choices, options});
    return [{...choices[0], status:'related', reason:'Shared distinctive biography.'},
      {...choices[0], candidate:record('unknown', 'unrequested'), status:'confirmed'}];
  }};
  const modal = new DecisionReviewModal({}, [entry], 'AI', () => {}, undefined, undefined, undefined, undefined, undefined, 'ai', tools);
  modal.open(); modal.openReassessment();
  const panel = modal.contentEl.querySelector('.comsift-redecide-settings');
  const boxes = panel.all(el => el.tag === 'input' && el.type === 'checkbox');
  boxes.forEach((box, index) => { box.checked = index === 3; box.onchange(); });
  const model = panel.all(el => el.tag === 'input' && el.type === 'text')[0];
  model.value = 'better-model'; model.oninput();
  const prompt = panel.querySelector('textarea'); prompt.value = 'Reconsider family links carefully.'; prompt.oninput();
  await button(modal, 'Run reassessment').onclick();
  assert.deepEqual(calls[0].choices.map(choice => choice.candidate.id), ['b']);
  assert.deepEqual(calls[0].options, {model:'better-model', prompt:'Reconsider family links carefully.'});
  assert.deepEqual(active(modal), ['Same person', 'Related']);
  assert.equal(rows(modal).length, 2);
  assert.ok(rows(modal)[1].all(el => el.text === 'Shared distinctive biography.').length);
});
