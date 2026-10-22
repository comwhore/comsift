import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const mock = [
  "export class TFile { constructor(path, content = '') { this.path = path; this.content = content; this.stat = { size: content.length, mtime: Date.now() }; }",
  "get name() { return this.path.split('/').at(-1); } get basename() { return this.name.replace(/\\.[^.]+$/, ''); } get extension() { return this.name.split('.').at(-1); } }",
  "export class TFolder { constructor(path) { this.path = path; } get name() { return this.path.split('/').at(-1); } }",
  "export class Modal {} export class Notice {} export class Setting {}",
  "export const normalizePath = path => path;",
  "globalThis.__obsidianMock = { TFile, TFolder };",
].join("\n");
const bundle = await build({
  entryPoints: ["src/service/investigation.ts"], bundle: true, platform: "node", format: "esm", write: false,
  plugins: [{ name: "obsidian-mock", setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
    build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: mock, loader: "js" }));
  } }],
});
const { InvestigationService } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].contents).toString("base64"));
const { TFile, TFolder } = globalThis.__obsidianMock;

class Vault {
  constructor() { this.files = new Map(); this.listeners = new Map(); this.renameCount = 0; }
  on(name, handler) { (this.listeners.get(name) ?? this.listeners.set(name, []).get(name)).push(handler); return {}; }
  emit(name, ...args) { for (const handler of this.listeners.get(name) ?? []) handler(...args); }
  getAbstractFileByPath(path) { return this.files.get(path) ?? null; }
  getFileByPath(path) { const found = this.files.get(path); return found instanceof TFile ? found : null; }
  getFolderByPath(path) { const found = this.files.get(path); return found instanceof TFolder ? found : null; }
  async createFolder(path) { if (this.files.has(path)) throw Error("Collision"); this.files.set(path, new TFolder(path)); }
  async create(path, content) { if (this.files.has(path)) throw Error("Collision"); const file = new TFile(path, content); this.files.set(path, file); return file; }
  async copy(file, path) { return this.create(path, file.content); }
  async read(file) { return file.content; }
  async process(file, transform) { file.content = transform(file.content); this.emit("modify", file); }
  async rename(file, path) {
    if (this.files.has(path)) throw Error("Collision");
    const oldPath = file.path;
    this.files.delete(oldPath);
    file.path = path;
    this.files.set(path, file);
    if (file instanceof TFolder) {
      for (const [childPath, child] of [...this.files]) {
        if (!childPath.startsWith(oldPath + "/")) continue;
        this.files.delete(childPath);
        child.path = path + childPath.slice(oldPath.length);
        this.files.set(child.path, child);
      }
    }
    this.renameCount++;
    this.emit("rename", file, oldPath);
  }
}

function setup() {
  const vault = new Vault();
  const plugin = {
    app: { vault, fileManager: { renameFile: (file, path) => vault.rename(file, path) } },
    setting: { usersFolder: "Comsift/Users" },
    state: { investigations: {} },
    graph: { refreshInvestigation: async () => {} },
    saveState: async () => {},
    registerEvent: () => {},
  };
  return { vault, plugin, service: new InvestigationService(plugin) };
}
test("export directory uses the system home or configured default and remembers successful edits", async () => {
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const { plugin, service } = setup();
  const item = { id: "export-test", folderPath: "People/Example" };
  let saves = 0;
  plugin.saveSettings = async () => { saves++; };
  const destinations = [];
  service.exportFolder = async (_item, destination) => { destinations.push(destination); };
  assert.equal(await service.exportToDirectory(item, ""), join(homedir(), "Example"));
  assert.equal(plugin.setting.lastExportDirectory, homedir());
  plugin.setting.defaultExportDirectory = join(homedir(), "Exports");
  assert.equal(await service.exportToDirectory(item, "  "), join(homedir(), "Exports", "Example"));
  const custom = join(homedir(), "Another export directory");
  assert.equal(await service.exportToDirectory(item, ` ${custom}/ `), join(custom, "Example"));
  assert.equal(plugin.setting.lastExportDirectory, custom);
  assert.equal(saves, 3);
  assert.equal(destinations.length, 3);
  await assert.rejects(service.exportToDirectory(item, "relative/path"), /absolute export directory/);
  service.exportFolder = async () => { throw new Error("EEXIST"); };
  await assert.rejects(service.exportToDirectory(item, ""), /EEXIST/);
  assert.equal(plugin.setting.lastExportDirectory, custom);
  assert.equal(saves, 3);
});

test("new user creates unique folder, primary files and stable ID", async () => {
  const { vault, plugin, service } = setup();
  const item = await service.create("Alice");
  assert.ok(item.id);
  assert.equal(plugin.state.investigations[item.id], item);
  assert.match(vault.getFileByPath("Comsift/Users/Alice/Alice.md").content, /comsift_id:/);
  assert.ok(vault.getFileByPath("Comsift/Users/Alice/Alice.canvas"));
  await assert.rejects(service.create("Alice"), /already exists/);
});

test("new person from a profile keeps source note and links it on the Canvas", async () => {
  const { vault, service } = setup();
  const source = await vault.create("Source profile.md", "# Source profile\n");
  const person = await service.create("Source profile", "#008f0a", source);
  assert.equal(source.content, "# Source profile\n");
  const note = vault.getFileByPath(service.mdPath(person)).content;
  assert.match(note, /Source profile: \[\[Source profile\]\]/);
  const board = JSON.parse(vault.getFileByPath(service.canvasPath(person)).content);
  assert.equal(board.nodes[1].file, source.path);
  assert.equal(board.edges[0].comsift_type, "same");
  assert.equal(board.edges[0].color, "#008f0a");
});

test("external primary rename synchronizes folder and Canvas without a loop", async () => {
  globalThis.window = globalThis;
  const { vault, service } = setup();
  const item = await service.create("Alice");
  await vault.create("Comsift/Users/Alice/handwritten.md", "Keep me");
  service.start();
  await vault.rename(vault.getFileByPath("Comsift/Users/Alice/Alice.md"), "Comsift/Users/Alice/Bob.md");
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(item.folderPath, "Comsift/Users/Bob");
  assert.ok(vault.getFileByPath("Comsift/Users/Bob/Bob.md"));
  assert.ok(vault.getFileByPath("Comsift/Users/Bob/Bob.canvas"));
  assert.equal(vault.getFileByPath("Comsift/Users/Bob/handwritten.md").content, "Keep me");
  assert.ok(vault.renameCount <= 3, `Unexpected rename loop: ${vault.renameCount}`);
});

test("external folder rename keeps extra files and updates primary names", async () => {
  globalThis.window = globalThis;
  const { vault, service } = setup();
  const item = await service.create("Alice");
  await vault.create("Comsift/Users/Alice/source.csv", "username\nalice\n");
  service.start();
  await vault.rename(vault.getFolderByPath("Comsift/Users/Alice"), "Comsift/Users/Carol");
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(item.folderPath, "Comsift/Users/Carol");
  assert.ok(vault.getFileByPath("Comsift/Users/Carol/Carol.md"));
  assert.ok(vault.getFileByPath("Comsift/Users/Carol/Carol.canvas"));
  assert.ok(vault.getFileByPath("Comsift/Users/Carol/source.csv"));
});

test("only the title property changes investigation names", async () => {
  const { vault, service } = setup();
  const item = await service.create("Alice");
  const md = vault.getFileByPath("Comsift/Users/Alice/Alice.md");
  md.content += "## Other heading\n";
  await service.onTitleChanged(md);
  assert.equal(item.folderPath, "Comsift/Users/Alice");
  md.content = md.content.replace("title: Alice", "title: Dana");
  await service.onTitleChanged(md);
  assert.equal(item.folderPath, "Comsift/Users/Dana");
  assert.ok(vault.getFileByPath("Comsift/Users/Dana/Dana.canvas"));
});

test("migration snapshots originals and preserves Markdown prose and Canvas data", async () => {
  const { vault, service } = setup();
  await vault.createFolder("Legacy");
  const graph = { nodes: [{ id: "whereami-main", text: "Alice" }], edges: [] };
  const md = await vault.create("Legacy/Alice.md", [
    "---", "whereami:", "  id: legacy-1", "---", "# Alice", "", "My handwritten prose.",
    "<!-- whereami:graph:start -->", "```json", JSON.stringify(graph), "```",
    "<!-- whereami:graph:end -->",
  ].join("\n"));
  const canvasContent = JSON.stringify({ nodes: [{ id: "whereami-main", type: "text", text: "Alice" }], edges: [] });
  const canvas = await vault.create("Legacy/Alice.canvas", canvasContent);
  const item = await service.migrate(md, canvas);
  assert.equal(item.id, "legacy-1");
  assert.equal(vault.getFileByPath("Comsift/Users/Alice/Alice.canvas").content, canvasContent);
  const migrated = vault.getFileByPath("Comsift/Users/Alice/Alice.md").content;
  assert.match(migrated, /My handwritten prose/);
  assert.doesNotMatch(migrated, /whereami:graph:start/);
  assert.match(migrated, /^---\ncomsift_id: legacy-1\ntitle: Alice\n---\n/);
  assert.doesNotMatch(migrated, /<!--/);
  const backups = [...vault.files.keys()].filter(path => path.includes("/Backups/") && path.endsWith(".canvas"));
  assert.equal(backups.length, 1);
});

test("person folder export imports into a different users root with fresh ID and relocated links", async () => {
  const { mkdtemp, readFile, readdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const temporary = await mkdtemp(join(tmpdir(), "comsift-portability-"));
  try {
    const first = setup();
    const original = await first.service.create("Alice");
    await first.vault.create(`${original.folderPath}/Connections/Bob.md`, `[[${original.folderPath}/Alice]]`);
    first.vault.getFiles = () => [...first.vault.files.values()].filter(file => file instanceof TFile);
    first.vault.readBinary = async file => new TextEncoder().encode(file.content).buffer;
    const destination = join(temporary, "custom-export-name");
    await first.service.exportFolder(original, destination);
    const files = [];
    const walk = async (folder, prefix = "custom-export-name") => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const full = join(folder, entry.name), relative = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) await walk(full, relative);
        else {
          const data = await readFile(full);
          files.push({ webkitRelativePath: relative, text: async () => data.toString(), arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });
        }
      }
    };
    await walk(destination);
    const second = setup();
    second.plugin.setting.usersFolder = "Imported";
    const imported = await second.service.importFolder(files);
    assert.equal(imported.folderPath, "Imported/Alice");
    assert.notEqual(imported.id, original.id);
    assert.match(second.vault.getFileByPath("Imported/Alice/Alice.md").content, new RegExp(`comsift_id: ${imported.id}`));
    assert.equal(second.vault.getFileByPath("Imported/Alice/Connections/Bob.md").content, "[[Imported/Alice/Alice]]");
    await assert.rejects(second.service.importFolder(files), /Folder already exists/);
    await assert.rejects(first.service.exportFolder(original, destination), /EEXIST/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
