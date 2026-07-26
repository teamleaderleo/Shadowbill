import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const harness = fileURLToPath(new URL("../scripts/fuzz-observation-cli.mjs", import.meta.url));

test("observation CLI rejects a deterministic mutation corpus", async () => {
  const { stdout, stderr } = await exec(process.execPath, [harness, "80", "20260726"], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
  });
  assert.equal(stderr, "");
  const result = JSON.parse(stdout);
  assert.equal(result.status, "passed");
  assert.equal(result.iterations, 80);
  assert.equal(result.seed, 20260726);
  assert.equal(result.operatorCount, 20);
  assert.equal(result.exercisedOperators, result.operatorCount);
  assert.equal(result.operatorHits.length, result.operatorCount);
  assert.equal(result.operatorHits.every((count) => Number.isSafeInteger(count) && count > 0), true);
  assert.equal(result.distinctErrorCodes >= 8, true);
  assert.equal(Object.keys(result.errors).every((code) => code.startsWith("OBSERVATION_")), true);
});
