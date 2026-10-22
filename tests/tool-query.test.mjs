import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const result = await build({ entryPoints: ["src/service/toolQuery.ts"], bundle: true, platform: "node", format: "esm", write: false });
const { validToolQuery } = await import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].contents).toString("base64"));
test("tool usernames cannot become options or escape report folders", () => {
  for (const query of ["--help", "../secret", "..\\secret", "a/b", "a\nb", "a b", "", ".", "..", "a".repeat(201)]) assert.equal(validToolQuery(query), false, query);
  for (const query of ["alice", "alice.name", "alice_name", "@alice", "user"]) assert.equal(validToolQuery(query), true, query);
});
