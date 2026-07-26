import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { mapGitCommitObservation } from "./git-observation.js";
import { ObservationLedger } from "./observation-ledger.js";
import { estimateTokens } from "./tokenize.js";

const execFileAsync = promisify(execFile);
const CANONICAL_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const GITHUB_REMOTE_PROTOCOLS = new Set(["git:", "http:", "https:", "ssh:"]);

async function git(repo, args) {
  const { stdout } = await execFileAsync("git", ["-C", repo, ...args], {
    maxBuffer: 20 * 1024 * 1024,
    encoding: "utf8",
  });
  return stdout.trimEnd();
}

function parseNumstat(raw) {
  let additions = 0;
  let deletions = 0;
  let changedFiles = 0;

  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [added, removed] = line.split("\t");
    if (added === undefined || removed === undefined) continue;
    changedFiles += 1;
    if (added !== "-") additions += Number.parseInt(added, 10) || 0;
    if (removed !== "-") deletions += Number.parseInt(removed, 10) || 0;
  }

  return { additions, deletions, changedFiles };
}

function addedLinesFromPatch(patch) {
  return patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

function cleanRemotePath(value) {
  return value
    .split(/[?#]/, 1)[0]
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "");
}

function hostAndPath(host, path, fallback) {
  const cleanHost = host.toLowerCase();
  const cleanPath = cleanRemotePath(path);
  if (!cleanHost || !cleanPath) return fallback;
  return cleanHost === "github.com" ? cleanPath : `${cleanHost}/${cleanPath}`;
}

export function repositoryIdentifier(remote, fallback) {
  const value = typeof remote === "string" ? remote.trim() : "";
  if (!value) return fallback;
  if (/^(?:\.{0,2}[\\/]|~[\\/]|[a-z]:[\\/])/i.test(value)) return fallback;

  try {
    const url = new URL(value);
    if (url.protocol === "file:") return fallback;
    return hostAndPath(url.hostname, url.pathname, fallback);
  } catch {
    // Continue with Git's SCP-style remote syntax.
  }

  const scp = /^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/.exec(value);
  if (scp) return hostAndPath(scp[1], scp[2], fallback);
  return fallback;
}

export function canonicalRemoteRepositoryIdentity(remote) {
  const value = typeof remote === "string" ? remote.trim() : "";
  if (!value || /^(?:\.{0,2}[\\/]|~[\\/]|[a-z]:[\\/])/i.test(value)) return null;

  let path;
  try {
    const url = new URL(value);
    if (!GITHUB_REMOTE_PROTOCOLS.has(url.protocol) || url.hostname.toLowerCase() !== "github.com") return null;
    path = cleanRemotePath(url.pathname);
  } catch {
    const scp = /^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/.exec(value);
    if (!scp || scp[1].toLowerCase() !== "github.com") return null;
    path = cleanRemotePath(scp[2]);
  }

  return CANONICAL_REPOSITORY.test(path) ? path.toLowerCase() : null;
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function hookNodeExecutable() {
  return process.platform === "win32" ? process.execPath.replaceAll("\\", "/") : process.execPath;
}

function localRepositoryIdentity(root) {
  const digest = createHash("sha256").update(root, "utf8").digest("hex");
  return `local:sha256:${digest}`;
}

function legacyEventId(repository, revision) {
  const eventKey = createHash("sha256").update(`${repository}:${revision}`, "utf8").digest("hex").slice(0, 24);
  return `git_${eventKey}`;
}

async function collectHeadCommitDetails(repoPath) {
  const requested = resolve(repoPath);
  const topLevel = await git(requested, ["rev-parse", "--show-toplevel"]);
  const repo = await realpath(topLevel);
  const [sha, branch, subject, timestamp, remote, numstat, patch] = await Promise.all([
    git(repo, ["rev-parse", "HEAD"]),
    git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(repo, ["show", "-s", "--format=%s", "HEAD"]),
    git(repo, ["show", "-s", "--format=%cI", "HEAD"]),
    git(repo, ["remote", "get-url", "origin"]).catch(() => ""),
    git(repo, ["show", "--numstat", "--format=", "--no-renames", "HEAD"]),
    git(repo, ["show", "--format=", "--no-renames", "--unified=0", "--no-color", "HEAD"]),
  ]);

  const stats = parseNumstat(numstat);
  const repository = repositoryIdentifier(remote, basename(repo));
  return {
    canonicalRepository: canonicalRemoteRepositoryIdentity(remote),
    localRepository: localRepositoryIdentity(repo),
    event: {
      type: "git_commit",
      id: legacyEventId(repository, sha),
      timestamp,
      repository,
      branch,
      sha,
      subject,
      ...stats,
      addedCodeTokens: estimateTokens(addedLinesFromPatch(patch)),
      collectorVersion: "0.3.0",
    },
  };
}

/** @returns {Promise<import('./types.js').GitCommitEvent>} */
export async function collectHeadCommit(repoPath) {
  return (await collectHeadCommitDetails(repoPath)).event;
}

function acceptedTimestamp(sourceTime, candidate) {
  if (typeof candidate !== "string" || Number.isNaN(Date.parse(candidate))) return candidate;
  return Date.parse(candidate) < Date.parse(sourceTime) ? new Date(sourceTime).toISOString() : new Date(candidate).toISOString();
}

function legacyCompatibilityEvent(event, repository) {
  return {
    ...event,
    id: legacyEventId(repository, event.sha),
    repository,
    branch: "",
    subject: "",
  };
}

/**
 * Collects and persists the current commit using one durable representation.
 * Canonical GitHub-backed repositories write observation v1. Other repositories
 * retain a content-minimised legacy compatibility record.
 */
export async function ingestHeadCommit({ repoPath, store, ingestedAt = new Date().toISOString() }) {
  if (!store || typeof store.append !== "function" || typeof store.appendIdempotent !== "function") {
    throw new TypeError("Git ingestion requires an event store.");
  }
  const { canonicalRepository, localRepository, event } = await collectHeadCommitDetails(repoPath);

  if (canonicalRepository !== null) {
    const observation = mapGitCommitObservation(
      { ...event, repository: canonicalRepository },
      {
        observedAt: event.timestamp,
        ingestedAt: acceptedTimestamp(event.timestamp, ingestedAt),
      },
    );
    const result = await new ObservationLedger(store).append(observation);
    return {
      format: "observation-v1",
      status: result.status,
      repository: observation.data.relationships.repository,
      revision: observation.data.relationships.revision,
      identity: {
        source: observation.source,
        id: observation.id,
      },
      fingerprint: result.fingerprint,
    };
  }

  const compatibilityEvent = legacyCompatibilityEvent(event, localRepository);
  const inserted = await store.append(compatibilityEvent);
  return {
    format: "legacy-git-commit",
    status: inserted ? "inserted" : "duplicate",
    repository: compatibilityEvent.repository,
    revision: compatibilityEvent.sha,
    identity: { id: compatibilityEvent.id },
    compatibility: { reason: "local-only-repository-identity" },
  };
}

export async function installPostCommitHook(repoPath, cliPath) {
  const repo = resolve(repoPath);
  const gitDir = await git(repo, ["rev-parse", "--git-dir"]);
  const hooksDir = resolve(repo, gitDir, "hooks");
  const hookPath = join(hooksDir, "post-commit");
  const marker = "# shadowbill:post-commit";
  const command = `${marker}\n${shellQuote(hookNodeExecutable())} ${shellQuote(resolve(cliPath))} ingest-git --repo ${shellQuote(repo)} >/dev/null 2>&1 &\n`;

  await mkdir(hooksDir, { recursive: true });
  let existing = "";
  try {
    existing = await readFile(hookPath, "utf8");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }

  if (existing.includes(marker)) return hookPath;
  if (existing) {
    const firstLine = existing.split("\n", 1)[0] ?? "";
    if (firstLine.startsWith("#!") && !/(?:ba|z|da|k)?sh\b/.test(firstLine)) {
      throw new Error(`Existing post-commit hook uses an unsupported interpreter: ${firstLine}`);
    }
  }

  const script = existing
    ? `${existing.trimEnd()}\n\n${command}`
    : `#!/bin/sh\n${command}`;
  await writeFile(hookPath, script, "utf8");
  await chmod(hookPath, 0o755);
  return hookPath;
}
