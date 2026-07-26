import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const harness = fileURLToPath(new URL("../scripts/fuzz-observation-cli.mjs", import.meta.url));

const CI_ITERATIONS = 80;
const CI_SEED = 20260726;

test("observation CLI rejects a deterministic mutation corpus", async () => {
  const { stdout, stderr } = await exec(process.execPath, [harness, String(CI_ITERATIONS), String(CI_SEED)], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
  });
  assert.equal(stderr, "");
  const result = JSON.parse(stdout);
  assert.equal(result.status, "passed");
  assert.equal(result.iterations, CI_ITERATIONS);
  assert.equal(result.seed, CI_SEED);
  assert.equal(result.mutationOperators, 20);
  assert.equal(result.operatorsExercised, result.mutationOperators);
  assert.deepEqual(result.selectedOperatorIndexes, Array.from({ length: result.mutationOperators }, (_, index) => index));
  assert.deepEqual(result.missingOperatorIndexes, []);
  assert.equal(result.operatorCount, result.mutationOperators);
  assert.equal(result.exercisedOperators, result.operatorsExercised);
  assert.equal(result.operatorHits.length, result.mutationOperators);
  assert.equal(result.operatorHits.every((count) => Number.isSafeInteger(count) && count > 0), true);
  assert.equal(result.distinctErrorCodes >= 8, true);
  assert.equal(Object.keys(result.errors).every((code) => code.startsWith("OBSERVATION_")), true);
});
