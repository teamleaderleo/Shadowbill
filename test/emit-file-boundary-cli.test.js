import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const mainPath = resolve("src/main.js");

function run(arguments_) {
  return new Promise((resolvePromise, reject) => {
    const env = { ...process.env };
    for (const name of ["PROOFWAKE_DATA", "SHADOWBILL_DATA", "PROOFWAKE_COLLECTOR_TOKEN_FILE", "SHADOWBILL_COLLECTOR_TOKEN_FILE"]) {
      delete env[name];
    }
    const child = spawn(process.execPath, [mainPath, ...arguments_], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

async function temporaryDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-emit-boundary-cli-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("JSON source-unavailable errors are stable and path-minimised", async () => {
  await temporaryDirectory(async (directory) => {
    const missing = join(directory, "private-project", "missing-observation.json");
    const dataPath = join(directory, "events.jsonl");
    const result = await run(["emit", "--json", missing, "--data", dataPath, "--output", "json"]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    const response = JSON.parse(result.stdout);
    assert.deepEqual(response.error, {
      code: "OBSERVATION_SOURCE_UNAVAILABLE",
      message: "Observation file could not be opened.",
    });
    assert.doesNotMatch(result.stdout, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

test("JSON output rejects symbolic-link sources without reading the target", { skip: process.platform === "win32" }, async () => {
  await temporaryDirectory(async (directory) => {
    const privateValue = "private-target-content-that-must-not-appear";
    const target = join(directory, "private.json");
    const link = join(directory, "observation.json");
    const dataPath = join(directory, "events.jsonl");
    await writeFile(target, privateValue);
    await symlink(target, link);

    const result = await run(["emit", "--json", link, "--data", dataPath, "--output", "json"]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    const response = JSON.parse(result.stdout);
    assert.equal(response.error.code, "OBSERVATION_SOURCE_SYMLINK");
    assert.equal(response.error.message, "Observation input must not be a symbolic link.");
    assert.doesNotMatch(result.stdout, new RegExp(privateValue));
    assert.doesNotMatch(result.stdout, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});
