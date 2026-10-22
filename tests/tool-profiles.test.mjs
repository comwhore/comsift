import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const mock = { name: "mock", setup(build) {
  build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
  build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: "export class Modal {} export const loadMermaid = async () => ({ parse: async () => true }); export class Notice {} export class TFile {} globalThis.ToolTFile = TFile; export class TFolder {} export const normalizePath = x => x;", loader: "js" }));
} };
const load = async entry => {
  const output = await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", write: false, loader: { ".py": "text" }, plugins: [mock] });
  return import("data:text/javascript;base64," + Buffer.from(output.outputFiles[0].contents).toString("base64"));
};
const tools = await load("src/service/toolProfiles.ts");
const { AnalysisService } = await load("src/analysis/service.ts");
const identity = await load("src/analysis/profileIdentity.ts");

// Report written by MaigretService.buildSiteMarkdown (older reports have no `site:` row; frontmatter and the
// old links callout were added later by other code).
const tiktok = [
  "---", "tags:", "  - comsift/person", "---",
  "# fixture.account", "", "<small>https://www.tiktok.com/@fixture.account</small>", "",
  "username: fixture.account", "tiktok_id: 700001", "tiktok_username: fixture.account", "fullname: Fixture Person", "bio: likes tea: green",
  "image: https://cdn.example.test/a.jpeg?x=1", "is_verified: False", "sec_uid: fixture-sec-uid-001", "follower_count: 101", "",
  "![image](https://cdn.example.test/a.jpeg?x=1)", "", "> [!comsift-links]- Investigation relationships", "> [[Person/x.sheet]]", "",
].join("\n");
const chess = "# fixture_account\n\n<small>https://www.chess.com/member/fixture_account</small>\n\nusername: fixtureacct\nsite: Chess\nchess_user_id: 42\nusername: fixture_account\ncountry: XX\ncreated_at: 2000-01-01 00:00:00 UTC\n";
const discord = "# fixture.account\n\n<small>https://discord.com</small>\n\nusername: fixture.account\n";
const sherlock = "# GitHub\n\nUsername: fixture-account\n\nProfile: https://github.com/fixture-account\n\nSite: https://www.github.com/\n\nHTTP status: 200\n";

test("Maigret and Sherlock reports become profile fields", () => {
  assert.equal(tools.toolReportKind("Person/Maigret/fixture.account tiktok.com 01.01.2026.md"), "maigret");
  assert.equal(tools.toolReportKind("Person/Sherlock/fixture GitHub.md"), "sherlock");
  assert.equal(tools.toolReportKind("Person/Notes/Maigret.md"), null);
  assert.equal(tools.toolReportKind("Maigret/x.md"), null);

  const a = tools.parseToolReport("Person/Maigret/fixture.account tiktok.com 01.01.2026.md", tiktok);
  assert.deepEqual(a.fields, { username: "fixture.account", platform: "tiktok", profile_url: "https://www.tiktok.com/@fixture.account", display_name: "Fixture Person", bio: "likes tea: green",
    user_id: "700001", avatar_url: "https://cdn.example.test/a.jpeg?x=1", followers: "101", verified: "False" });
  assert.equal(a.raw.sec_uid, "fixture-sec-uid-001");
  assert.equal(a.raw.tags, undefined, "frontmatter is not a report row");

  const c = tools.parseToolReport("Person/Maigret/fixtureacct chess.com 01.01.2026.md", chess);
  assert.equal(c.fields.username, "fixture_account", "the account's own username wins over the searched one");
  assert.equal(c.fields.platform, "chess");
  assert.equal(c.fields.user_id, "42");
  assert.equal(c.fields.location, "XX");

  assert.deepEqual(tools.parseToolReport("Person/Maigret/fixture.account discord.com 01.01.2026.md", discord).fields, { username: "fixture.account", platform: "discord", profile_url: "https://discord.com" });
  assert.deepEqual(tools.parseToolReport("Person/Sherlock/fixture-account GitHub.md", sherlock).fields, { username: "fixture-account", platform: "github", profile_url: "https://github.com/fixture-account" });
  assert.equal(tools.parseToolReport("Person/Maigret/x.md", "# x\n\nno url here\n"), null);

  assert.equal(tools.platformFromHost("https://t.me/fixture"), "telegram");
  assert.equal(tools.platformFromHost("https://fixture.wordpress.com/"), "wordpress");
  assert.equal(tools.platformFromHost("https://op.gg/summoners/x"), "op.gg");
  assert.equal(tools.platformFromHost("https://shop.example.co.uk/x"), "example");

  const record = tools.toolRecord("Person/Maigret/a.md", a);
  assert.deepEqual([record.id, record.dataset, record.row, record.section], ["Person/Maigret/a.md:0", "Person/Maigret/a.md", 0, "Maigret"]);
  // Stored like any imported row and readable again.
  const note = identity.mergeProfileContent([record], "fixture.account (tiktok)");
  assert.deepEqual(identity.readProfileRecords(note)[0].fields, a.fields);
});

function setup() {
  const files = new Map();
  const add = (path, text) => { const file = Object.assign(new globalThis.ToolTFile(), { path, extension: path.split(".").at(-1) }); files.set(path, { file, text }); return file; };
  const vault = { configDir: ".obsidian", adapter: { exists: async () => true, mkdir: async () => {}, write: async () => {} },
    getFileByPath: path => files.get(path)?.file, getMarkdownFiles: () => [...files.values()].filter(e => e.file.extension === "md").map(e => e.file),
    getFiles: () => [...files.values()].map(e => e.file), getAbstractFileByPath: path => files.get(path)?.file,
    read: async file => files.get(file.path).text,
    process: async (file, update) => { files.get(file.path).text = update(files.get(file.path).text); },
    create: async (path, text) => { if (files.has(path)) throw new Error("Duplicate create"); return add(path, text); } };
  const owner = { id: "person", folderPath: "Person" };
  const plugin = { manifest: { id: "comsift" }, app: { vault, metadataCache: { getFileCache: () => null }, fileManager: {} },
    investigations: { forPath: () => owner, forPrimaryPath: path => path === "Person/Person.md" ? owner : null }, graph: { remap: () => {}, refreshInvestigation: async () => {} },
    state: { graphSources: {}, investigations: { person: owner } }, saveState: async () => {} };
  const service = new AnalysisService(plugin);
  service.ensureFolder = async (item, folder) => `${item.folderPath}/${folder}`;
  return { service, files, add, owner };
}

test("found accounts join existing connection profiles of the same account and stay idempotent", async () => {
  const { service, files, add, owner } = setup();
  const imported = { id: "Person/f.sheet.md#Sheet1:3", dataset: "Person/f.sheet.md#Sheet1", row: 3, fields: { username: "fixture.account", platform: "tiktok", display_name: "Fixture Person", bio: "" }, raw: {} };
  add("Person/Connections/fixture.account (tiktok).md", identity.mergeProfileContent([imported], "fixture.account (tiktok)") + "\nMy notes.\n");
  const records = [
    tools.toolRecord("Person/Maigret/a.md", tools.parseToolReport("Person/Maigret/a.md", tiktok)),
    tools.toolRecord("Person/Maigret/b.md", tools.parseToolReport("Person/Maigret/b.md", chess)),
  ];
  const written = await service.importProfileRecords(owner, records);
  assert.equal(written[0].path, "Person/Connections/fixture.account (tiktok).md", "same platform + username → the existing profile");
  assert.notEqual(written[1].path, written[0].path);
  const merged = files.get(written[0].path).text;
  assert.equal(identity.readProfileRecords(merged).length, 2);
  assert.match(merged, /My notes\./);
  assert.match(merged, /\[\[Person\/Maigret\/a\]\]/);
  const before = [...files.entries()].map(([path, entry]) => [path, entry.text]);
  await service.importProfileRecords(owner, records);
  assert.deepEqual([...files.entries()].map(([path, entry]) => [path, entry.text]), before, "importing again changes nothing");
});

test("a found account whose fields conflict with an existing profile stays separate (exact identity rules)", async () => {
  const { service, add, owner } = setup();
  const imported = { id: "Person/f.sheet.md#Sheet1:3", dataset: "Person/f.sheet.md#Sheet1", row: 3, fields: { username: "fixture.account", platform: "tiktok", display_name: "Someone Else" }, raw: {} };
  add("Person/Connections/fixture.account (tiktok).md", identity.mergeProfileContent([imported], "fixture.account (tiktok)"));
  const [file] = await service.importProfileRecords(owner, [tools.toolRecord("Person/Maigret/a.md", tools.parseToolReport("Person/Maigret/a.md", tiktok))]);
  assert.equal(file.path, "Person/Connections/fixture.account (tiktok) 2.md");
});

test("owned files per owner leave out row → owner links", async () => {
  const owners = await load("src/service/fileOwners.ts");
  const links = { "P/Connections/a.md": ["P/a insta.sheet.md", "P/Maigret/a x.md"], "P/Connections/row.md": ["P/Connections/a.md"] };
  const map = owners.ownedFilesByOwner(links, path => path.includes("/Connections/"));
  assert.deepEqual([...map], [["P/Connections/a.md", ["P/a insta.sheet.md", "P/Maigret/a x.md"]]]);
  assert.equal(owners.ownedFilesByOwner(undefined, () => false).size, 0);
});
