import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

async function load(source) {
  const result = await build({ entryPoints: [source], bundle: true, platform: "node", format: "esm", write: false });
  return import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].contents).toString("base64"));
}
const owners = await load("src/service/fileOwners.ts");
const coloring = await load("src/service/graphColoring.ts");
const colors = await load("src/service/colors.ts");

const people = [{ folder: "Alex", primary: "Alex/Alex.md" }, { folder: "Blake", primary: "Blake/Blake.md" }];
const note = (path, kind, extra = {}) => ({ path, kind, accounts: [], sources: [], links: [], ...extra });
const row = (name, sources) => note(`Alex/Connections/${name} (instagram).md`, "profile", { accounts: [`instagram|${name}`], sources });

test("export and search names give a handle and platform", () => {
  assert.deepEqual(owners.exportName("Alex/alt_one instagram.sheet.md"), { handle: "alt_one", platform: "instagram" });
  assert.deepEqual(owners.exportName("Alex/@alt_one bsky.csv"), { handle: "alt_one", platform: "bluesky" });
  assert.deepEqual(owners.exportName("Alex/alt_one tiktok 2.sheet.md"), { handle: "alt_one", platform: "tiktok" });
  assert.equal(owners.exportName("Alex/two words here.sheet.md"), null);
  assert.equal(owners.exportName("Alex/notes.md"), null);
  assert.equal(owners.searchName("Alex/Maigret/alt_one example.com 01.01.2026.md"), "alt_one");
  assert.equal(owners.searchName("Alex/alt_one example.com.md"), null, "only Maigret/Sherlock results");
});

test("owner detection: account handle on the same platform, override, the person themselves", () => {
  const alt = note("Alex/Connections/alt_one (instagram).md", "profile", { accounts: ["instagram|alt_one"] });
  const primary = note("Alex/Alex.md", "primary", { accounts: ["*|main_handle"] });
  const blake = note("Blake/Blake.md", "primary");
  const notes = [alt, primary, blake];
  const sheet = note("Alex/alt_one instagram.sheet.md", "file");
  assert.equal(owners.detectOwner(sheet, notes, people), alt.path);
  assert.equal(owners.detectOwner(note("Alex/alt_one tiktok.sheet.md", "file"), notes, people), null, "platform must match");
  assert.equal(owners.detectOwner(note("Alex/main_handle instagram.sheet.md", "file"), notes, people), null, "the person's own alias");
  assert.equal(owners.detectOwner(note("Alex/alex roblox.sheet.md", "file"), notes, people), null, "the person's folder name");
  assert.equal(owners.detectOwner(note("Alex/blake roblox.sheet.md", "file"), notes, people), blake.path, "another person's note");
  assert.equal(owners.detectOwner(note("Alex/Maigret/alt_one example.com 01.01.2026.md", "file"), notes, people), alt.path);
  assert.equal(owners.detectOwner({ ...sheet, owner: blake.path }, notes, people), blake.path, "override wins");
  assert.equal(owners.detectOwner({ ...sheet, owner: primary.path }, notes, people), null, "override to the person keeps it theirs");
  assert.equal(owners.detectOwner(note("Outside/alt_one instagram.sheet.md", "file"), notes, people), null, "outside person folders");
  const duplicate = note("Alex/Connections/alt_one (instagram) 2.md", "profile", { accounts: ["instagram|alt_one"] });
  assert.equal(owners.detectOwner(sheet, [duplicate, ...notes], people), alt.path, "shortest path among duplicates");
});

test("ownership: owner ↔ sheet and rows ↔ owner links; the person keeps mixed rows and the owner", () => {
  const sheet = "Alex/alt_one instagram.sheet.md", own = "Alex/main_handle tiktok.sheet.md";
  const alt = note("Alex/Connections/alt_one (instagram).md", "profile", { accounts: ["instagram|alt_one"], sources: [own] });
  const onlyOwned = row("friend_a", [sheet]);
  const mixed = row("friend_b", [sheet, own]);
  const notes = [note("Alex/Alex.md", "primary", { accounts: ["*|main_handle"] }), alt, onlyOwned, mixed, note(sheet, "file"), note(own, "file")];
  const result = owners.ownership(notes, people);
  assert.deepEqual([...result.owners], [[sheet, alt.path]]);
  assert.deepEqual(result.links[alt.path], [sheet]);
  assert.deepEqual(result.links[onlyOwned.path], [alt.path]);
  assert.deepEqual(result.links[mixed.path], [alt.path]);
  assert.deepEqual([...result.detached].sort(), [sheet, onlyOwned.path].sort());
  assert.deepEqual(owners.ownership(notes, people), result, "idempotent");
});

test("ownership: a file the user linked to one profile hangs off that profile unless the person links it", () => {
  const profile = row("friend_a", []);
  const notes = [note("Alex/Alex.md", "primary"), { ...profile, links: ["Alex/screenshot.md"] }, note("Alex/screenshot.md", "file"),
    note("Alex/list.md", "file", { links: ["a", "b", "c", "d"].map(name => `Alex/Connections/${name} (instagram).md`) }),
    ...["a", "b", "c", "d"].map(name => row(name, []))];
  assert.ok(owners.ownership(notes, people).detached.has("Alex/screenshot.md"));
  assert.ok(!owners.ownership(notes, people).detached.has("Alex/list.md"), "a list of many profiles belongs to nobody");
  notes[0] = note("Alex/Alex.md", "primary", { links: ["Alex/screenshot.md"] });
  assert.ok(!owners.ownership(notes, people).detached.has("Alex/screenshot.md"));
});

test("connection scores: lone rows 0, extra origins, marks, own files, exported rows", () => {
  const a = "Alex/alt_one instagram.sheet.md", b = "Alex/other_one instagram.sheet.md";
  const alt = note("Alex/Connections/alt_one (instagram).md", "profile", { accounts: ["instagram|alt_one"] });
  const lone = row("lone", ["Alex/main tiktok.sheet.md"]);
  const twice = row("twice", ["Alex/main tiktok.sheet.md", a]);
  const csvTwin = row("twin", ["Alex/main tiktok.sheet.md", "Alex/main tiktok.csv"]);
  const marked = { ...row("marked", ["Alex/main tiktok.sheet.md"]), links: [alt.path] };
  const notes = [note("Alex/Alex.md", "primary"), alt, lone, twice, csvTwin, marked, note(a, "file"), note(b, "file")];
  const scores = owners.connectionScores(notes, owners.ownership(notes, people));
  assert.equal(scores.get(lone.path).score, 0);
  assert.equal(scores.get(csvTwin.path).score, 0, "a CSV and its sheet are one export");
  assert.equal(scores.get(twice.path).score, 1);
  assert.equal(scores.get(marked.path).score, 1);
  // alt: 1 person (marked), 1 own file (its export), 1 exported row → 1 + 1 + log2(2).
  assert.deepEqual(scores.get(alt.path), { score: 3, people: 1, files: 1, sources: 0, rows: 1 });
  assert.equal(owners.sizeMultiplier(0), 1);
  assert.equal(owners.sizeMultiplier(2), 1.5);
  assert.equal(owners.sizeMultiplier(40), 2.5, "capped");
});

const options = { depth: 3, fade: 0.2, bridgeMode: "neutral", bridgeColor: "#888888", personaMix: 0.5 };
const alex = { id: "a", folder: "Alex", color: "#cc3333", tag: "comsift/alex", name: "Alex" };

test("colors: notable profiles above the threshold get the notable shade and a size; others the member shade", () => {
  const paths = ["Alex/Alex.md", "Alex/Connections/hub (instagram).md", "Alex/Connections/row (instagram).md", "Alex/Connections/near (instagram).md"];
  const scores = new Map([["Alex/Connections/hub (instagram).md", 6], ["Alex/Connections/near (instagram).md", 0.5]]);
  const { notes, groups } = coloring.computeColors([alex], paths, [], options, [], [], paths.slice(1), scores);
  const hub = notes.get(paths[1]);
  assert.equal(hub.color, colors.notableShade(alex.color));
  assert.ok(hub.notable && hub.size === 2.5);
  assert.notEqual(hub.color, colors.memberShade(alex.color));
  assert.notEqual(hub.color, alex.color);
  assert.ok(notes.get(paths[2]).member && !notes.get(paths[2]).size);
  assert.ok(notes.get(paths[3]).member, "below the default threshold of 1");
  assert.ok(coloring.computeColors([alex], paths, [], { ...options, importance: 0.5 }, [], [], paths.slice(1), scores).notes.get(paths[3]).notable);
  assert.ok(groups.some(group => group.color === colors.notableShade(alex.color) && group.query.includes("hub")), "one Graph View group per person");
});

test("Clew: notable profiles get groups with a size multiplier, before plain members", () => {
  const paths = ["Alex/Alex.md", "Alex/Connections/hub (instagram).md", "Alex/Connections/row (instagram).md"];
  const { notes } = coloring.computeColors([alex], paths, [], options, [], [], paths.slice(1), new Map([[paths[1], 2]]));
  const groups = coloring.clewGroups([alex], notes);
  const hub = groups.find(group => group.id === `comsift:${paths[1]}`);
  assert.equal(hub.sizeMultiplier, 1.5);
  assert.equal(hub.color, colors.notableShade(alex.color));
  assert.equal(groups.find(group => group.id === `comsift:${paths[2]}`), undefined, "plain rows use the folder group");
  assert.ok(groups.filter(group => group.id.includes("folder:") || group.id.includes("tag:")).every(group => group.sizeMultiplier === null));
});
