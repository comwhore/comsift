import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const bundle = await build({ entryPoints: ["src/analysis/adaptiveContext.ts"], bundle: true, platform: "node", format: "esm", write: false });
const { adaptiveMessages, contextOverflow, parseContextPlan } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].contents).toString("base64"));

test("overflow reduction retains whole relationship summaries and reduces full note contents", () => {
  const blocks = [
    { id: "board", title: "node a; node b; edge a -> b type=related; edge b -> a type=uncertain", content: "x".repeat(3000) },
    { id: "note", title: "Note.md (title only)", content: "private facts ".repeat(100) },
  ];
  const full = adaptiveMessages("system", [], "question", blocks, 5000);
  const reduced = adaptiveMessages("system", [], "question", blocks, 5000, 1);
  assert.ok(JSON.stringify(reduced).length < JSON.stringify(full).length);
  assert.match(reduced.at(-1).content, /edge a -> b type=related; edge b -> a type=uncertain/);
  assert.doesNotMatch(reduced.at(-1).content, /private facts/);
});

test("selector plans reject unknown paths, malformed density and null", () => {
  const allowed = new Set(["a"]);
  assert.deepEqual(parseContextPlan('{"items":[{"id":"a","density":"title"}]}', allowed).ids, ["a"]);
  for (const value of ['null', '{"items":[{"id":"evil","density":"full"}]}', '{"items":[{"id":"a","density":"execute"}]}']) assert.throws(() => parseContextPlan(value, allowed));
});

test("request bounds include history and question; oversized prompt fails explicitly", () => {
  const messages = adaptiveMessages("s", Array.from({ length: 30 }, () => ({ role: "user", content: "h".repeat(400) })), "q", [{ id: "a", title: "a", content: "x".repeat(5000) }], 1000);
  assert.ok(JSON.stringify(messages).length < 2000);
  assert.throws(() => adaptiveMessages("system", [], "q".repeat(3000), [], 1000), /Shorten/);
  assert.equal(contextOverflow(new Error("maximum context length exceeded")), true);
  assert.equal(contextOverflow(new Error("Invalid API key")), false);
});

test("explicit file mentions retain complete content even when the selector excludes them and on retry", () => {
  const content = "Full required evidence including the final line.";
  const blocks = [{ id: "Pinned.md", title: "Pinned", content, required: true }, { id: "Other.md", title: "Other", content: "optional" }];
  const plan = { ids: ["Other.md"], density: new Map([["Other.md", "title"]]) };
  for (const attempt of [0, 1, 2]) {
    const request = adaptiveMessages("s", [], "q", blocks, 8192, attempt, plan);
    assert.ok(request.at(-1).content.includes(content));
    assert.match(request.at(-1).content, /required="true"/);
  }
});

test("oversized explicit file fails instead of silently shortening or dropping it", () => {
  assert.throws(() => adaptiveMessages("s", [], "q", [{ id: "Big.md", title: "Big", content: "x".repeat(10000), required: true }], 1000), /mentioned files are never shortened/);
});
