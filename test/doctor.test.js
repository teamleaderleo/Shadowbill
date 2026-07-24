import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildDoctorReport, doctorExitCode, formatDoctorReport } from "../src/doctor.js";

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

function chatEvent(id = "chat_test") {
  return {
    type: "chat_turn",
    id,
    timestamp: "2026-07-25T18:00:00.000Z",
    conversationHash: "conversation-test",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    visibleInputTokens: 10_000,
    visibleOutputTokens: 2_000,
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "shadowbill-doctor-"));
  const dataPath = join(directory, "events.jsonl");
  const tokenPath = join(directory, "collector-token");
  const pricingPath = join(directory, "pricing.json");
  await writeFile(pricingPath, JSON.stringify(pricingCatalog), { mode: 0o600 });
  return {
    directory,
    dataPath,
    tokenPath,
    pricingPath,
    options: {
      dataPath,
      tokenPath,
      pricingPath,
      model: "gpt-5.6-sol",
      timeZone: "America/Los_Angeles",
      now: new Date("2026-07-25T20:00:00.000Z"),
    },
  };
}

function byId(report, id) {
  return report.checks.find((check) => check.id === id);
}

test("doctor reports a clean installation without mutating files", async () => {
  const state = await fixture();
  try {
    await writeFile(state.dataPath, `${JSON.stringify(chatEvent())}\n`, { mode: 0o600 });
    await writeFile(state.tokenPath, "test-token-with-at-least-thirty-two-characters\n", { mode: 0o600 });
    const beforeLedger = await readFile(state.dataPath, "utf8");
    const beforeToken = await readFile(state.tokenPath, "utf8");

    const report = await buildDoctorReport(state.options);

    assert.equal(report.status, "healthy");
    assert.equal(doctorExitCode(report), 0);
    assert.equal(byId(report, "ledger").details.eventCount, 1);
    assert.equal(byId(report, "ledger").details.lastEventAt, "2026-07-25T18:00:00.000Z");
    assert.equal(byId(report, "report").status, "pass");
    assert.match(formatDoctorReport(report), /Shadowbill doctor — healthy/);
    assert.equal(await readFile(state.dataPath, "utf8"), beforeLedger);
    assert.equal(await readFile(state.tokenPath, "utf8"), beforeToken);
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("doctor treats an empty installation as a warning with a zero exit code", async () => {
  const state = await fixture();
  try {
    await writeFile(state.dataPath, "", { mode: 0o600 });
    const report = await buildDoctorReport(state.options);

    assert.equal(report.status, "warning");
    assert.equal(doctorExitCode(report), 0);
    assert.equal(byId(report, "ledger").status, "warn");
    assert.equal(byId(report, "collector-token").status, "warn");
    assert.equal(byId(report, "report").status, "pass");
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("doctor reports active locks and recovery history without removing either", async () => {
  const state = await fixture();
  const lockPath = `${state.dataPath}.lock`;
  const ownerPath = join(lockPath, "owner.json");
  const recoveryPath = `${state.dataPath}.recovery.jsonl`;
  try {
    await writeFile(state.dataPath, `${JSON.stringify(chatEvent())}\n`, { mode: 0o600 });
    await writeFile(state.tokenPath, "test-token-with-at-least-thirty-two-characters\n", { mode: 0o600 });
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(ownerPath, JSON.stringify({
      token: "secret-owner-token",
      pid: 1234,
      acquiredAt: "2026-07-25T19:59:30.000Z",
    }), { mode: 0o600 });
    await writeFile(recoveryPath, [
      JSON.stringify({ recoveredAt: "2026-07-24T10:00:00.000Z", bytesBase64: "c2VjcmV0" }),
      JSON.stringify({ recoveredAt: "2026-07-25T12:00:00.000Z", bytesBase64: "c2VjcmV0Mg==" }),
      "",
    ].join("\n"), { mode: 0o600 });

    const report = await buildDoctorReport(state.options);

    assert.equal(report.status, "warning");
    assert.equal(byId(report, "ledger-lock").status, "warn");
    assert.equal(byId(report, "ledger-lock").details.ownerMetadataPresent, true);
    assert.equal(byId(report, "recovery").details.recordCount, 2);
    assert.equal(byId(report, "recovery").details.latestRecoveryAt, "2026-07-25T12:00:00.000Z");
    assert.equal((await stat(lockPath)).isDirectory(), true);
    assert.equal((await stat(recoveryPath)).isFile(), true);
    assert.doesNotMatch(JSON.stringify(report), /secret-owner-token|c2VjcmV0/);
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("doctor returns errors for corrupted ledgers and insecure permissions", async (context) => {
  const state = await fixture();
  try {
    await writeFile(state.dataPath, `${JSON.stringify(chatEvent())}\nprivate prompt text`, { mode: 0o600 });
    await writeFile(state.tokenPath, "test-token-with-at-least-thirty-two-characters\n", { mode: 0o600 });
    if (process.platform !== "win32") {
      await chmod(state.tokenPath, 0o644);
    } else {
      context.diagnostic("POSIX permission assertion skipped on Windows");
    }

    const report = await buildDoctorReport(state.options);

    assert.equal(report.status, "error");
    assert.equal(doctorExitCode(report), 1);
    assert.equal(byId(report, "ledger").status, "error");
    assert.equal(byId(report, "report").status, "error");
    if (process.platform !== "win32") {
      assert.equal(byId(report, "collector-token-permissions").status, "error");
    }
    assert.doesNotMatch(JSON.stringify(report), /private prompt text/);
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("doctor reports missing models and invalid timezones as configuration errors", async () => {
  const state = await fixture();
  try {
    await writeFile(state.dataPath, `${JSON.stringify(chatEvent())}\n`, { mode: 0o600 });
    const report = await buildDoctorReport({
      ...state.options,
      model: "missing-model",
      timeZone: "Mars/Olympus_Mons",
      tokenFromEnvironment: true,
    });

    assert.equal(report.status, "error");
    assert.equal(byId(report, "pricing").status, "error");
    assert.equal(byId(report, "timezone").status, "error");
    assert.equal(byId(report, "collector-token").details.source, "environment");
    assert.equal(byId(report, "report").status, "error");
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});
