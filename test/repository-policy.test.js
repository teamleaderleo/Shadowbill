import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  inspectAdapterPaths,
  parseRepositoryPolicyJson,
  readRepositoryPolicyFile,
  repositoryPolicyDigest,
} from "../src/repository-policy.js";

const valid = {
  version: 1,
  repository: "example/project",
  expectedSignals: [
    { kind: "verify", required: true, staleAfterHours: 0, scope: "revision" },
  ],
  adapters: { renderprove: ".renderprove/receipt.json" },
};

test("normalizes and digests repository policy", () => {
  const policy = parseRepositoryPolicyJson(JSON.stringify(valid));
  assert.equal(policy.lifecycle, "active");
  assert.match(repositoryPolicyDigest(policy), /^sha256:[a-f0-9]{64}$/);
});

test("rejects duplicate keys and duplicate signal kinds", () => {
  const duplicateKey = JSON.stringify(valid).replace('"version":1', '"version":1,"version":1');
  assert.throws(() => parseRepositoryPolicyJson(duplicateKey), (error) => error.code === "REPOSITORY_POLICY_DUPLICATE_KEY");
  const duplicateSignal = structuredClone(valid);
  duplicateSignal.expectedSignals.push({ ...duplicateSignal.expectedSignals[0] });
  assert.throws(() => parseRepositoryPolicyJson(JSON.stringify(duplicateSignal)), (error) => error.code === "REPOSITORY_POLICY_DUPLICATE_SIGNAL");
});

test("rejects adapter traversal", () => {
  const invalid = structuredClone(valid);
  invalid.adapters.renderprove = "../outside.json";
  assert.throws(() => parseRepositoryPolicyJson(JSON.stringify(invalid)), (error) => error.code === "REPOSITORY_POLICY_INVALID_ADAPTER_PATH");
});


test("rejects a symbolic-link repository policy", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-policy-file-"));
  const target = join(directory, "target.json");
  const path = join(directory, ".proofwake.json");
  try {
    await writeFile(target, JSON.stringify(valid));
    await symlink(target, path);
    await assert.rejects(readRepositoryPolicyFile(path), (error) => error.code === "REPOSITORY_POLICY_SYMLINK");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects adapter symlink escape", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-policy-"));
  const root = join(directory, "root");
  const outside = join(directory, "outside");
  try {
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, join(root, "escape"));
    await assert.rejects(
      inspectAdapterPaths(root, { example: "escape/receipt.json" }),
      (error) => error.code === "REPOSITORY_ADAPTER_PATH_ESCAPE",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
