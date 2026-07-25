import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  resolveStorageIdentity,
  selectCompatibleEnvironment,
} from "../src/identity.js";

const cliPath = resolve("src/cli.js");

function fakeExists(paths) {
  const existing = new Set(paths);
  return async (path) => existing.has(path);
}

function runCli(arguments_, environment = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, ...arguments_], {
      env: { ...process.env, ...environment },
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

test("clean storage resolution uses Proofwake defaults", async () => {
  const identity = await resolveStorageIdentity({
    home: "/home/tester",
    environment: {},
    pathExists: fakeExists([]),
  });

  assert.equal(identity.dataPath, "/home/tester/.proofwake/events.jsonl");
  assert.equal(identity.dataSource, "proofwake-default");
  assert.equal(identity.tokenPath, "/home/tester/.proofwake/collector-token");
  assert.equal(identity.compatibilityMode, false);
  assert.deepEqual(identity.warnings, []);
});

test("existing Shadowbill storage remains active without silent movement", async () => {
  const legacyData = "/home/tester/.shadowbill/events.jsonl";
  const identity = await resolveStorageIdentity({
    home: "/home/tester",
    environment: {},
    pathExists: fakeExists([legacyData]),
  });

  assert.equal(identity.dataPath, legacyData);
  assert.equal(identity.dataSource, "shadowbill-default");
  assert.equal(identity.tokenPath, "/home/tester/.shadowbill/collector-token");
  assert.equal(identity.compatibilityMode, true);
  assert.match(identity.warnings[0], /existing Shadowbill ledger/);
});

test("legacy custom data configuration retains the legacy default token path", async () => {
  const identity = await resolveStorageIdentity({
    home: "/home/tester",
    environment: { SHADOWBILL_DATA: "/custom/events.jsonl" },
    pathExists: fakeExists([]),
  });

  assert.equal(identity.dataPath, "/custom/events.jsonl");
  assert.equal(identity.dataSource, "SHADOWBILL_DATA");
  assert.equal(identity.tokenPath, "/home/tester/.shadowbill/collector-token");
  assert.equal(identity.compatibilityMode, true);
});

test("implicit dual ledgers fail closed", async () => {
  await assert.rejects(
    resolveStorageIdentity({
      home: "/home/tester",
      environment: {},
      pathExists: fakeExists([
        "/home/tester/.proofwake/events.jsonl",
        "/home/tester/.shadowbill/events.jsonl",
      ]),
    }),
    /will not merge ledgers automatically/,
  );
});

test("explicit data selection resolves an otherwise ambiguous installation", async () => {
  const identity = await resolveStorageIdentity({
    home: "/home/tester",
    explicitDataPath: "/chosen/events.jsonl",
    environment: {},
    pathExists: fakeExists([
      "/home/tester/.proofwake/events.jsonl",
      "/home/tester/.shadowbill/events.jsonl",
    ]),
  });

  assert.equal(identity.dataPath, "/chosen/events.jsonl");
  assert.equal(identity.dataSource, "argument");
});

test("Proofwake environment variables override legacy aliases", () => {
  const selected = selectCompatibleEnvironment({
    PROOFWAKE_DATA: "/new/events.jsonl",
    SHADOWBILL_DATA: "/old/events.jsonl",
  }, "PROOFWAKE_DATA", "SHADOWBILL_DATA");

  assert.equal(selected.value, "/new/events.jsonl");
  assert.equal(selected.source, "PROOFWAKE_DATA");
  assert.equal(selected.legacy, false);
  assert.match(selected.warnings[0], /ignored/);
});

test("legacy environment variables remain supported with a bounded warning", () => {
  const selected = selectCompatibleEnvironment({
    SHADOWBILL_TIMEZONE: "America/Los_Angeles",
  }, "PROOFWAKE_TIMEZONE", "SHADOWBILL_TIMEZONE");

  assert.equal(selected.value, "America/Los_Angeles");
  assert.equal(selected.source, "SHADOWBILL_TIMEZONE");
  assert.equal(selected.legacy, true);
  assert.match(selected.warnings[0], /compatibility alias/);
});

test("status reports active identity and never prints token values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-status-"));
  const dataPath = join(directory, "events.jsonl");
  const tokenPath = join(directory, "collector-token");
  const secret = "a-secret-value-that-must-never-be-returned";
  try {
    const result = await runCli([
      "status",
      "--data", dataPath,
      "--collector-token-file", tokenPath,
      "--json",
    ], {
      PROOFWAKE_COLLECTOR_TOKEN: secret,
      PROOFWAKE_TIMEZONE: "America/Los_Angeles",
    });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, new RegExp(secret));
    const status = JSON.parse(result.stdout);
    assert.equal(status.service, "proofwake");
    assert.equal(status.legacyAlias, "shadowbill");
    assert.equal(status.configuration.dataPath, dataPath);
    assert.equal(status.configuration.dataSource, "argument");
    assert.equal(status.configuration.collectorTokenSource, "PROOFWAKE_COLLECTOR_TOKEN");
    assert.equal(status.configuration.timeZoneSource, "PROOFWAKE_TIMEZONE");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
