import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { DEFAULT_WORKING_PROFILE } from "../src/estimate.js";
import { inspectRepositoryEnrollment } from "../src/repository-enrollment.js";
import { loadPricingCatalog } from "../src/pricing.js";
import { RepositoryRegistryStore } from "../src/repository-registry.js";
import { createCollectorServer, listen } from "../src/server.js";
import { JsonlEventStore } from "../src/store.js";

const exec = promisify(execFile);
const fleetScript = fileURLToPath(new URL("../dashboard/fleet.js", import.meta.url));

async function git(root, ...args) {
  const { stdout } = await exec("git", ["-C", root, ...args], { encoding: "utf8" });
  return stdout.trim();
}

async function http(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { accept: "application/json" } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function server(options, callback) {
  const catalog = await loadPricingCatalog();
  const instance = createCollectorServer({
    pricing: catalog.models["gpt-5.6-sol"],
    profile: DEFAULT_WORKING_PROFILE,
    collectorToken: "fleet-review-token",
    timeZone: "UTC",
    ...options,
  });
  const port = await listen(instance, 0);
  try {
    await callback(port);
  } finally {
    await new Promise((resolve) => instance.close(resolve));
  }
}

function policy() {
  return {
    version: 1,
    repository: { kind: "remote", id: "acme/private", provider: "github" },
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

test("fleet browser script passes Node syntax validation", async () => {
  await exec(process.execPath, ["--check", fleetScript], { encoding: "utf8" });
});

test("fleet home includes an accessible no-script fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-fleet-noscript-"));
  try {
    await server({ store: new JsonlEventStore(join(directory, "events.jsonl")) }, async (port) => {
      const response = await http(port, "/dashboard/");
      assert.equal(response.status, 200);
      assert.match(response.text, /JavaScript is disabled/);
      assert.match(response.text, /proofwake fleet/);
      assert.match(response.text, /proofwake inspect REVISION --repo owner\/name/);
      assert.match(response.text, /href="\/dashboard\/estimates\/"/);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("server discovers an empty registry beside the active ledger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-fleet-empty-registry-"));
  try {
    await server({ store: new JsonlEventStore(join(directory, "events.jsonl")) }, async (port) => {
      const response = await http(port, "/v1/fleet");
      assert.equal(response.status, 200);
      const body = JSON.parse(response.text);
      assert.equal(body.summary.total, 0);
      assert.deepEqual(body.repositories, []);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("projection endpoints report a stable registry-unavailable response without a storage path", async () => {
  const store = { readAll: async () => [] };
  await server({ store, registryStore: null }, async (port) => {
    for (const path of ["/v1/fleet", "/v1/revision-evidence?repository=acme/private"]) {
      const response = await http(port, path);
      assert.equal(response.status, 503);
      assert.equal(response.headers["access-control-allow-origin"], undefined);
      const body = JSON.parse(response.text);
      assert.equal(body.status, "error");
      assert.equal(body.error.code, "PROJECTION_REGISTRY_UNAVAILABLE");
    }
  });
});

test("automatically discovered fleet responses exclude private checkout and storage paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-fleet-private-paths-"));
  const root = join(directory, "private-checkout");
  const registryPath = join(directory, "repositories.json");
  const dataPath = join(directory, "private-events.jsonl");
  try {
    await mkdir(root);
    await exec("git", ["init", "-q", "-b", "main", root]);
    await git(root, "config", "user.name", "Proofwake Test");
    await git(root, "config", "user.email", "proofwake@example.invalid");
    await git(root, "remote", "add", "origin", "https://github.com/acme/private.git");
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(join(root, ".proofwake.json"), `${JSON.stringify(policy(), null, 2)}\n`);
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "initial");

    const registryStore = new RepositoryRegistryStore(registryPath);
    await registryStore.enroll(await inspectRepositoryEnrollment(root));
    const store = new JsonlEventStore(dataPath);

    await server({ store }, async (port) => {
      const fleet = await http(port, "/v1/fleet");
      assert.equal(fleet.status, 200);
      assert.equal(JSON.parse(fleet.text).summary.total, 1);
      const revision = await http(port, "/v1/revision-evidence?repository=acme/private");
      assert.equal(revision.status, 200);
      for (const response of [fleet, revision]) {
        for (const privateValue of [directory, root, registryPath, dataPath, "private-checkout", "private-events.jsonl"]) {
          assert.equal(response.text.includes(privateValue), false, privateValue);
        }
      }
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
