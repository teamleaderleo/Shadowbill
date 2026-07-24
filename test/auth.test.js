import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadOrCreateCollectorToken, verifyBearerAuthorization } from "../src/auth.js";

test("collector tokens are stable and stored with restrictive permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadowbill-auth-"));
  const path = join(directory, "collector-token");

  try {
    const first = await loadOrCreateCollectorToken(path);
    const second = await loadOrCreateCollectorToken(path);
    assert.equal(first, second);
    assert.ok(first.length >= 32);
    assert.equal((await readFile(path, "utf8")).trim(), first);
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bearer verification rejects missing, malformed, and incorrect tokens", () => {
  const token = "a".repeat(43);
  assert.equal(verifyBearerAuthorization(`Bearer ${token}`, token), true);
  assert.equal(verifyBearerAuthorization(`bearer ${token}`, token), true);
  assert.equal(verifyBearerAuthorization(undefined, token), false);
  assert.equal(verifyBearerAuthorization(token, token), false);
  assert.equal(verifyBearerAuthorization("Bearer wrong", token), false);
});
