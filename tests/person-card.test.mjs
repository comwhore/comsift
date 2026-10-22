import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const load = async entry => {
  const output = await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", write: false });
  return import("data:text/javascript;base64," + Buffer.from(output.outputFiles[0].contents).toString("base64"));
};
const card = await load("src/service/personCardFormat.ts");
const identity = await load("src/analysis/profileIdentity.ts");
const cells = await load("src/analysis/cellRefs.ts");
const marks = await load("src/service/personMarks.ts");

const oldNote = [
  "---",
  "comsift_account: instagram|fixture.account",
  "aliases:",
  "  - fixture.account",
  "---",
  "Met at the meetup, see below.",
  "",
  "<!-- comsift:profile:start -->",
  "# fixture.account (instagram)",
  "",
  "Sources:",
  "- [[Case/fixture instagram.sheet]], row 4",
  "",
  "- username: fixture.account",
  "- platform: instagram",
  "<!-- comsift:profile:end -->",
  "",
  "Later note with a [[Link]].",
  "",
].join("\n");

test("old generated block becomes the card; user text before and after moves under Notes", () => {
  const next = card.withPersonCard(oldNote);
  assert.doesNotMatch(next, /comsift:profile/);
  assert.doesNotMatch(next, /^Sources:/m);
  assert.match(next, /^---\ncomsift_account: instagram\|fixture\.account\naliases:\n  - fixture\.account\n---\n\n```comsift-person\n```\n\n## Notes\n\nMet at the meetup, see below\.\n\nLater note with a \[\[Link\]\]\.\n$/);
  assert.equal(card.withPersonCard(next), next, "second run changes nothing");
  assert.equal(card.personNotes(next), "Met at the meetup, see below.\n\nLater note with a [[Link]].");
});

test("existing Notes heading is not duplicated and empty notes still get a Notes section", () => {
  const withHeading = oldNote.replace("Later note", "## Notes\n\nLater note");
  const next = card.withPersonCard(withHeading);
  assert.equal((next.match(/^## Notes$/gm) ?? []).length, 1);
  const empty = card.withPersonCard("---\na: 1\n---\n<!-- comsift:profile:start -->\n# x\n<!-- comsift:profile:end -->\n");
  assert.equal(empty, "---\na: 1\n---\n\n```comsift-person\n```\n\n## Notes\n");
});

const primaryNote = await load("src/service/primaryNote.ts");
const layout = text => primaryNote.primaryNoteLayout(text, { name: "Fixture", card: true, embedCanvas: true, divider: true });
const expected = body => `---\ncomsift_id: abc\ntitle: Fixture\n---\n\n\`\`\`comsift-person\n\`\`\`\n\n![[Fixture.canvas]]\n\n***\n\n## Notes\n\n${body}`;

test("primary notes: card, Canvas embed, one *** and then Notes", () => {
  const fm = "---\ncomsift_id: abc\ntitle: Fixture\n---\n";
  const layouts = {
    // Canvas embed + divider, no card (layout before person cards).
    embedOnly: `${fm}![[Fixture.canvas]]\n\n***\n\nFree text.\n\nMore *text*.\n`,
    // Round-3 layout: embed, divider, then the card and Notes.
    cardBelow: `${fm}![[Fixture.canvas]]\n\n***\n\n\`\`\`comsift-person\n\`\`\`\n\n## Notes\n\nFree text.\n\nMore *text*.\n`,
    // Embed without divider, stray dividers around the card.
    stray: `${fm}\n***\n![[Fixture.canvas]]\n\`\`\`comsift-person\n\`\`\`\n\n***\n\n---\n\nFree text.\n\nMore *text*.\n\n***\n`,
    // No embed at all.
    bare: `${fm}Free text.\n\nMore *text*.\n`,
    // Notes heading already there, divider right above it.
    heading: `${fm}![[Fixture.canvas]]\n\n\`\`\`comsift-person\n\`\`\`\n\n***\n\n## Notes\nFree text.\n\nMore *text*.\n`,
  };
  for (const [name, text] of Object.entries(layouts)) {
    const next = layout(text);
    assert.equal(next, expected("Free text.\n\nMore *text*.\n"), name);
    assert.equal(layout(next), next, `${name}: second run changes nothing`);
    assert.equal((next.match(/^\*\*\*$/gm) ?? []).length, 1, name);
  }
});

test("primary notes keep every piece of user text, own headings and inner dividers", () => {
  const text = "---\ncomsift_id: abc\ntitle: Fixture\n---\n![[Fixture.canvas|400]]\n\n***\n\nIntro line.\n\n# Timeline\n\n- 2024: moved\n\n***\n\n## Notes\n\nLast words.\n";
  const next = layout(text);
  assert.equal(next, "---\ncomsift_id: abc\ntitle: Fixture\n---\n\n```comsift-person\n```\n\n![[Fixture.canvas|400]]\n\n***\n\n## Notes\n\nIntro line.\n\n# Timeline\n\n- 2024: moved\n\nLast words.\n");
  assert.equal(layout(next), next);
  // The divider in the middle of the user's own text stays.
  const inner = layout("---\ntitle: Fixture\n---\nA\n\n***\n\nB\n");
  assert.match(inner, /## Notes\n\nA\n\n\*\*\*\n\nB\n$/);
  assert.equal((inner.match(/^\*\*\*$/gm) ?? []).length, 2);
  // Old relationships callout stays at the top; another Canvas embed is the user's and stays in Notes.
  const callout = layout("---\ntitle: Fixture\n---\n> [!comsift-links]- Links\n> [[Old]]\n\n![[Fixture.canvas]]\n\n***\n\nSee ![[Other.canvas]] too.\n");
  assert.match(callout, /```\n\n!\[\[Fixture\.canvas\]\]\n\n> \[!comsift-links\]- Links\n> \[\[Old\]\]\n\n\*\*\*\n\n## Notes\n\nSee !\[\[Other\.canvas\]\] too\.\n$/);
  assert.equal(layout(callout), callout);
  // Embeds of single Canvas nodes (`Fixture.canvas#node`) and a second whole-board embed are the user's text.
  const nodes = layout("---\ntitle: Fixture\n---\n![[Fixture.canvas]]\n\n***\n\nText\n![[Fixture.canvas#abc|Roblox]]\n![[Fixture.canvas]]\n");
  assert.match(nodes, /## Notes\n\nText\n!\[\[Fixture\.canvas#abc\|Roblox\]\]\n!\[\[Fixture\.canvas\]\]\n$/);
  assert.equal(layout(nodes), nodes);
  // Settings off: no card, no embed → unchanged; divider off → no ***.
  const plain = "---\ntitle: Fixture\n---\nText\n";
  assert.equal(primaryNote.primaryNoteLayout(plain, { name: "Fixture", card: false, embedCanvas: false, divider: true }), plain);
  assert.doesNotMatch(primaryNote.primaryNoteLayout(plain, { name: "Fixture", card: true, embedCanvas: true, divider: false }), /\*\*\*/);
  // A new person's note (empty body) still gets the Notes section.
  assert.equal(layout("---\ncomsift_id: abc\ntitle: Fixture\n---\n\n"), expected("").replace("## Notes\n\n", "## Notes\n"));
});

test("withPersonCard on a primary note uses the same layout", () => {
  const next = card.withPersonCard("---\ntitle: Fixture\n---\n![[Fixture.canvas]]\n\n***\n\n# Timeline\n", { primary: true });
  assert.equal(next, "---\ntitle: Fixture\n---\n\n```comsift-person\n```\n\n![[Fixture.canvas]]\n\n***\n\n## Notes\n\n# Timeline\n");
  assert.equal(layout(next.replace("title: Fixture", "comsift_id: abc\ntitle: Fixture")), next.replace("title: Fixture", "comsift_id: abc\ntitle: Fixture"));
});

test("very old generated layout without markers is replaced too", () => {
  const legacy = "---\ncomsift_records:\n  - \"Case/a.sheet.md:4\"\n---\n# Fixture\n\nSources:\n- [[Case/a.sheet]], row 4\n\n- username: fixture\nMy own line.\n";
  const next = card.withPersonCard(legacy);
  assert.doesNotMatch(next, /^Sources:/m);
  assert.match(next, /## Notes\n\nMy own line\.\n$/);
});

const rec = (dataset, row = 4, fields = { username: "fixture.account", platform: "instagram" }) => ({ id: `${dataset}:${row}`, dataset, row, fields });

test("profile writes use the card layout, never touch Notes, and stay readable", () => {
  const created = identity.mergeProfileContent([rec("Case/a.sheet.md#Sheet1")], "fixture.account (instagram)");
  assert.match(created, /```comsift-person\n```\n\n## Notes\n$/);
  const written = created + "\nMy notes about this account.\n";
  const updated = identity.mergeProfileContent([rec("Case/a.sheet.md#Sheet1"), rec("Case/b.sheet.md#Sheet1", 9)], "fixture.account (instagram)", written);
  assert.match(updated, /My notes about this account\./);
  assert.equal((updated.match(/```comsift-person/g) ?? []).length, 1);
  assert.deepEqual(identity.readProfileRecords(updated).map(r => [r.dataset, r.row]), [["Case/a.sheet.md#Sheet1", 4], ["Case/b.sheet.md#Sheet1", 9]]);
  // Migrating an old note through an update keeps the user's text.
  const migrated = identity.mergeProfileContent([rec("Case/fixture instagram.sheet.md#Sheet1")], "x", oldNote);
  assert.match(migrated, /## Notes\n\nMet at the meetup, see below\.\n\nLater note with a \[\[Link\]\]\./);
  assert.doesNotMatch(migrated, /comsift:profile/);
});

test("readProfileRecords reads data that Obsidian rewrote with single quotes", () => {
  const data = JSON.stringify([rec("Case/a.sheet.md#Sheet1")]).replace(/'/g, "''");
  const text = `---\ncomsift_profile_data: '${data}'\ncomsift_same:\n  - "[[Case/Case]]"\n---\n\n\`\`\`comsift-person\n\`\`\`\n\n## Notes\n\n- not: a field\n`;
  const records = identity.readProfileRecords(text);
  assert.equal(records.length, 1);
  assert.equal(records[0].fields.username, "fixture.account");
  assert.equal(records[0].fields.not, undefined);
});

test("merging documents keeps both notes and relationship marks", () => {
  const left = identity.mergeProfileContent([rec("Case/a.sheet.md")], "x", "---\ncomsift_same:\n  - \"[[Case/Case]]\"\n---\nFirst.\n");
  const right = identity.mergeProfileContent([rec("Case/b.sheet.md")], "x", "---\ncomsift_related:\n  - \"[[Other/Other]]\"\n---\nSecond.\n");
  const merged = identity.mergeProfileDocuments([rec("Case/a.sheet.md"), rec("Case/b.sheet.md")], "x", [left, right]);
  for (const expected of ["First.", "Second.", "[[Case/Case]]", "[[Other/Other]]"]) assert.ok(merged.includes(expected), expected);
  assert.equal((merged.match(/```comsift-person/g) ?? []).length, 1);
  assert.equal((merged.match(/^## Notes$/gm) ?? []).length, 1);
  assert.doesNotMatch(merged, /Metadata preserved/);
});

test("cell references parse A1, ranges, sheet names and several rectangles", () => {
  assert.deepEqual(cells.parseCellRef("A1"), { ranges: [{ sri: 0, sci: 0, eri: 0, eci: 0 }] });
  assert.deepEqual(cells.parseCellRef("#A1:B2"), { ranges: [{ sri: 0, sci: 0, eri: 1, eci: 1 }] });
  assert.deepEqual(cells.parseCellRef("Sheet1!B3:C4"), { sheet: "Sheet1", ranges: [{ sri: 2, sci: 1, eri: 3, eci: 2 }] });
  assert.deepEqual(cells.parseCellRef("'My ''tab'''!AA10"), { sheet: "My 'tab'", ranges: [{ sri: 9, sci: 26, eri: 9, eci: 26 }] });
  assert.equal(cells.parseCellRef("Sheet1!A1:C1, A7:C7").ranges.length, 2);
  for (const bad of ["Sheet1", "Notes", "B2:A1", "", "A0"]) assert.equal(cells.parseCellRef(bad), null, bad);
  assert.deepEqual(cells.splitEmbedLink("Case/x.sheet.md#Sheet1!A1|alias"), { path: "Case/x.sheet.md", subpath: "Sheet1!A1" });
  assert.equal(cells.formatCellRef({ sheet: "Sheet1", ranges: [{ sri: 0, sci: 1, eri: 0, eci: 3 }, { sri: 6, sci: 1, eri: 6, eci: 1 }] }), "Sheet1!B1:D1,B7");
  assert.equal(cells.formatCellRef({ sheet: "My tab", ranges: [{ sri: 0, sci: 0, eri: 0, eci: 0 }] }), "'My tab'!A1");
  const table = { name: "Sheet1", rows: [["a", "b"], ["c"]] };
  assert.deepEqual(cells.cellBlocks(table, [{ sri: 0, sci: 0, eri: 2, eci: 2 }])[0].rows, [["a", "b", ""], ["c", "", ""], ["", "", ""]]);
});

test("source cells find the header row and the section columns of an imported row", () => {
  const rows = [
    ["FOLLOWING", "Display name", "Username", "Profile link", "FOLLOWERS", "Display name", "Username", "Profile link"],
    ["", "Ann", "@ann", "https://example.test/ann", "", "Fixture", "fixture.account", "https://example.test/fixture"],
    ["", "Bo", "@bo", "", "", "Kai", "kai_k", ""],
  ];
  const record = { dataset: "Case/x.sheet.md#Sheet1", row: 2, raw: { FOLLOWERS: "", "Display name": "Kai", Username: "kai_k", "Profile link": "" } };
  const found = cells.sourceCells(rows, record);
  assert.equal(found.path, "Case/x.sheet.md");
  assert.equal(found.sheet, "Sheet1");
  assert.equal(cells.formatCellRef({ sheet: found.sheet, ranges: found.ranges }), "Sheet1!E1:H1,E3:H3");
  // Without the section column the matching data values still pick the right section.
  const plain = cells.sourceCells(rows, { ...record, raw: { "Display name": "Ann", Username: "@ann", "Profile link": "https://example.test/ann" }, row: 1 });
  assert.equal(cells.formatCellRef({ ranges: plain.ranges }), "B1:D1,B2:D2");
  // Ranges limit the columns; the stored row is already absolute.
  const ranged = cells.sourceCells(rows, { dataset: "Case/x.sheet.md#Sheet1@E1:H3", row: 1, raw: { "Display name": "Fixture", Username: "fixture.account" } });
  assert.equal(cells.formatCellRef({ ranges: ranged.ranges }), "F1:G1,F2:G2");
  // No raw headers: the populated part of the row, with the first well-filled row above as its header.
  assert.equal(cells.formatCellRef({ ranges: cells.sourceCells(rows, { dataset: "Case/x.sheet.md", row: 2 }).ranges }), "B1:G1,B3:G3");
  assert.equal(cells.formatCellRef({ ranges: cells.sourceCells([["", ""], ["x", "y"]], { dataset: "x.csv", row: 1 }).ranges }), "A2:B2");
  assert.equal(cells.sourceCells(rows, { dataset: "Case/x.sheet.md", row: 40 }), null);
});

test("cell targets: opening a reference selects its cells on the right tab", () => {
  assert.deepEqual(cells.cellTargetFromSubpath("#B4"), { sri: 3, sci: 1, eri: 3, eci: 1 });
  assert.deepEqual(cells.cellTargetFromSubpath("Sheet2!B4:C6"), { sheet: "Sheet2", sri: 3, sci: 1, eri: 5, eci: 2 });
  assert.deepEqual(cells.cellTargetFromSubpath("'My tab'!AA10"), { sheet: "My tab", sri: 9, sci: 26, eri: 9, eci: 26 });
  assert.equal(cells.cellTargetFromSubpath("Sheet1"), null);
  assert.equal(cells.cellTargetFromSubpath(""), null);
  // Header row + data row (person card sources): the data row by default, any block on request.
  const ref = cells.parseCellRef("Sheet1!E1:H1,E3:H3");
  assert.deepEqual(cells.cellTarget(ref), { sheet: "Sheet1", sri: 2, sci: 4, eri: 2, eci: 7 });
  assert.deepEqual(cells.cellTarget(ref, 0), { sheet: "Sheet1", sri: 0, sci: 4, eri: 0, eci: 7 });
  assert.deepEqual(cells.cellTarget(ref, 9), { sheet: "Sheet1", sri: 2, sci: 4, eri: 2, eci: 7 });
  assert.equal(cells.cellTarget({ ranges: [] }), null);
  // The target round-trips through a link subpath.
  const target = cells.cellTarget(ref);
  const subpath = cells.formatCellRef({ sheet: target.sheet, ranges: [{ sri: target.sri, sci: target.sci, eri: target.eri, eci: target.eci }] });
  assert.equal(subpath, "Sheet1!E3:H3");
  assert.deepEqual(cells.cellTargetFromSubpath(subpath), target);
});

test("CSV reader handles quotes, commas and CRLF", () => {
  assert.deepEqual(cells.parseCsv('﻿name,bio\r\n"Fixture","likes ""tea"", cats"\r\nKai,\n'), [["name", "bio"], ["Fixture", 'likes "tea", cats'], ["Kai", ""]]);
});

test("marks link a profile to a person and to another profile; changing type replaces the old mark", () => {
  const front = { comsift_related: ["[[Case/Connections/kai_k (instagram)]]"] };
  const isPerson = value => marks.markLinkTarget(value) === "Case/Case";
  marks.setMark(front, "same", "[[Case/Case]]", isPerson);
  marks.setMark(front, "uncertain", "[[Other/Connections/fixture (tiktok)]]", value => marks.markLinkTarget(value) === "Other/Connections/fixture (tiktok)");
  assert.deepEqual(marks.readMarks(front), [
    { type: "same", value: "[[Case/Case]]" },
    { type: "related", value: "[[Case/Connections/kai_k (instagram)]]" },
    { type: "uncertain", value: "[[Other/Connections/fixture (tiktok)]]" },
  ]);
  marks.setMark(front, "related", "[[Case/Case]]", isPerson);
  assert.deepEqual(front.comsift_related, ["[[Case/Connections/kai_k (instagram)]]", "[[Case/Case]]"]);
  assert.equal(front.comsift_same, undefined);
  marks.setMark(front, "none", "", isPerson);
  assert.deepEqual(front.comsift_related, ["[[Case/Connections/kai_k (instagram)]]"]);
});

test("upgrading an old note without stored data first saves its rows in frontmatter", () => {
  const legacy = "---\ncomsift_records:\n  - \"Case/a.sheet.md:4\"\n---\n<!-- comsift:profile:start -->\n# fixture (instagram)\n\nSources:\n- [[Case/a.sheet]], row 4\n\n- username: fixture\n- platform: instagram\n<!-- comsift:profile:end -->\nMine.\n";
  const before = identity.readProfileRecords(legacy);
  assert.equal(before.length, 1);
  const next = identity.upgradeProfileNote(legacy);
  assert.match(next, /^comsift_profile_data: /m);
  assert.doesNotMatch(next, /comsift:profile:start/);
  assert.deepEqual(identity.readProfileRecords(next), before);
  assert.match(next, /## Notes\n\nMine\.\n$/);
  assert.equal(identity.upgradeProfileNote(next), next);
});
