import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const bundle = await build({ entryPoints: ["src/analysis/runner.ts"], bundle: true,
  platform: "node", format: "esm", write: false, loader: { ".py": "text" } });
const { AnalysisRunner } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].contents).toString("base64"));

test("Python runner validates envelopes and rejects process failures even with success output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "comsift-runner-test-"));
  const worker = join(directory, "worker.cjs");
  try {
    for (const [response, code, expected] of [
      [null, 0, /envelope/],
      [{ ok: "yes", result: {} }, 0, /envelope/],
      [{ ok: false, error: {} }, 0, /envelope/],
      [{ ok: true }, 0, /no result/],
      [{ ok: true, result: {} }, 3, /exit 3/],
      [{ ok: false, error: "Worker rejected request" }, 0, /Worker rejected request/],
      [{ ok: false, error: "KeyError: 'website'" }, 1, /KeyError: 'website'/],
    ]) {
      await writeFile(worker, `process.stdin.resume(); console.log(${JSON.stringify(JSON.stringify(response))}); process.exitCode = ${code};`);
      await assert.rejects(new AnalysisRunner(`"${process.execPath}" "${worker}"`).run({}), expected);
    }
    await writeFile(worker, 'process.stdin.resume(); console.log(JSON.stringify({ok:true,result:{valid:true}}));');
    assert.deepEqual(await new AnalysisRunner(`"${process.execPath}" "${worker}"`).run({}), { valid: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
