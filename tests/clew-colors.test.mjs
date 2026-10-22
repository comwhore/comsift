import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const result = await build({ entryPoints: ["src/service/graphColoring.ts"], bundle: true, platform: "node", format: "esm", write: false });
const coloring = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
const colorsBuild = await build({ entryPoints: ["src/service/colors.ts"], bundle: true, platform: "node", format: "esm", write: false });
const colors = await import(`data:text/javascript;base64,${Buffer.from(colorsBuild.outputFiles[0].text).toString("base64")}`);

test("Clew groups: specific notes first, then person folders and tags", () => {
  const people = [{ id: "a", folder: "Alex", color: "#ff0000", tag: "comsift/alex", name: "Alex" }];
  const notes = new Map([
    ["Alex/Alex.md", { color: "#ff0000", owners: ["a"], distance: 0 }],
    ["Alex/Connections/alex_alt.md", { color: "#aa3300", owners: ["a"], distance: 0, persona: true }],
    ["Notes/Shared place.md", { color: "#ff8888", owners: ["a"], distance: 1 }],
    ["Alex/Alex.canvas", { color: "#ff0000", owners: ["a"], distance: 0 }],
  ]);
  const groups = coloring.clewGroups(people, notes);
  assert.ok(groups.every(group => group.id.startsWith(coloring.CLEW_GROUP_PREFIX)));
  assert.deepEqual(groups.map(group => group.name), ["Comsift · Shared place", "Comsift · alex_alt", "Comsift · Alex", "Comsift · Alex", "Comsift · Alex (tag)"]);
  assert.deepEqual(groups[0].criteria, [{ type: "folder", folder: "Notes" }, { type: "filename", query: "Shared place" }]);
  assert.deepEqual(groups[2].criteria, [{ type: "folder", folder: "Alex" }, { type: "filename", query: "Alex" }]);
  assert.equal(groups[2].color, "#ff0000", "the person's own note keeps the person color");
  assert.deepEqual(groups[3].criteria, [{ type: "folder", folder: "Alex" }]);
  assert.equal(groups[3].color, colors.memberShade("#ff0000"), "the rest of the folder gets the member shade");
  assert.deepEqual(groups[4].criteria, [{ type: "tag", tags: ["#comsift/alex"] }]);
  assert.equal(groups[1].color, "#aa3300");
});

const options = { depth: 3, fade: 0.2, bridgeMode: "neutral", bridgeColor: "#888888", personaMix: 0.5 };
const alex = { id: "a", folder: "Alex", color: "#cc3333", tag: "comsift/alex", name: "Alex" };

test("Clew: a member note caught by a shorter person-note group gets its own group", () => {
  const { notes } = coloring.computeColors([alex], ["Alex/Alex.md", "Alex/Alex sample.sheet.md", "Alex/Other.md"], [], options);
  const groups = coloring.clewGroups([alex], notes);
  const sheet = groups.find(group => group.id === "comsift:Alex/Alex sample.sheet.md");
  assert.ok(sheet, "the sheet would otherwise match the Alex note group");
  assert.equal(sheet.color, colors.memberShade(alex.color));
  assert.ok(groups.indexOf(sheet) < groups.findIndex(group => group.id === "comsift:Alex/Alex.md"));
  assert.equal(groups.find(group => group.id === "comsift:Alex/Other.md"), undefined, "folder group covers plain member notes");
  const withFriends = coloring.computeColors([alex], ["Alex/Alex.md", "Alex/Connections/f1.md", "Alex/Connections/f2.md"], [], options, [], [],
    ["Alex/Connections/f1.md", "Alex/Connections/f2.md"]);
  assert.ok(!coloring.clewGroups([alex], withFriends.notes).some(group => group.id.includes("/Connections/")), "lone profiles use the folder group");
});

test("non-person notes and lone profiles get the member shade; only same-linked profiles are custom people", () => {
  const paths = ["Alex/Alex.md", "Alex/Alex.canvas", "Alex/Sherlock/result.md", "Alex/Analysis/report.md", "Alex/Connections/friend.md",
    "Alex/Connections/profile1.md", "Alex/Connections/profile2.md", "Alex/Connections/loose note.md", "Alex/Chats/chat.md", "Alex/Connections/related.md"];
  const profiles = ["Alex/Connections/profile1.md", "Alex/Connections/profile2.md", "Alex/Connections/friend.md", "Alex/Connections/related.md"];
  const { notes, groups } = coloring.computeColors([alex], paths, [["Alex/Connections/related.md", "Alex/Alex.md"]], options, [],
    [["Alex/Connections/profile1.md", "Alex/Connections/profile2.md"]], profiles);
  const shade = colors.memberShade(alex.color);
  for (const path of ["Alex/Sherlock/result.md", "Alex/Analysis/report.md", "Alex/Connections/loose note.md", "Alex/Chats/chat.md",
    "Alex/Connections/friend.md", "Alex/Connections/related.md"]) {
    assert.equal(notes.get(path).color, shade, path);
    assert.equal(notes.get(path).persona, undefined, path);
  }
  assert.equal(notes.get("Alex/Alex.md").color, alex.color);
  assert.equal(notes.get("Alex/Alex.canvas").color, alex.color);
  const profile = notes.get("Alex/Connections/profile1.md");
  assert.equal(profile.persona, true);
  assert.equal(notes.get("Alex/Connections/profile2.md").color, profile.color);
  assert.notEqual(profile.color, alex.color);
  assert.notEqual(profile.color, shade);
  const first = query => groups.find(group => group.query.includes(query)).color;
  assert.equal(first("Alex/Alex.md"), alex.color);
  assert.equal(first("Alex/Sherlock/result.md"), shade);
  assert.equal(first("Alex/Connections/profile1.md"), profile.color);
});

test("same-marked profiles share one color; same-marked to the person (transitively) take the person color", () => {
  const p = n => `Alex/Connections/p${n}.md`;
  const paths = ["Alex/Alex.md", p(1), p(2), p(3), p(4), p(5), p(6), p(7)];
  const profiles = [p(1), p(2), p(3), p(4), p(5), p(6), p(7)];
  const same = [[p(1), p(2)], [p(3), "Alex/Alex.md"], [p(4), p(3)], [p(5), p(6)]];
  const { notes } = coloring.computeColors([alex], paths, [], options, [], same, profiles);
  assert.equal(notes.get(p(1)).color, notes.get(p(2)).color);
  assert.notEqual(notes.get(p(1)).color, notes.get(p(5)).color, "two custom people differ");
  assert.equal(notes.get(p(5)).color, notes.get(p(6)).color);
  assert.equal(notes.get(p(7)).color, colors.memberShade(alex.color));
  assert.notEqual(notes.get(p(1)).color, alex.color);
  assert.equal(notes.get(p(3)).color, alex.color);
  assert.equal(notes.get(p(4)).color, alex.color);
  const outside = coloring.computeColors([alex], [...paths, "Elsewhere/acct.md"], [], options, [], [["Elsewhere/acct.md", p(3)], ...same], profiles);
  assert.equal(outside.notes.get("Elsewhere/acct.md").color, alex.color);
  assert.equal(outside.notes.get("Elsewhere/acct.md").distance, 0);
});

test("related marks sit one step away; a promoted profile is its own person", () => {
  const bob = { id: "b", folder: "Alex/Connections/Bob", color: "#3366cc", tag: "comsift/bob", name: "Bob" };
  const paths = ["Alex/Alex.md", "Notes/place.md", "Alex/Connections/Bob/Bob.md", "Alex/Connections/x.md"];
  const profiles = ["Alex/Connections/Bob/Bob.md", "Alex/Connections/x.md"];
  const { notes } = coloring.computeColors([alex, bob], paths, [["Notes/place.md", "Alex/Alex.md"]], options, [], [["Alex/Connections/x.md", "Alex/Connections/Bob/Bob.md"]], profiles);
  assert.equal(notes.get("Notes/place.md").distance, 1);
  assert.equal(notes.get("Notes/place.md").color, colors.shade(alex.color, 1, options.fade));
  assert.equal(notes.get("Alex/Connections/Bob/Bob.md").color, bob.color);
  assert.equal(notes.get("Alex/Connections/Bob/Bob.md").persona, undefined);
  assert.equal(notes.get("Alex/Connections/x.md").color, bob.color, "a profile verified as the promoted person takes their color");
});

test("member shade goes darker for light colors and lighter for dark ones; persona colors derive from the person", () => {
  for (const light of ["#e8c547", "#7fd3ff", "#f0a0a0"]) assert.ok(colors.luminance(colors.memberShade(light)) < colors.luminance(light), light);
  for (const dark of ["#202060", "#3a1010", "#334433"]) assert.ok(colors.luminance(colors.memberShade(dark)) > colors.luminance(dark), dark);
  const [hue] = colors.hexToHsl("#cc3333");
  for (let index = 0; index < 20; index++) {
    const [other] = colors.hexToHsl(colors.personaColor("#cc3333", `k${index}`, 1));
    const turn = Math.min(Math.abs(other - hue), 360 - Math.abs(other - hue));
    assert.ok(turn >= 20 && turn <= 45, `hue turn ${turn}`);
  }
  assert.equal(colors.personaColor("#cc3333", "k"), colors.personaColor("#cc3333", "k"));
});

test("Main notes take the link count of everything that is theirs and grow in Clew", () => {
  const people = [{ id: "a", folder: "Alex", color: "#ff0000", tag: "comsift/alex", primary: "Alex/Alex.md", name: "Alex" }];
  const notes = new Map([["Alex/Alex.md", { color: "#ff0000", owners: ["a"], distance: 0 }]]);
  const edges = [["Alex/Alex.md", "Alex/Maigret/a.md"]];
  for (let i = 0; i < 15; i++) {
    notes.set(`Alex/Connections/f${i}.md`, { color: "#cc0000", owners: ["a"], distance: 0, member: true });
    edges.push([`Alex/Sheets/list.md`, `Alex/Connections/f${i}.md`]);
  }
  const weight = coloring.primaryWeights(people, notes, edges).get("Alex/Alex.md");
  assert.ok(weight.links >= 16);
  assert.ok(weight.size > 1 && weight.size <= 4);
  notes.get("Alex/Alex.md").size = weight.size;
  const group = coloring.clewGroups(people, notes).find(entry => entry.name === "Comsift · Alex" && entry.sizeMultiplier);
  assert.equal(group.sizeMultiplier, weight.size);
});
