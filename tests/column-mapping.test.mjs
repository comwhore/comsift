import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const bundled = await build({ entryPoints: ["src/analysis/columnMapping.ts"], bundle: true, platform: "node", format: "esm", write: false });
const { columnMismatches, datasetLabel } = await import("data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].contents).toString("base64"));
const dataset = (name, columns) => ({ name, columns });
test("malformed saved mapping values are ignored without unsafe string calls", () => {
  const rows = [dataset("a", ["username"]), dataset("b", ["username"])];
  for (const value of ['null', '[]', '{"a":null}', '{"a":{"_ignore":42,"username":{}}}', '{"*":true}', '{']) {
    assert.ok(columnMismatches(rows, value).every(row => !row.mismatch));
  }
});
test("mismatch compares effective mapping and prioritizes uncommon schemas", () => {
  const rows = [dataset("a", ["handle", "bio"]), dataset("b", ["username", "bio"]), dataset("z", ["account", "city"])];
  assert.equal(columnMismatches(rows, "{}")[0].name, "z");
  assert.deepEqual(columnMismatches(rows, "{}")[0].mismatching, ["account", "city"]);
  const mapped = columnMismatches(rows, JSON.stringify({ z: { username: "account", bio: "city" } }));
  assert.ok(mapped.every(row => !row.mismatch));
});
test("two datasets still report mismatches; ignored fields do not cause mismatches", () => {
  const rows = [dataset("a", ["username", "extra"]), dataset("b", ["username"])];
  assert.ok(columnMismatches(rows, "{}").every(row => row.mismatch));
  assert.ok(columnMismatches(rows, JSON.stringify({ a: { _ignore: "extra" } })).every(row => !row.mismatch));
  assert.equal(columnMismatches([rows[0]], "{}")[0].mismatch, false);
  assert.equal(datasetLabel("folder/book.sheet.md#Accounts"), "book.sheet#Accounts");
});
test("column aliases match the analysis parser's canonical fields", () => {
  const rows = [dataset("a", ["homepage", "account_id", "real name", "member since"]),
    dataset("b", ["website", "user_id", "display_name", "created"])];
  assert.ok(columnMismatches(rows, "{}").every(row => !row.mismatch));
});

const api = await import("data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].contents).toString("base64"));
const identityBundle = await build({ entryPoints: ["src/analysis/connectionIdentity.ts", "src/analysis/profileIdentity.ts"], bundle: true, platform: "node", format: "esm", write: false, outdir: "out" });
const load = name => import("data:text/javascript;base64," + Buffer.from(identityBundle.outputFiles.find(file => file.path.endsWith(name)).contents).toString("base64"));
const { exactProfileMatch } = await load("connectionIdentity.js");
const { profileComponents } = await load("profileIdentity.js");
const role = (choices, column) => choices.find(choice => choice.column === column);
// Shape of a real side-by-side follower export (FOLLOWING | FOLLOWERS | IN COMMON blocks plus totals).
const tiktok = {
  name: "Person/bob tiktok.sheet.md#Sheet1",
  columns: ["FOLLOWING", "Display name", "Username", "Profile link", "FOLLOWERS", "IN COMMON", "MISSING FOLLOWING:", "0"],
  samples: { "Display name": ["alice", "bob"], Username: ["alice_a", "bob_b"], "Profile link": ["https://www.tiktok.com/@alice_a", "https://www.tiktok.com/@bob_b"] },
  filled: { FOLLOWING: 0, "Display name": 2, Username: 2, "Profile link": 2, FOLLOWERS: 0, "IN COMMON": 0, "MISSING FOLLOWING:": 0, "0": 0 },
  distinct: { "Display name": 2, Username: 2, "Profile link": 2 }, rows: 2,
  examples: [{ "Display name": "alice", Username: "alice_a", "Profile link": "https://www.tiktok.com/@alice_a" }],
};

test("follower exports are recognised automatically, including labels and counters to skip", () => {
  const choices = api.resolveColumns(tiktok);
  for (const column of ["FOLLOWING", "FOLLOWERS", "IN COMMON", "MISSING FOLLOWING:", "0"]) assert.equal(role(choices, column).role, "skip", column);
  assert.deepEqual(["Display name", "Username", "Profile link"].map(column => role(choices, column).role), ["display_name", "username", "profile_url"]);
  assert.ok(role(choices, "Username").identity && role(choices, "Profile link").identity && !role(choices, "Display name").identity);
  assert.deepEqual(api.columnConflicts(choices), []);
});

test("values decide unknown headers", () => {
  const dataset = { name: "x.csv", columns: ["Contact", "Who", "Page", "When", "Pic", "Mobile no", "Notes", "Site", "Link"], rows: 3,
    samples: { Contact: ["a@example.test", "b@example.test"], Who: ["@ann", "@bob"], Page: ["https://www.instagram.com/ann", "https://x.com/bob"],
      When: ["2021-04-01", "2023-01-02"], Pic: ["https://cdninstagram.com/a.jpg", "https://cdninstagram.com/b.jpg"], "Mobile no": ["+48 600 100 200", "+1 (555) 123-4567"],
      Notes: ["likes cats", "met at school"], Site: ["roblox", "roblox", "roblox"], Link: ["ann", "bob"] },
    filled: { Contact: 2, Who: 2, Page: 2, When: 2, Pic: 2, "Mobile no": 2, Notes: 2, Site: 3, Link: 2 }, distinct: { Site: 1, Notes: 2 } };
  const choices = api.resolveColumns(dataset);
  assert.deepEqual([role(choices, "Contact").role, role(choices, "Contact").name, role(choices, "Contact").identity], ["other", "email", true]);
  assert.equal(role(choices, "Who").role, "username");
  assert.equal(role(choices, "Page").role, "profile_url");
  assert.equal(role(choices, "When").role, "created");
  assert.equal(role(choices, "Pic").role, "avatar_url");
  assert.deepEqual([role(choices, "Mobile no").name, role(choices, "Mobile no").identity], ["phone", true]);
  assert.deepEqual([role(choices, "Notes").role, role(choices, "Notes").confidence], ["other", "low"]);
  assert.equal(role(choices, "Site").role, "platform", "a constant platform column is meaningful");
  assert.notEqual(role(choices, "Link").role, "profile_url", "a 'link' header without links is not a profile link");
  assert.equal(api.detectColumn("status", { samples: { status: ["x", "x", "x"] }, filled: { status: 3 }, distinct: { status: 1 }, rows: 3 }).role, "skip");
});

test("automatic duplicates are demoted instead of reported; saved duplicates are real conflicts", () => {
  const dataset = { name: "x.csv", columns: ["Profile link", "url"] };
  const choices = api.resolveColumns(dataset);
  assert.deepEqual(choices.map(choice => choice.role), ["profile_url", "other"]);
  assert.deepEqual(api.columnConflicts(choices), []);
  const saved = api.resolveColumns(dataset, { profile_url: "Profile link", "profile_url ": "url" });
  assert.equal(saved[0].role, "profile_url");
  const conflicting = api.resolveColumns({ name: "y.csv", columns: ["a", "b"] }, { username: "a", user: "b" });
  assert.equal(conflicting[1].role, "other");
  const explicit = [{ ...conflicting[0] }, { ...conflicting[1], role: "username", source: "saved" }];
  assert.equal(api.columnConflicts(explicit).length, 1);
});

test("old mappings keep working and unmentioned columns are filled in", () => {
  const saved = { _ignore: "FOLLOWING\nProfile link\nFOLLOWERS\nIN COMMON", display_name: "Display name", username: "Username" };
  const choices = api.resolveColumns(tiktok, saved);
  assert.equal(role(choices, "Profile link").role, "skip");
  assert.equal(role(choices, "Profile link").source, "saved");
  assert.equal(role(choices, "Profile link").detected.role, "profile_url", "the suggestion stays visible");
  assert.equal(role(choices, "MISSING FOLLOWING:").source, "auto");
  assert.equal(role(choices, "Username").identity, true);
  const mapping = api.choicesToMapping(choices);
  assert.equal(mapping.username, "Username");
  assert.ok(mapping._ignore.split("\n").includes("Profile link") && mapping._ignore.split("\n").includes("0"));
  assert.equal(api.mappedField("Username", saved), "username");
});

test("mapping round-trips identity, matching and skipped rows", () => {
  const dataset = { name: "x.csv", columns: ["user", "Discord", "City", "junk"] };
  const choices = api.resolveColumns(dataset).map(choice =>
    choice.column === "Discord" ? { ...choice, role: "other", name: "discord", identity: true } :
    choice.column === "City" ? { ...choice, match: false } : choice.column === "junk" ? { ...choice, role: "skip" } : choice);
  const mapping = api.choicesToMapping(choices, { requireIdentity: true });
  assert.deepEqual(mapping, { username: "user", discord: "Discord", location: "City", _ignore: "junk", _identity: "Discord", _nomatch: "City", _require_identity: "1" });
  const again = api.resolveColumns(dataset, mapping);
  assert.deepEqual(again.map(c => [c.role, c.name, c.identity, c.match]), choices.map(c => [c.role, c.role === "other" ? c.name : "", c.role !== "skip" && c.identity, c.match]));
  const effective = api.effectiveMapping(dataset, mapping, {});
  assert.equal(effective._require_identity, "1");
});

test("choices are remembered by column layout and reused for similar exports", () => {
  const mapping = { username: "Username", display_name: "Display name", _ignore: "Profile link\nFOLLOWING\nFOLLOWERS\nIN COMMON\nMISSING FOLLOWING:\n0", _identity: "" };
  const saved = { [api.layoutKey(tiktok.columns)]: mapping };
  const same = api.resolveColumns({ ...tiktok, name: "other.csv" }, api.savedMappingFor(saved, "other.csv"), api.findLayout(tiktok.columns, saved));
  assert.equal(role(same, "Profile link").role, "skip");
  assert.equal(role(same, "Profile link").source, "layout");
  const similar = [...tiktok.columns, "Bio"];
  assert.ok(api.findLayout(similar, saved), "one extra column still matches the remembered layout");
  assert.equal(api.findLayout(["a", "b", "c"], saved), undefined);
  const effective = api.effectiveMapping({ ...tiktok, name: "other.csv" }, {}, saved);
  assert.ok(effective._ignore.includes("Profile link"));
  assert.equal(api.layoutKey(["B", "a", "a"]), "headers:a|b");
});

test("copying choices and previewing one profile", () => {
  const source = api.resolveColumns({ name: "a.csv", columns: ["Username", "Email"] });
  const target = api.resolveColumns({ name: "b.csv", columns: ["Email", "Other"] });
  source[1] = { ...source[1], identity: false, match: false };
  const copied = api.copyChoices(source, target);
  assert.deepEqual([copied[0].identity, copied[0].match, copied[0].source], [false, false, "saved"]);
  assert.equal(copied[1], target[1]);
  const preview = api.previewProfile(api.resolveColumns(tiktok), tiktok.examples[0]);
  assert.equal(preview.title, "alice");
  assert.deepEqual(preview.identity, [["Username", "alice_a"], ["Profile link", "https://www.tiktok.com/@alice_a"]]);
  assert.deepEqual(preview.details, [["Display name", "alice"]]);
  assert.ok(preview.skipped.includes("MISSING FOLLOWING:"));
  assert.equal(api.previewProfile(api.resolveColumns(tiktok), { "Display name": "Total" }, true).isPerson, false);
});

test("mismatch reporting uses automatic roles and lists conflicts", () => {
  const rows = api.columnMismatches([tiktok, { ...tiktok, name: "b.sheet.md#Sheet1" }], "{}");
  assert.ok(rows.every(row => !row.mismatch && row.conflicts.length === 0));
  const broken = api.columnMismatches([{ name: "a.csv", columns: ["a", "b"] }], JSON.stringify({ "a.csv": { username: "a", "username ": "b" } }));
  assert.equal(broken[0].conflicts.length, 1, "two saved columns producing one field is a real conflict");
  assert.deepEqual(api.columnMismatches([{ name: "P/Connections/x.md", columns: ["username", "id:email"] }, { name: "a.csv", columns: ["username", "Email"] }], "{}")
    .every(row => !row.mismatch), true);
});

test("user-chosen identity fields merge and block profiles", () => {
  const a = { platform: "instagram", display_name: "Ann", "id:email": "ann@example.test" };
  assert.equal(exactProfileMatch(a, { platform: "instagram", "id:email": "ANN@example.test " }), true);
  assert.equal(exactProfileMatch(a, { platform: "instagram", display_name: "Ann", "id:email": "other@example.test" }), false);
  assert.equal(exactProfileMatch(a, { platform: "tiktok", "id:email": "ann@example.test" }), false);
  const entry = (path, fields) => ({ path, scope: "P", text: "", records: [{ id: path + ":1", dataset: path, row: 1, fields }] });
  const groups = profileComponents([entry("a", a), entry("b", { platform: "instagram", "id:email": "ann@example.test" }), entry("c", { platform: "instagram", "id:email": "bob@example.test" })], []);
  assert.equal(groups.length, 2);
});


test("identity fields can remain on profiles while being excluded from matching", () => {
  const dataset = { name: "x.csv", columns: ["Username", "Profile link", "Email"] };
  const choices = api.resolveColumns(dataset);
  role(choices, "Username").match = false;
  role(choices, "Email").match = false;
  const mapping = api.choicesToMapping(choices);
  assert.equal(mapping._nomatch, "Username\nEmail");
  assert.equal(api.columnConflicts(choices).length, 0);
  const again = api.resolveColumns(dataset, mapping);
  assert.equal(role(again, "Username").identity, true);
  assert.equal(role(again, "Username").match, false);
  assert.equal(role(again, "Email").match, false);
  assert.ok(api.previewProfile(choices, { Username: "alice", "Profile link": "https://example.test/alice" }).unmatched.includes("Username"));
  choices.forEach(choice => { choice.match = false; });
  assert.match(api.columnConflicts(choices).join(" "), /at least one identity column/);
});

test("canonical account fields can be matched without defining profile identity", () => {
  const dataset = { name: "x.csv", columns: ["Username", "Profile link"] };
  const choices = api.resolveColumns(dataset);
  role(choices, "Username").identity = false;
  const mapping = api.choicesToMapping(choices);
  assert.equal(mapping._noidentity, "Username");
  const roundTrip = api.resolveColumns(dataset, mapping);
  assert.equal(role(roundTrip, "Username").identity, false);
  assert.equal(role(roundTrip, "Username").match, true);
  assert.equal(role(roundTrip, "Profile link").identity, true);
});

test("matching and profile identity must share at least one column", () => {
  const choices = api.resolveColumns({ name: "x.csv", columns: ["Username", "Profile link", "Bio"] });
  role(choices, "Username").match = false;
  role(choices, "Profile link").identity = false;
  assert.match(api.columnConflicts(choices).join(" "), /at least one identity column/);
  role(choices, "Username").match = true;
  assert.equal(api.columnConflicts(choices).length, 0);
});
