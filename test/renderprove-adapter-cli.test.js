import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { inspectRepositoryEnrollment } from "../src/repository-enrollment.js";
import { RepositoryRegistryStore } from "../src/repository-registry.js";
import { RENDERPROVE_RECEIPT_SCHEMA } from "../src/renderprove-adapter.js";

const exec = promisify(execFile);
const main = fileURLToPath(new URL("../src/main.js", import.meta.url));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function git(root, ...args) {
  const { stdout } = await exec("git", ["-C", root, ...args], { encoding: "utf8" });
  return stdout.trim();
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

function receipt(sha256) {
  const finished = new Date(Date.now() - 2000);
  const started = new Date(finished.getTime() - 1000);
  return {
    $schema: RENDERPROVE_RECEIPT_SCHEMA,
    version: 1,
    project: "private-project-name",
    source: { manifest: "renderprove.json" },
    target: { baseUrl: "https://private.example.test" },
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: 1000,
    status: "passed",
    summary: { cases: 1, passed: 1, failed: 0, diagnostics: 0 },
    runtime: {
      mode: "local",
      command: ["private-command", "--secret=value"],
      cwd: "/private/worker/path",
      logs: { stdoutBytes: 0, stderrBytes: 0, exit: null },
    },
    cases: [{
      id: "desktop:/private",
      status: "passed",
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      route: {
        name: "private-route",
        path: "/private",
        requestedUrl: "https://private.example.test/private?secret=value",
        finalUrl: "https://private.example.test/private",
      },
      viewport: { name: "desktop", width: 1280, height: 720, deviceScaleFactor: 1 },
      navigation: { status: 200, ok: true },
      page: {
        title: "Private page title",
        lang: "en",
        bodyTextLength: 10,
        scrollWidth: 1280,
        clientWidth: 1280,
        scrollHeight: 720,
        clientHeight: 720,
      },
      artifacts: [{ kind: "screenshot", path: ".renderprove/screenshots/private.png", mimeType: "image/png", sha256 }],
      diagnostics: [],
    }],
  };
}

async function fixture(callback) {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-renderprove-cli-"));
  const root = join(directory, "repo");
  const dataPath = join(directory, "events.jsonl");
  const registryPath = join(directory, "repositories.json");
  try {
    await mkdir(root);
    await exec("git", ["init", "-q", "-b", "main", root]);
    await git(root, "config", "user.name", "Proofwake Test");
    await git(root, "config", "user.email", "proofwake@example.invalid");
    await git(root, "remote", "add", "origin", "https://github.com/acme/web.git");
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(join(root, ".proofwake.json"), `${JSON.stringify(policy(), null, 2)}\n`);
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "initial");
    const screenshot = Buffer.concat([PNG_SIGNATURE, Buffer.from("private screenshot bytes")]);
    await mkdir(join(root, ".renderprove", "screenshots"), { recursive: true });
    await writeFile(join(root, ".renderprove", "screenshots", "private.png"), screenshot);
    await writeFile(join(root, ".renderprove", "receipt.json"), `${JSON.stringify(receipt(digest(screenshot)), null, 2)}\n`);
    await new RepositoryRegistryStore(registryPath).enroll(await inspectRepositoryEnrollment(root));
    await callback({ directory, root, dataPath, registryPath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function run(args) {
  try {
    const result = await exec(process.execPath, [main, ...args], { encoding: "utf8" });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test("machine adapter output is parseable and excludes local and receipt content", async () => {
  await fixture(async ({ directory, root, dataPath, registryPath }) => {
    const result = await run([
      "ingest-adapter", "--repo", "acme/web", "--registry", registryPath,
      "--data", dataPath, "--output", "json",
    ]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const response = JSON.parse(result.stdout);
    assert.equal(response.status, "inserted");
    assert.equal(response.browserStatus, "passed");
    assert.equal(response.repository, "acme/web");
    assert.match(response.receiptDigest, /^sha256:[a-f0-9]{64}$/u);
    const serialized = JSON.stringify(response);
    for (const privateValue of [directory, root, registryPath, dataPath, "private.example.test", "private-command", "Private page title"]) {
      assert.equal(serialized.includes(privateValue), false, privateValue);
    }
  });
});

test("machine receipt parse errors keep the code and suppress attacker-supplied keys", async () => {
  await fixture(async ({ root, dataPath, registryPath }) => {
    await writeFile(join(root, ".renderprove", "receipt.json"), '{"private-secret-key":1,"private-secret-key":2}\n');
    const result = await run([
      "ingest-adapter", "--repo", "acme/web", "--registry", registryPath,
      "--data", dataPath, "--output", "json",
    ]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    const response = JSON.parse(result.stdout);
    assert.equal(response.status, "error");
    assert.equal(response.error.code, "RENDERPROVE_RECEIPT_DUPLICATE_KEY");
    assert.equal(response.error.message, "Renderprove receipt verification failed.");
    assert.equal("path" in response.error, false);
    assert.equal(result.stdout.includes("private-secret-key"), false);
  });
});

test("adapter usage rejects non-canonical repository identity before filesystem access", async () => {
  const result = await run(["ingest-adapter", "--repo", "Not Canonical", "--output", "json"]);
  assert.equal(result.code, 1);
  const response = JSON.parse(result.stdout);
  assert.equal(response.error.code, "ADAPTER_CLI_USAGE");
});
