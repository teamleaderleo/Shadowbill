import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildFleetDoctorReport } from "../src/fleet-doctor.js";
import { inspectRepositoryEnrollment } from "../src/repository-enrollment.js";
import { RepositoryRegistryStore } from "../src/repository-registry.js";

const exec = promisify(execFile);

async function git(root, ...args) {
  const { stdout } = await exec("git", ["-C", root, ...args], { encoding: "utf8" });
  return stdout.trim();
}

function policy(repository, { adapter = true, lifecycle = "active" } = {}) {
  return {
    version: 1,
    repository: { kind: "remote", id: repository, provider: "github" },
    lifecycle: { state: lifecycle, dormantAfterDays: 30 },
    signals: [
      {
        kind: "verify",
        requirement: "required",
        subject: "revision",
        appliesTo: "every-revision",
        freshness: { mode: "revision" },
        acceptedSources: ["local-command"],
      },
      ...(adapter ? [{
        kind: "browser-review",
        requirement: "required",
        subject: "revision",
        appliesTo: "every-revision",
        freshness: { mode: "revision" },
        acceptedSources: ["adapter:renderprove"],
      }] : []),
    ],
    adapters: adapter ? [{
      name: "renderprove",
      type: "receipt-file",
      path: ".renderprove/receipt.json",
      schema: "renderprove.receipt.v1",
      trust: "verified-receipt",
    }] : [],
  };
}

async function createRepository(root, repository, { receipt = true, adapter = true } = {}) {
  await mkdir(root, { recursive: true });
  await exec("git", ["init", "-q", "-b", "main", root]);
  await git(root, "config", "user.name", "Proofwake Test");
  await git(root, "config", "user.email", "proofwake@example.invalid");
  await git(root, "remote", "add", "origin", `https://github.com/${repository}.git`);
  await writeFile(join(root, "package.json"), "{}\n");
  await writeFile(join(root, ".proofwake.json"), `${JSON.stringify(policy(repository, { adapter }), null, 2)}\n`);
  if (adapter && receipt) {
    await mkdir(join(root, ".renderprove"), { recursive: true });
    await writeFile(join(root, ".renderprove", "receipt.json"), '{"private":"receipt-content-sentinel"}\n');
  }
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "initial");
}

async function enroll(registryStore, root) {
  return registryStore.enroll(await inspectRepositoryEnrollment(root));
}

function byId(report, id) {
  return report.checks.find((check) => check.id === id);
}

test("fleet doctor reports a healthy registry, repository, and ready adapter without reading receipt content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-fleet-doctor-ready-"));
  const root = join(directory, "private-checkout-root");
  const registryPath = join(directory, "repositories.json");
  try {
    await createRepository(root, "acme/ready");
    const registryStore = new RepositoryRegistryStore(registryPath);
    await enroll(registryStore, root);
    const beforeRegistry = await readFile(registryPath, "utf8");
    const beforeReceipt = await readFile(join(root, ".renderprove", "receipt.json"), "utf8");

    const report = await buildFleetDoctorReport({ registryPath, events: [], now: new Date("2026-07-26T12:00:00.000Z") });

    assert.equal(report.status, "healthy");
    assert.equal(byId(report, "repository-registry").status, "pass");
    assert.equal(byId(report, "repository:acme/ready").status, "pass");
    assert.equal(byId(report, "fleet-readiness").status, "pass");
    assert.deepEqual(report.repositories[0].adapters.map((adapter) => [adapter.name, adapter.state]), [["renderprove", "ready"]]);
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(root), false);
    assert.equal(serialized.includes(".renderprove/receipt.json"), false);
    assert.equal(serialized.includes("receipt-content-sentinel"), false);
    assert.equal(await readFile(registryPath, "utf8"), beforeRegistry);
    assert.equal(await readFile(join(root, ".renderprove", "receipt.json"), "utf8"), beforeReceipt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fleet doctor isolates a removed checkout while preserving an unrelated healthy repository", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-fleet-doctor-isolation-"));
  const healthyRoot = join(directory, "healthy-private-root");
  const removedRoot = join(directory, "removed-private-root");
  const registryPath = join(directory, "repositories.json");
  try {
    await createRepository(healthyRoot, "acme/healthy", { adapter: false });
    await createRepository(removedRoot, "acme/removed", { adapter: false });
    const registryStore = new RepositoryRegistryStore(registryPath);
    await enroll(registryStore, healthyRoot);
    await enroll(registryStore, removedRoot);
    await rm(removedRoot, { recursive: true, force: true });

    const report = await buildFleetDoctorReport({ registryPath, events: [] });

    assert.equal(report.status, "error");
    assert.equal(byId(report, "repository:acme/healthy").status, "pass");
    assert.equal(byId(report, "repository:acme/removed").status, "error");
    assert.equal(byId(report, "repository:acme/removed").code, "REPOSITORY_ROOT_MISSING");
    assert.equal(report.repositories.find((entry) => entry.identity === "acme/healthy").status, "pass");
    assert.equal(report.repositories.find((entry) => entry.identity === "acme/removed").status, "error");
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(healthyRoot), false);
    assert.equal(serialized.includes(removedRoot), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fleet doctor reports committed policy drift and unsafe adapter replacement with bounded metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-fleet-doctor-drift-"));
  const root = join(directory, "private-drift-root");
  const registryPath = join(directory, "repositories.json");
  const outside = join(directory, "private-outside-receipt.json");
  try {
    await createRepository(root, "acme/drift");
    const registryStore = new RepositoryRegistryStore(registryPath);
    await enroll(registryStore, root);

    await writeFile(join(root, ".proofwake.json"), `${JSON.stringify(policy("acme/drift", { lifecycle: "dormant" }), null, 2)}\n`);
    await git(root, "add", ".proofwake.json");
    await git(root, "commit", "-qm", "change policy");
    await writeFile(outside, "private-adapter-target-sentinel\n");
    await rm(join(root, ".renderprove", "receipt.json"));
    await symlink(outside, join(root, ".renderprove", "receipt.json"));

    const report = await buildFleetDoctorReport({ registryPath, events: [] });
    const repositoryCheck = byId(report, "repository:acme/drift");

    assert.equal(report.status, "error");
    assert.equal(repositoryCheck.status, "error");
    assert.equal(repositoryCheck.details.policyChanged, true);
    assert.equal(repositoryCheck.details.adapters[0].state, "unsafe");
    assert.equal(repositoryCheck.details.adapters[0].code, "REPOSITORY_ADAPTER_SYMLINK");
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(root), false);
    assert.equal(serialized.includes(outside), false);
    assert.equal(serialized.includes("private-adapter-target-sentinel"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fleet doctor fails closed for corrupt, symlinked, and insecure registries", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-fleet-doctor-registry-"));
  const corruptPath = join(directory, "corrupt.json");
  const targetPath = join(directory, "target.json");
  const linkPath = join(directory, "link.json");
  const insecurePath = join(directory, "insecure.json");
  try {
    await writeFile(corruptPath, '{"version":1,"privateRegistrySentinel":true}\n');
    const corrupt = await buildFleetDoctorReport({ registryPath: corruptPath, events: [] });
    assert.equal(corrupt.status, "error");
    assert.equal(byId(corrupt, "repository-registry").code, "REPOSITORY_REGISTRY_UNKNOWN_FIELD");
    assert.equal(JSON.stringify(corrupt).includes("privateRegistrySentinel"), false);

    await writeFile(targetPath, '{"version":1,"entries":[]}\n');
    await symlink(targetPath, linkPath);
    const linked = await buildFleetDoctorReport({ registryPath: linkPath, events: [] });
    assert.equal(linked.status, "error");
    assert.equal(byId(linked, "repository-registry").code, "REPOSITORY_REGISTRY_SYMLINK");

    await writeFile(insecurePath, '{"version":1,"entries":[]}\n', { mode: 0o600 });
    if (process.platform !== "win32") {
      await chmod(insecurePath, 0o644);
      const insecure = await buildFleetDoctorReport({ registryPath: insecurePath, events: [] });
      assert.equal(insecure.status, "error");
      assert.equal(byId(insecure, "repository-registry-permissions").code, "REPOSITORY_REGISTRY_PERMISSIONS_INSECURE");
    } else {
      context.diagnostic("POSIX permission assertion skipped on Windows");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
