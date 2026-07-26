import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildRevisionProjection } from "../src/inspect-projection.js";
import { inspectRepositoryEnrollment } from "../src/repository-enrollment.js";
import { RepositoryRegistryStore } from "../src/repository-registry.js";
import { ingestRenderproveReceipt, RENDERPROVE_RECEIPT_SCHEMA } from "../src/renderprove-adapter.js";
import { JsonlEventStore } from "../src/store.js";

const exec = promisify(execFile);
const INGESTION_TIME = new Date("2026-07-26T11:00:00.000Z");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function git(root, ...args) {
  const { stdout } = await exec("git", ["-C", root, ...args], { encoding: "utf8" });
  return stdout.trim();
}

function png(label) {
  return Buffer.concat([PNG_SIGNATURE, Buffer.from(label)]);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function policy() {
  return {
    version: 1,
    repository: { kind: "remote", id: "acme/web", provider: "github" },
    lifecycle: { state: "active", dormantAfterDays: 30 },
    signals: [{
      kind: "browser-review",
      requirement: "required",
      subject: "revision",
      appliesTo: "every-revision",
      freshness: { mode: "revision" },
      acceptedSources: ["adapter:renderprove"],
    }],
    adapters: [{
      name: "renderprove",
      type: "receipt-file",
      path: ".renderprove/receipt.json",
      schema: "renderprove.receipt.v1",
      trust: "verified-receipt",
    }],
  };
}

function receipt({ artifactDigest, status = "passed", baseUrl = "https://private.example.test" }) {
  const failed = status === "failed" ? 1 : 0;
  const diagnostics = status === "failed" ? [{
    at: "2026-07-26T10:00:01.000Z",
    kind: "console",
    message: "private console token=secret",
    url: `${baseUrl}/private`,
  }] : [];
  return {
    $schema: RENDERPROVE_RECEIPT_SCHEMA,
    version: 1,
    project: "private-web-project",
    source: { manifest: "renderprove.json" },
    target: { baseUrl },
    startedAt: "2026-07-26T10:00:00.000Z",
    finishedAt: "2026-07-26T10:00:02.000Z",
    durationMs: 2000,
    status,
    summary: { cases: 1, passed: 1 - failed, failed, diagnostics: diagnostics.length },
    runtime: {
      mode: "local",
      command: ["npm", "run", "review", "--", "--token=private"],
      cwd: "/private/worker/checkout",
      logs: { stdoutBytes: 123, stderrBytes: 456, exit: null },
    },
    cases: [{
      id: "desktop:/account/private",
      status,
      startedAt: "2026-07-26T10:00:00.000Z",
      finishedAt: "2026-07-26T10:00:02.000Z",
      route: {
        name: "private-account",
        path: "/account/private",
        requestedUrl: `${baseUrl}/account/private?token=secret`,
        finalUrl: `${baseUrl}/account/private`,
      },
      viewport: { name: "desktop", width: 1440, height: 900, deviceScaleFactor: 1 },
      navigation: { status: status === "passed" ? 200 : 500, ok: status === "passed" },
      page: {
        title: "Private Account for Jane Doe",
        lang: "en",
        bodyTextLength: 100,
        scrollWidth: 1440,
        clientWidth: 1440,
        scrollHeight: 900,
        clientHeight: 900,
      },
      artifacts: [{ kind: "screenshot", path: ".renderprove/screenshots/private.png", mimeType: "image/png", sha256: artifactDigest }],
      diagnostics,
    }],
  };
}

async function fixture(callback) {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-renderprove-"));
  const root = join(directory, "repo");
  const outside = join(directory, "outside");
  try {
    await mkdir(root);
    await mkdir(outside);
    await exec("git", ["init", "-q", "-b", "main", root]);
    await git(root, "config", "user.name", "Proofwake Test");
    await git(root, "config", "user.email", "proofwake@example.invalid");
    await git(root, "remote", "add", "origin", "https://github.com/acme/web.git");
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(join(root, ".proofwake.json"), `${JSON.stringify(policy(), null, 2)}\n`);
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "initial");
    const revision = await git(root, "rev-parse", "HEAD");
    const registryStore = new RepositoryRegistryStore(join(directory, "repositories.json"));
    const enrolled = await registryStore.enroll(await inspectRepositoryEnrollment(root));
    const eventStore = new JsonlEventStore(join(directory, "events.jsonl"));
    const screenshot = png("digest-verifiable screenshot");
    await mkdir(join(root, ".renderprove", "screenshots"), { recursive: true });
    await writeFile(join(root, ".renderprove", "screenshots", "private.png"), screenshot);
    await writeFile(join(root, ".renderprove", "receipt.json"), `${JSON.stringify(receipt({ artifactDigest: digest(screenshot) }), null, 2)}\n`);
    await callback({ directory, root, outside, revision, entry: enrolled.entry, registryStore, eventStore, screenshot });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a verified passing receipt produces content-minimised browser evidence", async () => {
  await fixture(async ({ directory, revision, entry, registryStore, eventStore }) => {
    const result = await ingestRenderproveReceipt({ entry, eventStore, now: INGESTION_TIME });
    assert.equal(result.status, "inserted");
    assert.equal(result.browserStatus, "passed");
    assert.equal(result.revision, revision);
    assert.equal(result.caseCount, 1);
    assert.equal(result.artifactCount, 1);
    assert.match(result.receiptDigest, /^sha256:[a-f0-9]{64}$/u);

    const events = await eventStore.readAll();
    const observation = events[0].observation;
    assert.equal(events.length, 1);
    assert.equal(observation.data.status, "passed");
    assert.equal(observation.data.adapter.trust, "local-operator");
    assert.deepEqual(observation.data.coverage, { state: "complete", redacted: false, truncated: false, omitted: [] });
    assert.equal(observation.data.evidence.length, 2);
    assert.equal(observation.data.relationships.revision, revision);
    const facts = Object.fromEntries(observation.data.facts.map((fact) => [fact.name, fact.value]));
    assert.equal(facts["renderprove.summary.navigation-failed"], 0);
    assert.equal(facts["renderprove.diagnostics.console"], 0);

    const raw = await readFile(join(directory, "events.jsonl"), "utf8");
    for (const secret of [
      "private.example.test", "Jane Doe", "token=secret", "token=private",
      "/private/worker/checkout", ".renderprove/screenshots/private.png", "private console",
    ]) assert.equal(raw.includes(secret), false, secret);

    const projection = await buildRevisionProjection({ repository: "acme/web", registryStore, eventStore, now: INGESTION_TIME });
    assert.equal(projection.status, "green");
    assert.equal(projection.signals[0].state, "passed");
    assert.equal(projection.signals[0].latest.evidence.length, 2);
  });
});

test("a valid failing receipt becomes failing evidence instead of adapter failure", async () => {
  await fixture(async ({ root, revision, entry, registryStore, eventStore, screenshot }) => {
    await writeFile(join(root, ".renderprove", "receipt.json"), `${JSON.stringify(receipt({ artifactDigest: digest(screenshot), status: "failed" }), null, 2)}\n`);
    const result = await ingestRenderproveReceipt({ entry, eventStore, now: INGESTION_TIME });
    assert.equal(result.browserStatus, "failed");
    const observation = (await eventStore.readAll())[0].observation;
    const facts = Object.fromEntries(observation.data.facts.map((fact) => [fact.name, fact.value]));
    assert.equal(facts["renderprove.summary.navigation-failed"], 1);
    assert.equal(facts["renderprove.diagnostics.console"], 1);
    const projection = await buildRevisionProjection({ repository: "acme/web", revision, registryStore, eventStore, now: INGESTION_TIME });
    assert.equal(projection.status, "red");
    assert.equal(projection.signals[0].state, "failing");
  });
});

test("exact replay is idempotent and producer identity reuse with changed bytes conflicts", async () => {
  await fixture(async ({ root, entry, eventStore, screenshot }) => {
    const first = await ingestRenderproveReceipt({ entry, eventStore, now: INGESTION_TIME });
    const replay = await ingestRenderproveReceipt({ entry, eventStore, now: new Date("2026-07-26T11:01:00.000Z") });
    assert.equal(replay.status, "duplicate");
    assert.equal(replay.observation.data.ingestedAt, first.observation.data.ingestedAt);
    await writeFile(join(root, ".renderprove", "receipt.json"), `${JSON.stringify(receipt({
      artifactDigest: digest(screenshot),
      baseUrl: "https://changed-private.example.test",
    }), null, 2)}\n`);
    await assert.rejects(
      ingestRenderproveReceipt({ entry, eventStore, now: new Date("2026-07-26T11:02:00.000Z") }),
      (error) => error.code === "OBSERVATION_ID_CONFLICT",
    );
    assert.equal((await eventStore.readAll()).length, 1);
  });
});

test("unsupported schema, duplicate keys, digest mismatch, and media mismatch never become evidence", async () => {
  await fixture(async ({ root, entry, eventStore, screenshot }) => {
    const unsupported = receipt({ artifactDigest: digest(screenshot) });
    unsupported.version = 2;
    await writeFile(join(root, ".renderprove", "receipt.json"), `${JSON.stringify(unsupported)}\n`);
    await assert.rejects(ingestRenderproveReceipt({ entry, eventStore, now: INGESTION_TIME }), (error) => error.code === "RENDERPROVE_SCHEMA_UNSUPPORTED");

    await writeFile(join(root, ".renderprove", "receipt.json"), '{"version":1,"version":2}\n');
    await assert.rejects(ingestRenderproveReceipt({ entry, eventStore, now: INGESTION_TIME }), (error) => error.code === "RENDERPROVE_RECEIPT_DUPLICATE_KEY");

    await writeFile(join(root, ".renderprove", "receipt.json"), `${JSON.stringify(receipt({ artifactDigest: "a".repeat(64) }))}\n`);
    await assert.rejects(ingestRenderproveReceipt({ entry, eventStore, now: INGESTION_TIME }), (error) => error.code === "RENDERPROVE_ARTIFACT_DIGEST_MISMATCH");

    const fake = Buffer.from("plain bytes");
    await writeFile(join(root, ".renderprove", "screenshots", "private.png"), fake);
    await writeFile(join(root, ".renderprove", "receipt.json"), `${JSON.stringify(receipt({ artifactDigest: digest(fake) }))}\n`);
    await assert.rejects(ingestRenderproveReceipt({ entry, eventStore, now: INGESTION_TIME }), (error) => error.code === "RENDERPROVE_ARTIFACT_MEDIA_MISMATCH");
    assert.equal((await eventStore.readAll()).length, 0);
  });
});

test("tracked changes and unrelated untracked files prevent revision binding", async () => {
  await fixture(async ({ root, entry, eventStore }) => {
    await writeFile(join(root, "package.json"), '{"changed":true}\n');
    await assert.rejects(ingestRenderproveReceipt({ entry, eventStore, now: INGESTION_TIME }), (error) => error.code === "RENDERPROVE_CHECKOUT_DIRTY");
    await git(root, "checkout", "--", "package.json");
    await writeFile(join(root, "untracked-source.js"), "export const secret = true;\n");
    await assert.rejects(ingestRenderproveReceipt({ entry, eventStore, now: INGESTION_TIME }), (error) => error.code === "RENDERPROVE_CHECKOUT_DIRTY");
    assert.equal((await eventStore.readAll()).length, 0);
  });
});

test("artifact symlink escape is rejected before observation append", async () => {
  await fixture(async ({ root, outside, entry, eventStore }) => {
    const outsideArtifact = join(outside, "private.png");
    const bytes = png("outside-private-artifact");
    await writeFile(outsideArtifact, bytes);
    await rm(join(root, ".renderprove", "screenshots", "private.png"));
    await symlink(outsideArtifact, join(root, ".renderprove", "screenshots", "private.png"));
    await writeFile(join(root, ".renderprove", "receipt.json"), `${JSON.stringify(receipt({ artifactDigest: digest(bytes) }))}\n`);
    await assert.rejects(
      ingestRenderproveReceipt({ entry, eventStore, now: INGESTION_TIME }),
      (error) => ["RENDERPROVE_ARTIFACT_SYMLINK", "RENDERPROVE_ARTIFACT_PATH_ESCAPE"].includes(error.code),
    );
    assert.equal((await eventStore.readAll()).length, 0);
  });
});
