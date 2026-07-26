import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildFleetDoctorReport } from "../src/fleet-doctor.js";

test("fleet readiness is unavailable when registry permissions are insecure", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX permission assertion is unavailable on Windows");
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), "proofwake-fleet-doctor-permissions-"));
  const registryPath = join(directory, "repositories.json");
  try {
    await writeFile(registryPath, '{"version":1,"entries":[]}\n', { mode: 0o600 });
    await chmod(registryPath, 0o644);

    const report = await buildFleetDoctorReport({ registryPath, events: [] });
    const permission = report.checks.find((check) => check.id === "repository-registry-permissions");
    const fleet = report.checks.find((check) => check.id === "fleet-readiness");

    assert.equal(report.status, "error");
    assert.equal(permission.code, "REPOSITORY_REGISTRY_PERMISSIONS_INSECURE");
    assert.equal(permission.status, "error");
    assert.equal(fleet.code, "FLEET_UNAVAILABLE");
    assert.equal(fleet.status, "error");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
