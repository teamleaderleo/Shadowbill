import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { repositoryIdentifier } from "./git.js";
import { validateRepositoryPolicy } from "./repository-policy.js";
import {
  inspectAdapterPaths,
  readRepositoryPolicyFile,
  repositoryPolicyFingerprint,
  repositoryPolicyIdentity,
  repositoryPolicyLabel,
} from "./repository-policy-file.js";

const execFileAsync = promisify(execFile);
const REMOTE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,99})\/[a-z0-9](?:[a-z0-9._-]{0,99})$/u;

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

async function git(root, arguments_, { allowFailure = false } = {}) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...arguments_], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
      windowsHide: true,
    });
    return stdout.trim();
  } catch (error) {
    if (allowFailure) return "";
    fail("REPOSITORY_GIT_FAILED", `Git command failed: ${arguments_.join(" ")}.`);
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

function remoteRepository(url) {
  const value = repositoryIdentifier(url, "").toLowerCase();
  return REMOTE_ID.test(value) ? value : null;
}

async function inspectRemotes(root) {
  const names = (await git(root, ["remote"], { allowFailure: true })).split("\n").filter(Boolean).sort();
  const result = [];
  for (const name of names) {
    const url = await git(root, ["remote", "get-url", name], { allowFailure: true });
    result.push({ name, repository: remoteRepository(url) });
  }
  return result;
}

function localIdentity(root) {
  const displayName = basename(root).toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "repository";
  const localId = `sha256:${createHash("sha256").update(root, "utf8").digest("hex")}`;
  return { kind: "local", localId, displayName };
}

function remoteIdentityFromRemotes(remotes, override) {
  if (override !== undefined) {
    const value = override.toLowerCase();
    if (!REMOTE_ID.test(value)) fail("REPOSITORY_IDENTITY_INVALID", "--repository must use owner/name form.", "$.repository");
    return { kind: "remote", id: value, provider: "github" };
  }
  const origin = remotes.find((remote) => remote.name === "origin" && remote.repository);
  if (origin) return { kind: "remote", id: origin.repository, provider: "github" };
  const unique = [...new Set(remotes.map((remote) => remote.repository).filter(Boolean))];
  if (unique.length === 1) return { kind: "remote", id: unique[0], provider: "github" };
  if (unique.length > 1) {
    fail("REPOSITORY_REMOTE_AMBIGUOUS", "Multiple canonical remotes exist without a matching origin; provide --repository.", "$.repository");
  }
  return null;
}

async function hasWorkflow(root) {
  const directory = join(root, ".github", "workflows");
  if (!(await exists(directory, "directory"))) return false;
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.some((entry) => entry.isFile() && /\.ya?ml$/iu.test(entry.name));
}

async function autodetectPolicy(root, identity, lifecycle) {
  const signals = [];
  const adapters = [];
  for (const name of ["package.json", "Cargo.toml", "pyproject.toml", "go.mod"]) {
    if (await exists(join(root, name), "file")) {
      signals.push({
        kind: "verify",
        requirement: "required",
        subject: "revision",
        appliesTo: "every-revision",
        freshness: { mode: "revision" },
        acceptedSources: ["local-command"],
      });
      break;
    }
  }
  if (await hasWorkflow(root)) {
    signals.push({
      kind: "github-ci",
      requirement: "optional",
      subject: "revision",
      appliesTo: "default-branch",
      freshness: { mode: "revision" },
      acceptedSources: ["github"],
    });
  }
  const renderproveConfig = await Promise.all([
    exists(join(root, "renderprove.json"), "file"),
    exists(join(root, ".renderprove.json"), "file"),
  ]);
  if (renderproveConfig.some(Boolean)) {
    signals.push({
      kind: "browser-review",
      requirement: "optional",
      subject: "revision",
      appliesTo: "every-revision",
      freshness: { mode: "revision" },
      acceptedSources: ["adapter:renderprove"],
    });
    adapters.push({
      name: "renderprove",
      type: "receipt-file",
      path: ".renderprove/receipt.json",
      schema: "renderprove.receipt.v1",
      trust: "verified-receipt",
    });
  }
  if (await exists(join(root, "vercel.json"), "file")) {
    signals.push({
      kind: "deployment",
      requirement: "optional",
      subject: "deployment",
      appliesTo: "deployment",
      freshness: { mode: "duration", hours: 168 },
      acceptedSources: ["github"],
    });
  }
  if (lifecycle === "active" && !signals.some((signal) => signal.requirement === "required")) {
    fail(
      "REPOSITORY_AUTODETECT_INCOMPLETE",
      "Autodetection found no required verification signal; add .proofwake.json or explicitly supply a global policy.",
      "$.signals",
    );
  }
  return validateRepositoryPolicy({
    version: 1,
    repository: identity,
    lifecycle: lifecycle === "dormant" ? { state: "dormant" } : { state: "active", dormantAfterDays: 30 },
    signals: lifecycle === "dormant" ? signals.map((signal) => ({ ...signal, requirement: "optional" })) : signals,
    adapters,
  });
}

function verifyPolicyIdentity(policy, remotes, override) {
  if (override !== undefined) {
    if (policy.repository.kind !== "remote" || policy.repository.id !== override.toLowerCase()) {
      fail("REPOSITORY_IDENTITY_CONFLICT", "--repository conflicts with the selected policy.", "$.repository");
    }
  }
  if (policy.repository.kind === "local") return [];
  if (policy.repository.provider !== "github") {
    fail("REPOSITORY_PROVIDER_UNSUPPORTED", "Remote identity verification currently supports GitHub policies only.", "$.repository.provider");
  }
  const canonical = remotes.map((remote) => remote.repository).filter(Boolean);
  if (canonical.length === 0) {
    fail("REPOSITORY_REMOTE_MISSING", "Remote repository policy requires a canonical Git remote.", "$.repository.id");
  }
  if (!canonical.includes(policy.repository.id)) {
    fail("REPOSITORY_REMOTE_MISMATCH", "Policy repository identity does not match any canonical Git remote.", "$.repository.id");
  }
  return canonical;
}

export async function inspectRepositoryEnrollment(inputPath, options = {}) {
  const requested = resolve(inputPath);
  let inputRealPath;
  try {
    inputRealPath = await realpath(requested);
  } catch {
    fail("REPOSITORY_ROOT_UNAVAILABLE", "Repository path could not be resolved.", "$.root");
  }
  const topLevel = await git(inputRealPath, ["rev-parse", "--show-toplevel"]);
  const root = await realpath(topLevel);
  const rootMetadata = await stat(root);
  if (!rootMetadata.isDirectory()) fail("REPOSITORY_ROOT_INVALID", "Git top-level path must be a directory.", "$.root");

  const remotes = await inspectRemotes(root);
  const committedPath = join(root, ".proofwake.json");
  const committedPolicy = await readRepositoryPolicyFile(committedPath);
  if (committedPolicy) {
    const tracked = await git(root, ["ls-files", "--error-unmatch", "--", ".proofwake.json"], { allowFailure: true });
    if (!tracked) fail("REPOSITORY_POLICY_UNTRACKED", ".proofwake.json must be tracked before it is authoritative.", "$.configuration");
    const dirty = await git(root, ["status", "--porcelain=v1", "--untracked-files=all", "--", ".proofwake.json"], { allowFailure: true });
    if (dirty) fail("REPOSITORY_POLICY_DIRTY", ".proofwake.json has uncommitted changes.", "$.configuration");
  }

  let source;
  let policy;
  if (committedPolicy && options.globalPolicy) {
    if (repositoryPolicyFingerprint(committedPolicy) !== repositoryPolicyFingerprint(options.globalPolicy)) {
      fail("REPOSITORY_CONFIGURATION_CONFLICT", "Committed and supplied global policies differ.", "$.configuration");
    }
    source = "committed";
    policy = committedPolicy;
  } else if (committedPolicy) {
    source = "committed";
    policy = committedPolicy;
  } else if (options.globalPolicy) {
    source = "global";
    policy = validateRepositoryPolicy(options.globalPolicy);
  } else {
    source = "autodetected";
    const identity = remoteIdentityFromRemotes(remotes, options.repository) ?? localIdentity(root);
    policy = await autodetectPolicy(root, identity, options.lifecycle ?? "active");
  }

  if (options.lifecycle !== undefined && !["active", "dormant"].includes(options.lifecycle)) {
    fail("REPOSITORY_LIFECYCLE_INVALID", "--lifecycle must be active or dormant.", "$.lifecycle");
  }
  if (options.lifecycle !== undefined && policy.lifecycle.state !== options.lifecycle) {
    fail("REPOSITORY_LIFECYCLE_CONFLICT", "--lifecycle conflicts with the selected policy.", "$.lifecycle");
  }
  verifyPolicyIdentity(policy, remotes, options.repository);

  const revision = await git(root, ["rev-parse", "--verify", "HEAD"], { allowFailure: true }) || null;
  const branch = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true }) || null;
  const adapterReadiness = await inspectAdapterPaths(root, policy.adapters);
  const warnings = [];
  if (branch === null && revision !== null) warnings.push("Checkout is detached; revision evidence remains usable, but default-branch selection is unavailable.");
  if (source === "autodetected") warnings.push("Autodetected policy is a proposal and requires explicit approval before registry persistence.");
  if (policy.repository.kind === "local") warnings.push("Local identity is bound to this canonical checkout path and should be replaced by a committed policy before moving the repository.");

  return {
    repository: {
      identity: repositoryPolicyIdentity(policy.repository),
      label: repositoryPolicyLabel(policy.repository),
      value: policy.repository,
    },
    root,
    rootIdentity: { device: String(rootMetadata.dev), inode: String(rootMetadata.ino) },
    revision,
    branch,
    remotes,
    configuration: {
      source,
      path: source === "committed" ? ".proofwake.json" : null,
      fingerprint: repositoryPolicyFingerprint(policy),
    },
    policy,
    adapterReadiness,
    warnings,
  };
}
