import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DEFAULT_WORKING_PROFILE } from "../src/estimate.js";
import { buildFleetProjection } from "../src/fleet-projection.js";
import { buildRevisionProjection } from "../src/inspect-projection.js";
import { inspectRepositoryEnrollment } from "../src/repository-enrollment.js";
import { ObservationLedger } from "../src/observation-ledger.js";
import { loadPricingCatalog } from "../src/pricing.js";
import { RepositoryRegistryStore } from "../src/repository-registry.js";
import { createCollectorServer, listen } from "../src/server.js";
import { JsonlEventStore } from "../src/store.js";

const exec = promisify(execFile);

async function git(root, ...args) {
  const { stdout } = await exec("git", ["-C", root, ...args], { encoding: "utf8" });
  return stdout.trim();
}

function policy(repository) {
  return {
    version: 1,
    repository: { kind: "remote", id: repository, provider: "github" },
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

async function createRepository(root, repository) {
  await mkdir(root);
  await exec("git", ["init", "-q", "-b", "main", root]);
  await git(root, "config", "user.name", "Proofwake Test");
  await git(root, "config", "user.email", "proofwake@example.invalid");
  await git(root, "remote", "add", "origin", `https://github.com/${repository}.git`);
  await writeFile(join(root, "package.json"), "{}\n");
  await writeFile(join(root, ".proofwake.json"), `${JSON.stringify(policy(repository), null, 2)}\n`);
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "initial");
  return git(root, "rev-parse", "HEAD");
}

function observation(repository, revision) {
  const observedAt = new Date(Date.now() - 5000).toISOString();
  return {
    specversion: "1.0",
    id: "verify-passed",
    source: "urn:proofwake:adapter:local-command",
    type: "dev.proofwake.observation.verify.v1",
    subject: `repo:${repository}@sha:${revision}`,
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
      status: "passed",
      timeSource: "adapter",
      observedAt,
      ingestedAt: new Date(Date.parse(observedAt) + 1000).toISOString(),
      relationships: { repository, revision },
      facts: [],
      evidence: [],
      coverage: { state: "complete", redacted: false, truncated: false, omitted: [] },
    },
  };
}

async function httpJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: pathname, headers: { accept: "application/json" } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function fixture(callback) {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-fleet-dashboard-"));
  const root = join(directory, "demo");
  const repository = "acme/demo";
  try {
    const revision = await createRepository(root, repository);
    const registryStore = new RepositoryRegistryStore(join(directory, "repositories.json"));
    await registryStore.enroll(await inspectRepositoryEnrollment(root));
    const eventStore = new JsonlEventStore(join(directory, "events.jsonl"));
    const catalog = await loadPricingCatalog();
    const pricing = catalog.models["gpt-5.6-sol"];
    const server = createCollectorServer({
      store: eventStore,
      registryStore,
      pricing,
      profile: DEFAULT_WORKING_PROFILE,
      collectorToken: "fleet-dashboard-token",
      timeZone: "UTC",
    });
    const port = await listen(server, 0);
    try {
      await callback({ directory, root, repository, revision, registryStore, eventStore, port });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("fleet HTTP output uses the same projection contract and remains same-origin", async () => {
  await fixture(async ({ repository, revision, registryStore, eventStore, port }) => {
    await new ObservationLedger(eventStore).append(observation(repository, revision));
    const response = await httpJson(port, "/v1/fleet");
    assert.equal(response.status, 200);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.body.summary.green, 1);
    assert.equal(response.body.repositories[0].status, "green");

    const direct = await buildFleetProjection({ registryStore, eventStore, now: new Date() });
    assert.equal(response.body.projectionVersion, direct.projectionVersion);
    assert.equal(response.body.sourceCursor, direct.sourceCursor);
    assert.deepEqual(response.body.attentionOrder, direct.attentionOrder);
    assert.equal(response.body.repositories[0].sourceCursor, direct.repositories[0].sourceCursor);
  });
});

test("revision evidence HTTP output matches direct inspection and validates selectors", async () => {
  await fixture(async ({ repository, revision, registryStore, eventStore, port }) => {
    await new ObservationLedger(eventStore).append(observation(repository, revision));
    const response = await httpJson(port, `/v1/revision-evidence?repository=${repository}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.status, "green");
    assert.equal(response.body.selectedRevision, revision);
    const direct = await buildRevisionProjection({ repository, registryStore, eventStore, now: new Date() });
    assert.equal(response.body.sourceCursor, direct.sourceCursor);
    assert.deepEqual(response.body.signals.map((signal) => signal.state), direct.signals.map((signal) => signal.state));

    const invalid = await httpJson(port, "/v1/revision-evidence?repository=invalid");
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, "PROJECTION_REPOSITORY_REQUIRED");
    const invalidRevision = await httpJson(port, `/v1/revision-evidence?repository=${repository}&revision=abc`);
    assert.equal(invalidRevision.status, 400);
    assert.equal(invalidRevision.body.error.code, "PROJECTION_INVALID_REVISION");
    const missing = await httpJson(port, "/v1/revision-evidence?repository=acme/missing");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "PROJECTION_REPOSITORY_UNKNOWN");
  });
});

test("one invalid repository policy degrades its panel without blanking fleet HTTP", async () => {
  await fixture(async ({ directory, registryStore, port }) => {
    const secondRoot = join(directory, "broken");
    await createRepository(secondRoot, "acme/broken");
    await registryStore.enroll(await inspectRepositoryEnrollment(secondRoot));
    await writeFile(join(secondRoot, ".proofwake.json"), '{"version":1,"version":2}\n');

    const response = await httpJson(port, "/v1/fleet");
    assert.equal(response.status, 200);
    assert.equal(response.body.summary.total, 2);
    const demo = response.body.repositories.find((entry) => entry.repository.identity === "acme/demo");
    const broken = response.body.repositories.find((entry) => entry.repository.identity === "acme/broken");
    assert.ok(demo);
    assert.equal(broken.status, "yellow");
    assert.equal(broken.classification, "misconfigured");
    assert.equal(broken.problems[0].code, "REPOSITORY_POLICY_DUPLICATE_KEY");
  });
});
