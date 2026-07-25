import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  inspectAdapterPaths,
  parseRepositoryPolicyJson,
  readRepositoryPolicyFile,
} from "../src/repository-policy-file.js";

async function temporary(callback) {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-policy-file-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function policyText() {
  return readFile(new URL("./fixtures/repository-policies/renderprove.json", import.meta.url), "utf8");
}

test("strict policy JSON rejects duplicate keys before validation", async () => {
  const text = await policyText();
  const duplicate = text.replace('"state": "active"', '"state": "active", "state": "dormant"');
  assert.throws(
    () => parseRepositoryPolicyJson(duplicate),
    (error) => error.code === "REPOSITORY_POLICY_DUPLICATE_KEY",
  );
});

test("policy files must be bounded regular non-symlink UTF-8 files", { skip: process.platform === "win32" }, async () => {
  await temporary(async (directory) => {
    const target = join(directory, "policy-target.json");
    const link = join(directory, ".proofwake.json");
    await writeFile(target, await policyText());
    await symlink(target, link);
    await assert.rejects(
      readRepositoryPolicyFile(link),
      (error) => error.code === "REPOSITORY_POLICY_SYMLINK",
    );
  });
});

test("adapter readiness distinguishes ready, missing, non-file, and symlink paths", { skip: process.platform === "win32" }, async () => {
  await temporary(async (directory) => {
    await mkdir(join(directory, ".renderprove"));
    await writeFile(join(directory, ".renderprove", "receipt.json"), "{}");
    await mkdir(join(directory, "directory-adapter"));
    await symlink(join(directory, ".renderprove", "receipt.json"), join(directory, "linked.json"));
    const result = await inspectAdapterPaths(directory, [
      { name: "ready", path: ".renderprove/receipt.json", schema: "renderprove.receipt.v1", trust: "verified-receipt" },
      { name: "missing", path: "missing.json", schema: "missing.v1", trust: "untrusted-observation" },
      { name: "directory", path: "directory-adapter", schema: "directory.v1", trust: "untrusted-observation" },
      { name: "linked", path: "linked.json", schema: "linked.v1", trust: "untrusted-observation" },
    ]);
    assert.equal(result.ready.state, "ready");
    assert.equal(result.missing.code, "REPOSITORY_ADAPTER_MISSING");
    assert.equal(result.directory.code, "REPOSITORY_ADAPTER_NOT_FILE");
    assert.equal(result.linked.code, "REPOSITORY_ADAPTER_SYMLINK");
  });
});
