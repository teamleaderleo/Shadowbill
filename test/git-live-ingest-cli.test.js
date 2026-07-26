import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/main.js", import.meta.url));
const FIXED_DATE = "2026-07-25T17:00:00Z";
const PRIVATE_SUBJECT = "PRIVATE_COMMIT_SUBJECT_SENTINEL";
const PRIVATE_PATH = "PRIVATE_PATH_SENTINEL.js";
const PRIVATE_CONTENT = "export const privateSentinel = 'PRIVATE_PATCH_SENTINEL';\n";

function environment(overrides = {}) {
  const value = { ...process.env };
  for (const key of [
    "PROOFWAKE_DATA",
    "SHADOWBILL_DATA",
    "PROOFWAKE_TIMEZONE",
    "SHADOWBILL_TIMEZONE",
  ]) delete value[key];
  return { ...value, ...overrides };
}

function runProofwake(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
    env: environment(options.env),
  });
}

async function git(repo, ...args) {
  const options = args.at(-1)?.__options === true ? args.pop().value : {};
  const result = await exec("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  return result.stdout.trimEnd();
}

function gitOptions(value) {
  return { __options: true, value };
}

function credentialBearingGitHubRemote(repository) {
  const remote = new URL(`https://github.com/${repository}.git`);
  remote.username = "private-user";
  remote.password = ["PRIVATE", "CREDENTIAL", "SENTINEL"].join("_");
  remote.searchParams.set("token", ["PRIVATE", "TOKEN", "SENTINEL"].join("_"));
  return remote.toString();
}

async function initializeEmptyRepository(repo, remote) {
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-q");
  await git(repo, "config", "user.email", "proofwake@example.test");
  await git(repo, "config", "user.name", "Proofwake Test");
  if (remote !== undefined) await git(repo, "remote", "add", "origin", remote);
}

async function commitFixture(repo) {
  await writeFile(join(repo, PRIVATE_PATH), PRIVATE_CONTENT, "utf8");
  await git(repo, "add", PRIVATE_PATH);
  await git(
    repo,
    "commit",
    "-q",
    "-m",
    PRIVATE_SUBJECT,
    gitOptions({
      env: environment({
        GIT_AUTHOR_DATE: FIXED_DATE,
        GIT_COMMITTER_DATE: FIXED_DATE,
      }),
    }),
  );
  return git(repo, "rev-parse", "HEAD");
}

async function initializeRepository(repo, remote) {
  await initializeEmptyRepository(repo, remote);
  return commitFixture(repo);
}

async function readLedger(path) {
  const raw = await readFile(path, "utf8");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function response(result) {
  assert.notEqual(result.stdout.trim(), "", result.stderr);
  return JSON.parse(result.stdout);
}

function assertPrivateContentExcluded(value, repoPath, remote) {
  const text = JSON.stringify(value);
  assert.equal(text.includes(PRIVATE_SUBJECT), false);
  assert.equal(text.includes("PRIVATE_PATCH_SENTINEL"), false);
  assert.equal(text.includes(PRIVATE_PATH), false);
  assert.equal(text.includes(repoPath), false);
  if (remote !== undefined) assert.equal(text.includes(remote), false);
  assert.equal(text.includes("PRIVATE_CREDENTIAL_SENTINEL"), false);
  assert.equal(text.includes("PRIVATE_TOKEN_SENTINEL"), false);
}

function retainedTokens(record) {
  if (record.type === "git_commit") return record.addedCodeTokens;
  return record.observation.data.facts.find((fact) => fact.name === "proofwake.retained-code-tokens")?.value ?? 0;
}

test("installed ingest-git writes one canonical observation and replays exactly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-git-observation-cli-"));
  const repo = join(directory, "checkout");
  const dataPath = join(directory, "events.jsonl");
  const remote = credentialBearingGitHubRemote("Owner/Repo");
  try {
    const revision = await initializeRepository(repo, remote);
    const first = runProofwake(["ingest-git", "--repo", repo, "--data", dataPath]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stderr, "");
    const inserted = response(first);
    assert.equal(inserted.service, "proofwake");
    assert.equal(inserted.command, "ingest-git");
    assert.equal(inserted.format, "observation-v1");
    assert.equal(inserted.status, "inserted");
    assert.equal(inserted.repository, "owner/repo");
    assert.equal(inserted.revision, revision);
    assert.match(inserted.fingerprint, /^sha256:[a-f0-9]{64}$/u);
    assertPrivateContentExcluded(inserted, repo, remote);

    const records = await readLedger(dataPath);
    assert.equal(records.length, 1);
    assert.equal(records[0].type, "proofwake_observation");
    assert.equal(records[0].observation.type, "dev.proofwake.git.commit.v1");
    assert.deepEqual(records[0].observation.data.relationships, {
      repository: "owner/repo",
      revision,
    });
    assert.ok(retainedTokens(records[0]) > 0);
    assertPrivateContentExcluded(records[0], repo, remote);

    const replay = runProofwake(["ingest-git", "--repo", repo, "--data", dataPath]);
    assert.equal(replay.status, 0, replay.stderr);
    const duplicate = response(replay);
    assert.equal(duplicate.status, "duplicate");
    assert.equal(duplicate.format, "observation-v1");
    assert.equal(duplicate.fingerprint, inserted.fingerprint);
    assert.deepEqual(duplicate.identity, inserted.identity);
    assert.equal((await readLedger(dataPath)).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installed ingest-git reports conflicting observation identity without leaking content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-git-conflict-cli-"));
  const repo = join(directory, "checkout");
  const dataPath = join(directory, "events.jsonl");
  const remote = credentialBearingGitHubRemote("owner/conflict");
  try {
    await initializeRepository(repo, remote);
    const inserted = runProofwake(["ingest-git", "--repo", repo, "--data", dataPath]);
    assert.equal(inserted.status, 0, inserted.stderr);
    const [record] = await readLedger(dataPath);
    record.requestFingerprint = `sha256:${"f".repeat(64)}`;
    await writeFile(dataPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });

    const conflict = runProofwake(["ingest-git", "--repo", repo, "--data", dataPath]);
    assert.equal(conflict.status, 1);
    assert.equal(conflict.stderr, "");
    const failure = response(conflict);
    assert.deepEqual(failure, {
      service: "proofwake",
      command: "ingest-git",
      status: "error",
      format: "observation-v1",
      error: {
        code: "OBSERVATION_ID_CONFLICT",
        message: "Git observation identity conflicts with an existing ledger record.",
      },
    });
    assertPrivateContentExcluded(failure, repo, remote);
    assert.equal((await readLedger(dataPath)).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installed ingest-git separates identical revisions by canonical repository", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-git-cross-repo-cli-"));
  const firstRepo = join(directory, "first");
  const secondRepo = join(directory, "second");
  const dataPath = join(directory, "events.jsonl");
  try {
    const firstRevision = await initializeRepository(firstRepo, "https://github.com/owner/first.git");
    const secondRevision = await initializeRepository(secondRepo, "git@github.com:owner/second.git");
    assert.equal(firstRevision, secondRevision);

    const first = response(runProofwake(["ingest-git", "--repo", firstRepo, "--data", dataPath]));
    const second = response(runProofwake(["ingest-git", "--repo", secondRepo, "--data", dataPath]));
    assert.equal(first.status, "inserted");
    assert.equal(second.status, "inserted");
    assert.equal(first.revision, second.revision);
    assert.notDeepEqual(first.identity, second.identity);

    const records = await readLedger(dataPath);
    assert.equal(records.length, 2);
    assert.deepEqual(
      records.map((record) => record.observation.data.relationships.repository).sort(),
      ["owner/first", "owner/second"],
    );
    assert.equal(records.some((record) => record.type === "git_commit"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local-only fallback uses one private root identity from root or subdirectory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-git-legacy-cli-"));
  const canonicalRepo = join(directory, "canonical");
  const localRepo = join(directory, "PRIVATE_LOCAL_CHECKOUT_SENTINEL");
  const nestedRepoPath = join(localRepo, "nested", "working-directory");
  const dataPath = join(directory, "events.jsonl");
  try {
    await initializeRepository(canonicalRepo, "https://github.com/owner/canonical.git");
    const localRevision = await initializeRepository(localRepo);
    await mkdir(nestedRepoPath, { recursive: true });

    const canonical = response(runProofwake(["ingest-git", "--repo", canonicalRepo, "--data", dataPath]));
    const local = response(runProofwake(["ingest-git", "--repo", localRepo, "--data", dataPath]));
    assert.equal(canonical.format, "observation-v1");
    assert.equal(local.format, "legacy-git-commit");
    assert.equal(local.status, "inserted");
    assert.match(local.repository, /^local:sha256:[a-f0-9]{64}$/u);
    assert.equal(local.repository.includes("PRIVATE_LOCAL_CHECKOUT_SENTINEL"), false);
    assert.equal(local.revision, localRevision);
    assert.deepEqual(local.compatibility, { reason: "local-only-repository-identity" });
    assertPrivateContentExcluded(local, localRepo);

    const replay = response(runProofwake(["ingest-git", "--repo", nestedRepoPath, "--data", dataPath]));
    assert.equal(replay.status, "duplicate");
    assert.equal(replay.format, "legacy-git-commit");
    assert.equal(replay.repository, local.repository);
    assert.deepEqual(replay.identity, local.identity);

    const records = await readLedger(dataPath);
    assert.equal(records.length, 2);
    const legacy = records.find((record) => record.type === "git_commit");
    assert.equal(legacy.repository, local.repository);
    assert.equal(legacy.subject, "");
    assert.equal(legacy.branch, "");
    assert.equal(JSON.stringify(legacy).includes("PRIVATE_LOCAL_CHECKOUT_SENTINEL"), false);
    assertPrivateContentExcluded(legacy, localRepo);

    const expectedTokens = records.reduce((total, record) => total + retainedTokens(record), 0);
    const reportResult = runProofwake([
      "report",
      "--data", dataPath,
      "--date", "2026-07-25",
      "--timezone", "UTC",
      "--json",
    ]);
    assert.equal(reportResult.status, 0, reportResult.stderr);
    const report = response(reportResult);
    assert.equal(report.commits, 2);
    assert.equal(report.repositories, 2);
    assert.equal(report.addedCodeTokens, expectedTokens);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installed post-commit hook writes the canonical observation", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-git-hook-cli-"));
  const repo = join(directory, "hooked");
  const dataPath = join(directory, "events.jsonl");
  try {
    await initializeEmptyRepository(repo, "https://github.com/owner/hooked.git");
    const install = runProofwake(["hook", "install", "--repo", repo, "--data", dataPath]);
    assert.equal(install.status, 0, install.stderr);

    await writeFile(join(repo, PRIVATE_PATH), PRIVATE_CONTENT, "utf8");
    await git(repo, "add", PRIVATE_PATH);
    await git(
      repo,
      "commit",
      "-q",
      "-m",
      PRIVATE_SUBJECT,
      gitOptions({
        env: environment({
          GIT_AUTHOR_DATE: FIXED_DATE,
          GIT_COMMITTER_DATE: FIXED_DATE,
          PROOFWAKE_DATA: dataPath,
          PROOFWAKE_TIMEZONE: "UTC",
        }),
      }),
    );

    const deadline = Date.now() + 10_000;
    let records = [];
    while (Date.now() < deadline) {
      try {
        records = await readLedger(dataPath);
        if (records.length > 0) break;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.equal(records.length, 1);
    assert.equal(records[0].type, "proofwake_observation");
    assert.equal(records[0].observation.data.relationships.repository, "owner/hooked");
    assertPrivateContentExcluded(records[0], repo, "https://github.com/owner/hooked.git");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
