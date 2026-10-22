import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const obsidian = `export class Component {
 constructor(){this.children=[];this.unloaded=0;}
 addChild(c){this.children.push(c);return c;}
 removeChild(c){this.children=this.children.filter(x=>x!==c);}
 unload(){this.unloaded++;}
}
export const setIcon=()=>{};
export const htmlToMarkdown=node=>node.markdown??node.text;
export const MarkdownRenderer={render:async (app,text,stage,path,owner)=>{globalThis.chatRenders.push({text,stage,path,owner}); await new Promise(resolve=>globalThis.chatRenderFinishes.push(resolve));stage.setText(text);}};`;
async function load(path) {
  const result = await build({ entryPoints: [path], bundle: true, platform: "node", format: "esm", write: false, plugins: [{ name: "render-boundary", setup(b) {
    b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
    b.onResolve({ filter: /^\.\/mermaid$/ }, () => ({ path: "mermaid", namespace: "mock" }));
    b.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ contents: args.path === "obsidian" ? obsidian : "export const normalizeMermaidMarkdown=text=>text;" }));
  } }] });
  return import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].contents).toString("base64"));
}
class El {
  constructor(tag="div",opts={}) { this.tag=tag; this.children=[]; this.style={}; this.listeners={}; this.scrollHeight=50; this.value=""; this.text=opts.text??"";this.cls=opts.cls??"";this.attrs={}; }
  createEl(tag,opts={}) { const child=new El(tag,opts);child.parent=this;this.children.push(child);return child; }
  createDiv(opts={}) { return this.createEl("div",opts); }
  empty() { for(const child of this.children) child.parent=null;this.children=[];this.text=""; }
  setText(text) { this.text=text; }
  setCssProps(props) {Object.assign(this.style,props); }
  remove() { if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);this.parent=null; }
  addEventListener(name,fn) {this.listeners[name]=fn;}
  focus(){this.focused=true;}
  getBoundingClientRect(){return {width:240};}
  addClass(name){this.cls += ' '+name;}
  removeClass(name){this.cls=this.cls.split(' ').filter(c=>c!==name).join(' ');}
  setAttribute(name,value){this.attrs[name]=value;}
  removeAttribute(name){delete this.attrs[name];}
  removeEventListener(name,fn){if(this.listeners[name]===fn)delete this.listeners[name];}
  querySelector(selector){return this.children.find(child=>child.cls.split(' ').includes(selector.slice(1)))??null;}
  setSelectionRange(){}
}
const { inlinePromptEditor, errorDetails } = await load("src/analysis/chatUi.ts");
const { chatMarkdown } = await load("src/analysis/chatMarkdown.ts");
test("prompt editor preserves rendered elements and geometry, remains single and supports cancel/send", () => {
  const host=new El();const body=host.createDiv({cls:"comsift-markdown-body"});const paragraph=body.createEl("p",{text:"Original"});
  let restored=0,submitted="",cleared=0;
  const open=inlinePromptEditor(host,()=>"**Original**",()=>{restored++;},text=>{submitted=text;return true;},()=>cleared++);
  open();assert.equal(host.children[0],body);assert.equal(body.children[0],paragraph);
  assert.equal(body.attrs.contenteditable,"plaintext-only");assert.equal(host.style.width,"240px");
  assert.ok(!host.children.some(child=>child.tag==="textarea"));
  open();assert.equal(host.children[0],body);assert.equal(cleared,1);assert.equal(host.children.length,2);
  host.children[1].children[1].onclick();assert.equal(restored,1);assert.equal(body.attrs.contenteditable,undefined);assert.equal(host.style.width,undefined);
  open();host.children[1].children[0].onclick();assert.equal(submitted,"**Original**");
  open();body.markdown="Changed";body.listeners.input();host.children[1].children[0].onclick();assert.equal(submitted,"Changed");assert.equal(restored,3);
});
test("Markdown render owns embeds, unloads previous children and ignores stale completions", async () => {
  globalThis.chatRenders=[];globalThis.chatRenderFinishes=[];
  const owner={children:[],addChild(c){this.children.push(c);},removeChild(c){this.children=this.children.filter(x=>x!==c);}};
  const host=new El();
  const render=chatMarkdown({},host,"Person/Board.canvas",owner);
  render.setMarkdown("**old**");const first=globalThis.chatRenders[0];
  render.setText("![[Board.canvas#real-id]]");const second=globalThis.chatRenders[1];
  assert.equal(first.owner.unloaded,1);assert.equal(owner.children.length,1);assert.equal(second.path,"Person/Board.canvas");
  globalThis.chatRenderFinishes[0]();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(host.children[0],second.stage);assert.equal(first.stage.parent,null);assert.equal(first.owner.unloaded,2);
  globalThis.chatRenderFinishes[1]();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(second.stage.text,"![[Board.canvas#real-id]]");
  render.dispose();assert.equal(owner.children.length,0);assert.equal(second.owner.unloaded,1);
});
test("opening another message editor restores the previous message within the same chat", () => {
  const scope={}, first=new El(),second=new El();let restored=0;
  const a=inlinePromptEditor(first,()=>"A",()=>{restored++;first.empty();first.createEl("p",{text:"A"});},()=>true,()=>{},scope);
  const b=inlinePromptEditor(second,()=>"B",()=>{},()=>true,()=>{},scope);
  a();b();assert.equal(restored,1);assert.equal(first.children[0].tag,"p");assert.equal(second.attrs.contenteditable,"plaintext-only");
  b.dispose();a();assert.equal(first.attrs.contenteditable,"plaintext-only");
});

test("error diagnostics omit redundant messages and full-trace duplicates", () => {
  const host = new El();
  assert.equal(errorDetails(host, new Error("Unavailable")), null);
  assert.equal(errorDetails(host, { message: "Unavailable", body: "Unavailable" }), null);
  assert.equal(host.children.length, 0);
  assert.ok(errorDetails(host, { message: "Unavailable", status: 503, body: "upstream unavailable" }));
  assert.equal(host.children.length, 1);
  assert.equal(errorDetails(host, { message: "Unavailable", status: 503 }, true), null);
  assert.equal(host.children.length, 1);
});
