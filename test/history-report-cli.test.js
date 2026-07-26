import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { inspectRepositoryEnrollment } from "../src/repository-enrollment.js";
import { ObservationLedger } from "../src/observation-ledger.js";
import { RepositoryRegistryStore } from "../src/repository-registry.js";
import { JsonlEventStore } from "../src/store.js";

const exec = promisify(execFile);
const main = fileURLToPath(new URL("../src/main.js", import.meta.url));

async function git(root, ...args) {
  const { stdout } = await exec("git", ["-C", root, ...args], { encoding: "utf8" });
  return stdout.trim();
}

function policy() {
  return {
    version: 1,
    repository: { kind: "remote", id: "acme/history", provider: "github" },
    lifecycle: { state: "active", dormantAfterDays: 30 },
    signals: [{
      kind: "verify",
      requirement: "required",
      subject: "revision",
      appliesTo: "every-revision",
      freshness: { mode: "revision" },
      acceptedSources: ["local-command"],
    }],
    adapters: [],
  };
}

function observation({ id, status, revision, observedAt }) {
  return {
    specversion: "1.0",
    id,
    source: "urn:proofwake:adapter:local-command",
    type: "dev.proofwake.observation.verify.v1",
    subject: `repo:acme/history@sha:${revision}`,
    time: observedAt,
    dataschema: "urn:proofwake:schema:observation:v1",
    data: {
      schemaVersion: 1,
      adapter: {
        name: "local-command",
        version: "1.0.0",
        mappingVersion: 1,
        trust: "local-operator",
        sourceSchema: "proofwake.test.fixture",
        sourceSchemaVersion: "1",
      },
      kind: "verify",
      status,
      timeSource: "adapter",
      observedAt,
      ingestedAt: new Date(Date.parse(observedAt) + 1000).toISOString(),
      relationships: { repository: "acme/history", revision, run: id },
      facts: [],
      evidence: [],
      coverage: { state: "complete", redacted: false, truncated: false, omitted: [] },
    },
  };
}

async function fixture(callback) {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-history-cli-"));
  const root = join(directory, "checkout");
  const registryPath = join(directory, "repositories.json");
  const dataPath = join(directory, "events.jsonl");
  try {
    await mkdir(root);
    await exec("git", ["init", "-q", "-b", "main", root]);
    await git(root, "config", "user.name", "Proofwake Test");
    await git(root, "config", "user.email", "proofwake@example.invalid");
    await git(root, "remote", "add", "origin", "https://github.com/acme/history.git");
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(join(root, ".proofwake.json"), `${JSON.stringify(policy(), null, 2)}\n`);
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "initial");
    const revision = await git(root, "rev-parse", "HEAD");

    const registryStore = new RepositoryRegistryStore(registryPath);
    await registryStore.enroll(await inspectRepositoryEnrollment(root));
    const ledger = new ObservationLedger(new JsonlEventStore(dataPath));
    const base = Date.now() - 60_000;
    await ledger.append(observation({ id: "failure-one", status: "failed", revision, observedAt: new Date(base).toISOString() }));
    await ledger.append(observation({ id: "passing", status: "passed", revision, observedAt: new Date(base + 10_000).toISOString() }));
    await ledger.append(observation({ id: "failure-two", status: "failed", revision, observedAt: new Date(base + 20_000).toISOString() }));

    await callback({ directory, root, registryPath, dataPath, revision });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function command(name, args) {
  return exec(process.execPath, [main, name, ...args], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
}

test("installed failures and recoveries commands return policy-matched JSON without private paths", async () => {
  await fixture(async ({ directory, root, registryPath, dataPath, revision }) => {
    const common = ["--days", "1", "--registry", registryPath, "--data", dataPath, "--output", "json"];
    const failuresResult = await command("failures", common);
    assert.equal(failuresResult.stderr, "");
    const failures = JSON.parse(failuresResult.stdout);
    assert.equal(failures.summary.total, 2);
    assert.equal(failures.summary.unresolved, 1);
    assert.equal(failures.summary.resolved, 1);
    assert.equal(failures.failures[0].id, "failure-two");
    assert.equal(failures.failures[1].resolvedBy.id, "passing");
    assert.equal(failures.failures[0].revision, revision);

    const recoveriesResult = await command("recoveries", common);
    assert.equal(recoveriesResult.stderr, "");
    const recoveries = JSON.parse(recoveriesResult.stdout);
    assert.equal(recoveries.summary.total, 1);
    assert.equal(recoveries.recoveries[0].from.id, "failure-one");
    assert.equal(recoveries.recoveries[0].to.id, "passing");

    for (const output of [failuresResult.stdout, recoveriesResult.stdout]) {
      for (const privateValue of [directory, root, registryPath, dataPath, "checkout", "repositories.json", "events.jsonl"]) {
        assert.equal(output.includes(privateValue), false, privateValue);
      }
    }
  });
});

test("history report help avoids storage access and invalid days use exit code 2", async () => {
  for (const name of ["failures", "recoveries"]) {
    const help = await command(name, ["--help"]);
    assert.equal(help.stderr, "");
    assert.match(help.stdout, /rolling observed-time window/);
    await assert.rejects(
      command(name, ["--days", "0", "--output", "json"]),
      (error) => {
        assert.equal(error.code, 2);
        assert.equal(error.stderr, "");
        const body = JSON.parse(error.stdout);
        assert.equal(body.status, "error");
        assert.equal(body.error.code, "HISTORY_REPORT_CLI_USAGE");
        return true;
      },
    );
  }
});
