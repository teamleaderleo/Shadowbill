import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { repositoryIdentifier } from "./git.js";
import {
  inspectAdapterPaths,
  normalizeRepositoryPolicy,
  readRepositoryPolicyFile,
  repositoryPolicyDigest,
} from "./repository-policy.js";

const execFileAsync = promisify(execFile);
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class RepositoryEnrollmentError extends Error {
  constructor(code, message, path = "$") {
    super(message);
    this.name = "RepositoryEnrollmentError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, message, path = "$") {
  throw new RepositoryEnrollmentError(code, message, path);
}

async function git(root, args, { allowFailure = false } = {}) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
      windowsHide: true,
    });
    return stdout.trim();
  } catch (error) {
    if (allowFailure) return "";
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    fail("REPOSITORY_GIT_FAILED", stderr || `Git command failed: ${args.join(" ")}.`);
  }
}

async function exists(path, type = "any") {
  try {
    const metadata = await stat(path);
    if (type === "file") return metadata.isFile();
    if (type === "directory") return metadata.isDirectory();
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function localRepositoryIdentity(root) {
  const slug = basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repository";
  const suffix = createHash("sha256").update(root, "utf8").digest("hex").slice(0, 10);
  return `local/${slug}-${suffix}`;
}

function normalizedRemoteRepository(remote) {
  const candidate = repositoryIdentifier(remote, "");
  return REPOSITORY.test(candidate) ? candidate : null;
}

async function inspectRemotes(root) {
  const names = (await git(root, ["remote"], { allowFailure: true })).split("\n").filter(Boolean).sort();
  const remotes = [];
  for (const name of names) {
    const url = await git(root, ["remote", "get-url", name], { allowFailure: true });
    remotes.push({ name, repository: normalizedRemoteRepository(url) });
  }
  return remotes;
}

function selectRepositoryIdentity({ policy, override, remotes, root }) {
  if (override !== undefined && !REPOSITORY.test(override)) {
    fail("REPOSITORY_IDENTITY_INVALID", "--repository must use owner/name form.", "$.repository");
  }
  if (policy && override !== undefined && policy.repository !== override) {
    fail("REPOSITORY_IDENTITY_CONFLICT", "--repository conflicts with committed .proofwake.json.", "$.repository");
  }
  if (policy) return policy.repository;
  if (override !== undefined) return override;
  const origin = remotes.find((remote) => remote.name === "origin" && remote.repository);
  if (origin) return origin.repository;
  const unique = [...new Set(remotes.map((remote) => remote.repository).filter(Boolean))];
  if (unique.length === 1) return unique[0];
  if (unique.length > 1) {
    fail("REPOSITORY_REMOTE_AMBIGUOUS", "Multiple canonical remotes exist without a usable origin; provide --repository.", "$.repository");
  }
  return localRepositoryIdentity(root);
}

async function hasWorkflow(root) {
  const directory = join(root, ".github", "workflows");
  if (!(await exists(directory, "directory"))) return false;
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.some((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name));
}

async function autodetectPolicy(root, repository, lifecycle) {
  const expectedSignals = [];
  const adapters = {};
  let hasVerifyMarker = false;
  for (const name of ["package.json", "Cargo.toml", "pyproject.toml", "go.mod"]) {
    if (await exists(join(root, name), "file")) {
      hasVerifyMarker = true;
      break;
    }
  }
  if (hasVerifyMarker) {
    expectedSignals.push({ kind: "verify", required: true, staleAfterHours: 0, scope: "revision" });
  }
  if (await hasWorkflow(root)) {
    expectedSignals.push({ kind: "github-ci", required: false, staleAfterHours: 72, scope: "revision" });
  }
  let hasRenderprove = false;
  for (const name of ["renderprove.json", ".renderprove.json"]) {
    if (await exists(join(root, name), "file")) {
      hasRenderprove = true;
      break;
    }
  }
  if (hasRenderprove) {
    expectedSignals.push({ kind: "browser-review", required: false, staleAfterHours: 72, scope: "revision" });
    adapters.renderprove = ".renderprove/receipt.json";
  }
  if (await exists(join(root, "vercel.json"), "file")) {
    expectedSignals.push({ kind: "deployment", required: false, staleAfterHours: 168, scope: "deployment" });
  }
  return normalizeRepositoryPolicy({
    version: 1,
    repository,
    lifecycle,
    expectedSignals,
    adapters,
  });
}

export async function inspectRepositoryEnrollment(inputPath, options = {}) {
  const requestedRoot = resolve(inputPath);
  let inputRealPath;
  try {
    inputRealPath = await realpath(requestedRoot);
  } catch (error) {
    fail("REPOSITORY_ROOT_UNAVAILABLE", `Repository root could not be resolved: ${error instanceof Error ? error.message : String(error)}`);
  }
  const topLevelText = await git(inputRealPath, ["rev-parse", "--show-toplevel"]);
  const root = await realpath(topLevelText);
  const rootMetadata = await stat(root);
  if (!rootMetadata.isDirectory()) fail("REPOSITORY_ROOT_INVALID", "Git top-level path must be a directory.");

  const configPath = join(root, ".proofwake.json");
  try {
    const configMetadata = await lstat(configPath);
    if (configMetadata.isSymbolicLink()) {
      fail("REPOSITORY_POLICY_SYMLINK", ".proofwake.json must be a regular file inside the repository root.", "$.configuration");
    }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  const committedPolicy = await readRepositoryPolicyFile(configPath);
  if (committedPolicy && options.lifecycle !== undefined && committedPolicy.lifecycle !== options.lifecycle) {
    fail("REPOSITORY_LIFECYCLE_CONFLICT", "--lifecycle conflicts with committed .proofwake.json.", "$.lifecycle");
  }
  if (options.lifecycle !== undefined && !["active", "dormant"].includes(options.lifecycle)) {
    fail("REPOSITORY_LIFECYCLE_INVALID", "--lifecycle must be active or dormant.", "$.lifecycle");
  }

  const remotes = await inspectRemotes(root);
  const repository = selectRepositoryIdentity({
    policy: committedPolicy,
    override: options.repository,
    remotes,
    root,
  });
  const policy = committedPolicy ?? await autodetectPolicy(root, repository, options.lifecycle ?? "active");
  const adapterReadiness = await inspectAdapterPaths(root, policy.adapters);
  const revision = await git(root, ["rev-parse", "--verify", "HEAD"], { allowFailure: true }) || null;
  const branch = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true }) || null;
  const canonicalRemotes = remotes.filter((remote) => remote.repository);
  const warnings = [];
  if (canonicalRemotes.length === 0 && !committedPolicy && options.repository === undefined) {
    warnings.push("No canonical remote was found; the proposed local/* identity changes when the checkout path changes.");
  }
  if (committedPolicy && canonicalRemotes.length > 0 && !canonicalRemotes.some((remote) => remote.repository === committedPolicy.repository)) {
    warnings.push("Committed repository identity differs from every canonical remote identity.");
  }

  return {
    repository,
    root,
    rootIdentity: {
      device: String(rootMetadata.dev),
      inode: String(rootMetadata.ino),
    },
    revision,
    branch,
    remotes: remotes.map((remote) => ({ name: remote.name, repository: remote.repository })),
    configuration: {
      source: committedPolicy ? "committed" : "autodetected",
      path: committedPolicy ? ".proofwake.json" : null,
      digest: repositoryPolicyDigest(policy),
    },
    policy,
    adapterReadiness,
    warnings,
  };
}
