import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../src/main.js", import.meta.url));
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

function runDoctor(args) {
  return spawnSync(process.execPath, [cli, "doctor", ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });
}

test("installed doctor honours an explicit registry outside the data directory and stays read-only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-doctor-installed-"));
  const dataDirectory = join(directory, "data");
  const dataPath = join(dataDirectory, "events.jsonl");
  const defaultRegistryPath = join(dataDirectory, "repositories.json");
  const explicitRegistryPath = join(directory, "approved", "repositories.json");
  const tokenPath = join(directory, "collector-token");
  const pricingPath = join(directory, "pricing.json");
  try {
    await Promise.all([
      mkdir(dataDirectory, { recursive: true }),
      mkdir(join(directory, "approved"), { recursive: true }),
    ]);
    await writeFile(dataPath, "", { mode: 0o600 });
    await writeFile(defaultRegistryPath, '{"version":1,"defaultRegistrySentinel":true}\n', { mode: 0o600 });
    await writeFile(explicitRegistryPath, '{"version":1,"entries":[]}\n', { mode: 0o600 });
    await writeFile(pricingPath, JSON.stringify(pricingCatalog), { mode: 0o600 });

    const result = runDoctor([
      "--data", dataPath,
      "--registry", explicitRegistryPath,
      "--collector-token-file", tokenPath,
      "--pricing", pricingPath,
      "--timezone", "UTC",
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.service, "proofwake");
    assert.equal(report.status, "warning");
    assert.equal(report.configuration.registryPath, explicitRegistryPath);
    assert.equal(report.modules["fleet-readiness"].registry.entryCount, 0);
    assert.equal(result.stdout.includes("defaultRegistrySentinel"), false);
    await assert.rejects(access(tokenPath), (error) => error?.code === "ENOENT");
    assert.equal(await readFile(defaultRegistryPath, "utf8"), '{"version":1,"defaultRegistrySentinel":true}\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installed doctor returns bounded JSON and a nonzero exit for an invalid registry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-doctor-installed-error-"));
  const dataPath = join(directory, "events.jsonl");
  const registryPath = join(directory, "repositories.json");
  const pricingPath = join(directory, "pricing.json");
  try {
    await writeFile(dataPath, "", { mode: 0o600 });
    await writeFile(registryPath, '{"version":1,"entries":[],"privateRegistryValue":"do-not-return-this"}\n', { mode: 0o600 });
    await writeFile(pricingPath, JSON.stringify(pricingCatalog), { mode: 0o600 });

    const result = runDoctor([
      "--data", dataPath,
      "--registry", registryPath,
      "--collector-token-file", join(directory, "collector-token"),
      "--pricing", pricingPath,
      "--timezone", "UTC",
      "--json",
    ]);

    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "error");
    assert.equal(report.checks.find((check) => check.id === "repository-registry").code, "REPOSITORY_REGISTRY_UNKNOWN_FIELD");
    assert.equal(result.stdout.includes("privateRegistryValue"), false);
    assert.equal(result.stdout.includes("do-not-return-this"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installed doctor returns stable usage errors", () => {
  const result = runDoctor(["--registry", "--json"]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const response = JSON.parse(result.stdout);
  assert.equal(response.status, "error");
  assert.equal(response.error.code, "PROOFWAKE_DOCTOR_USAGE");
  assert.equal(response.error.message, "--registry requires a value.");
});
