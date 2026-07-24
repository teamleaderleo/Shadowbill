import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const cliPath = resolve("src/cli.js");
const pricingCatalog = {
  version: "2026-07-25",
  source: "test",
  models: {
    "gpt-5.6-sol": {
      inputPerMillion: 5,
      cachedInputPerMillion: 0.5,
      cacheWritePerMillion: 6.25,
      outputPerMillion: 30,
      longContextThresholdTokens: 272_000,
      longContextInputMultiplier: 2,
      longContextOutputMultiplier: 1.5,
    },
  },
};

function runDoctor(arguments_) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, "doctor", ...arguments_], {
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

test("doctor CLI returns JSON and does not create token files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadowbill-doctor-cli-"));
  const dataPath = join(directory, "events.jsonl");
  const tokenPath = join(directory, "collector-token");
  const pricingPath = join(directory, "pricing.json");
  try {
    await writeFile(dataPath, "", { mode: 0o600 });
    await writeFile(pricingPath, JSON.stringify(pricingCatalog), { mode: 0o600 });
    const result = await runDoctor([
      "--data", dataPath,
      "--collector-token-file", tokenPath,
      "--pricing", pricingPath,
      "--timezone", "America/Los_Angeles",
      "--json",
    ]);

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "warning");
    assert.equal(report.configuration.tokenPath, tokenPath);
    await assert.rejects(access(tokenPath), (error) => error?.code === "ENOENT");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("doctor CLI returns a nonzero status for errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadowbill-doctor-cli-error-"));
  const dataPath = join(directory, "events.jsonl");
  const tokenPath = join(directory, "collector-token");
  const pricingPath = join(directory, "pricing.json");
  try {
    await writeFile(dataPath, "private prompt text", { mode: 0o600 });
    await writeFile(pricingPath, JSON.stringify(pricingCatalog), { mode: 0o600 });
    const result = await runDoctor([
      "--data", dataPath,
      "--collector-token-file", tokenPath,
      "--pricing", pricingPath,
      "--timezone", "America/Los_Angeles",
      "--json",
    ]);

    assert.equal(result.code, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "error");
    assert.doesNotMatch(result.stdout, /private prompt text/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
