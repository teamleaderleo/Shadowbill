import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { repositoryIdentifier } from "./git.js";
import { ObservationLedger } from "./observation-ledger.js";

const execFileAsync = promisify(execFile);

export const COMMAND_OUTPUT_LIMIT_BYTES = 1024 * 1024;
export const COMMAND_TIMEOUT_MAX_MS = 86_400_000;

const SIGNAL_KINDS = new Set([
  "verify",
  "github-ci",
  "browser-review",
  "deployment",
  "service-check",
  "domain-check",
  "host-diagnostic",
  "local-diagnostic",
  "shadowbill-estimate",
]);
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const COMMAND_MAX_ARGUMENTS = 256;
const COMMAND_MAX_ARGUMENT_LENGTH = 32_768;

export class LocalCommandError extends Error {
  constructor(code, message, path = "$") {
    super(message);
    this.name = "LocalCommandError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, message, path = "$") {
  throw new LocalCommandError(code, message, path);
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
  } catch {
    if (allowFailure) return "";
    fail("PROOFWAKE_RUN_GIT_FAILED", "Unable to inspect the selected Git checkout.");
  }
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function signalExitCode(signal) {
  const number = osConstants.signals?.[signal];
  return Number.isInteger(number) ? 128 + number : 1;
}

function inside(root, candidate) {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail("PROOFWAKE_RUN_INVALID_CLOCK", "Clock returned an invalid timestamp.");
  return date;
}

function noEarlierThan(value, minimum) {
  return value.getTime() < minimum.getTime() ? new Date(minimum) : value;
}

function outputCounter(destination, onLimit) {
  let bytes = 0;
  let newlines = 0;
  let lastByte = null;
  let forwarded = 0;
  let limited = false;

  return {
    write(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      for (const byte of buffer) if (byte === 10) newlines += 1;
      if (buffer.length > 0) lastByte = buffer.at(-1);

      const remaining = Math.max(0, COMMAND_OUTPUT_LIMIT_BYTES - forwarded);
      if (remaining > 0) {
        const visible = buffer.subarray(0, remaining);
        destination.write(visible);
        forwarded += visible.length;
      }
      if (!limited && bytes > COMMAND_OUTPUT_LIMIT_BYTES) {
        limited = true;
        onLimit();
      }
    },
    snapshot() {
      return {
        bytes,
        lines: newlines + (bytes > 0 && lastByte !== 10 ? 1 : 0),
        limited,
      };
    },
  };
}

async function inspectCheckout(cwd, repository) {
  const requested = resolve(cwd);
  let metadata;
  try {
    metadata = await lstat(requested);
  } catch {
    fail("PROOFWAKE_RUN_CWD_UNAVAILABLE", "Working directory could not be inspected.", "$.cwd");
  }
  if (metadata.isSymbolicLink()) fail("PROOFWAKE_RUN_CWD_SYMLINK", "Working directory must not be a symbolic link.", "$.cwd");
  if (!metadata.isDirectory()) fail("PROOFWAKE_RUN_CWD_INVALID", "Working directory must be a directory.", "$.cwd");

  const workingDirectory = await realpath(requested);
  const root = await realpath(await git(workingDirectory, ["rev-parse", "--show-toplevel"]));
  if (!inside(root, workingDirectory)) fail("PROOFWAKE_RUN_CWD_ESCAPE", "Working directory is outside the Git root.", "$.cwd");

  const [revision, branch, dirty, remoteOutput] = await Promise.all([
    git(root, ["rev-parse", "--verify", "HEAD"]),
    git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true }),
    git(root, ["status", "--porcelain=v1", "--untracked-files=normal"]),
    git(root, ["remote"], { allowFailure: true }),
  ]);

  const remoteNames = remoteOutput.split("\n").filter(Boolean);
  const remoteRepositories = [];
  for (const name of remoteNames) {
    const url = await git(root, ["remote", "get-url", name], { allowFailure: true });
    const identity = repositoryIdentifier(url, "");
    if (REPOSITORY.test(identity)) remoteRepositories.push(identity.toLowerCase());
  }

  const normalizedRepository = repository.toLowerCase();
  if (remoteNames.length > 0 && remoteRepositories.length === 0) {
    fail("PROOFWAKE_RUN_REMOTE_UNVERIFIED", "Git remotes exist, but none has a canonical repository identity.", "$.repository");
  }
  if (remoteRepositories.length > 0 && !remoteRepositories.includes(normalizedRepository)) {
    fail("PROOFWAKE_RUN_REPOSITORY_MISMATCH", "--repo does not match a canonical Git remote.", "$.repository");
  }

  return {
    repository: normalizedRepository,
    workingDirectory,
    root,
    revision,
    branch: branch || null,
    dirtyBefore: dirty.length > 0,
    detached: branch.length === 0,
    binding: remoteRepositories.length > 0 ? "remote-verified" : "operator-declared",
  };
}

async function inspectPostRun(checkout) {
  let revisionAfter = null;
  let dirtyAfter = null;
  let unavailable = false;
  try {
    revisionAfter = await git(checkout.root, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    unavailable = true;
  }
  try {
    dirtyAfter = (await git(checkout.root, ["status", "--porcelain=v1", "--untracked-files=normal"])).length > 0;
  } catch {
    unavailable = true;
  }
  return {
    revisionAfter: REVISION.test(revisionAfter ?? "") ? revisionAfter : null,
    dirtyAfter,
    unavailable,
  };
}

function classifyOutcome({ spawnError, timedOut, outputLimited, cancellationSignal, closeResult, hasCaveat }) {
  if (spawnError) return { failureCode: "spawn-failed", status: "unavailable", cliExitCode: 127 };
  if (timedOut) return { failureCode: "timeout", status: "failed", cliExitCode: 124 };
  if (outputLimited) return { failureCode: "output-limit", status: "failed", cliExitCode: 125 };
  if (cancellationSignal) return { failureCode: "cancelled", status: "cancelled", cliExitCode: signalExitCode(cancellationSignal) };
  if (closeResult.signal) return { failureCode: "signalled", status: "failed", cliExitCode: signalExitCode(closeResult.signal) };
  if (closeResult.code !== 0) return { failureCode: "exit-nonzero", status: "failed", cliExitCode: closeResult.code ?? 1 };
  if (hasCaveat) return { failureCode: null, status: "warning", cliExitCode: 0 };
  return { failureCode: null, status: "passed", cliExitCode: 0 };
}

function factsMap(observation) {
  return new Map((observation.data?.facts ?? []).map((entry) => [entry.name, entry.value]));
}

function commandFacts(result) {
  const outcome = result.failureCode ?? (result.hasCaveat ? "passed-with-caveat" : "passed");
  const facts = [
    { name: "proofwake.command.outcome", value: outcome },
    { name: "proofwake.command.executable-sha256", value: result.executableDigest },
    { name: "proofwake.command.argv-sha256", value: result.argvDigest },
    { name: "proofwake.command.working-directory-sha256", value: result.workingDirectoryDigest },
    { name: "proofwake.command.argument-count", value: result.argumentCount },
    { name: "proofwake.command.stdout-bytes", value: result.stdout.bytes },
    { name: "proofwake.command.stderr-bytes", value: result.stderr.bytes },
    { name: "proofwake.command.stdout-lines", value: result.stdout.lines },
    { name: "proofwake.command.stderr-lines", value: result.stderr.lines },
    { name: "proofwake.command.stdout-limited", value: result.stdout.limited },
    { name: "proofwake.command.stderr-limited", value: result.stderr.limited },
    { name: "proofwake.command.output-limit-bytes", value: COMMAND_OUTPUT_LIMIT_BYTES },
    { name: "proofwake.command.timeout-ms", value: result.timeoutMs },
    { name: "proofwake.command.timed-out", value: result.timedOut },
    { name: "proofwake.command.cancelled", value: result.cancelled },
    { name: "proofwake.command.output-limited", value: result.outputLimited },
    { name: "proofwake.command.arguments-retained", value: false },
    { name: "proofwake.command.environment-retained", value: false },
    { name: "proofwake.command.stdout-retained", value: false },
    { name: "proofwake.command.stderr-retained", value: false },
    { name: "proofwake.command.dirty-worktree", value: result.dirty },
    { name: "proofwake.command.dirty-worktree-before", value: result.dirtyBefore },
    { name: "proofwake.command.dirty-worktree-after", value: result.dirtyAfter ?? false },
    { name: "proofwake.command.revision-changed", value: result.revisionChanged },
    { name: "proofwake.command.post-inspection-unavailable", value: result.postInspectionUnavailable },
    { name: "proofwake.command.detached-head", value: result.detached },
    { name: "proofwake.command.repository-binding", value: result.binding },
  ];
  if (result.revisionAfter !== null) facts.push({ name: "proofwake.command.finished-revision", value: result.revisionAfter });
  if (result.exitCode !== null) facts.push({ name: "proofwake.command.exit-code", value: result.exitCode });
  if (result.signal !== null) facts.push({ name: "proofwake.command.signal", value: result.signal });
  if (SAFE_TOKEN.test(result.executable)) facts.push({ name: "proofwake.command.executable", value: result.executable });
  return facts;
}

function truncatedFields(result) {
  const omitted = [];
  if (result.stdout.limited) omitted.push("proofwake.command.truncated.stdout");
  if (result.stderr.limited) omitted.push("proofwake.command.truncated.stderr");
  return omitted;
}

function existingResult(record) {
  const observation = record.observation;
  const facts = factsMap(observation);
  const outcome = facts.get("proofwake.command.outcome") ?? "unknown";
  const failureCode = outcome === "passed" || outcome === "passed-with-caveat" ? null : outcome;
  const signal = facts.get("proofwake.command.signal") ?? null;
  const exitCode = facts.has("proofwake.command.exit-code") ? facts.get("proofwake.command.exit-code") : null;
  let cliExitCode = 0;
  if (failureCode === "spawn-failed") cliExitCode = 127;
  else if (failureCode === "timeout") cliExitCode = 124;
  else if (failureCode === "output-limit") cliExitCode = 125;
  else if (failureCode === "cancelled" || failureCode === "signalled") cliExitCode = signalExitCode(signal);
  else if (failureCode === "exit-nonzero") cliExitCode = exitCode ?? 1;

  return {
    runId: observation.data.relationships.run,
    repository: observation.data.relationships.repository,
    revision: observation.data.relationships.revision,
    startedAt: observation.time,
    finishedAt: observation.data.observedAt,
    durationMs: observation.data.durationMs ?? 0,
    exitCode,
    signal,
    failureCode,
    cliExitCode,
    stdout: {
      bytes: facts.get("proofwake.command.stdout-bytes") ?? 0,
      lines: facts.get("proofwake.command.stdout-lines") ?? 0,
      limited: facts.get("proofwake.command.stdout-limited") ?? false,
    },
    stderr: {
      bytes: facts.get("proofwake.command.stderr-bytes") ?? 0,
      lines: facts.get("proofwake.command.stderr-lines") ?? 0,
      limited: facts.get("proofwake.command.stderr-limited") ?? false,
    },
    timeoutMs: facts.get("proofwake.command.timeout-ms") ?? 0,
    timedOut: facts.get("proofwake.command.timed-out") ?? false,
    cancelled: facts.get("proofwake.command.cancelled") ?? false,
    outputLimited: facts.get("proofwake.command.output-limited") ?? false,
    dirty: facts.get("proofwake.command.dirty-worktree") ?? false,
    dirtyBefore: facts.get("proofwake.command.dirty-worktree-before") ?? false,
    dirtyAfter: facts.get("proofwake.command.dirty-worktree-after") ?? false,
    revisionAfter: facts.get("proofwake.command.finished-revision") ?? null,
    revisionChanged: facts.get("proofwake.command.revision-changed") ?? false,
    postInspectionUnavailable: facts.get("proofwake.command.post-inspection-unavailable") ?? false,
    hasCaveat: observation.data.status === "warning",
    detached: facts.get("proofwake.command.detached-head") ?? false,
    binding: facts.get("proofwake.command.repository-binding") ?? "unknown",
    observation,
    fingerprint: record.requestFingerprint,
    storageStatus: "duplicate",
    replayed: true,
  };
}

async function findReplay(store, runId, expected) {
  const id = `local-command.${runId}`;
  const record = (await store.readAll()).find((event) =>
    event?.type === "proofwake_observation" &&
    event.observationIdentity?.source === "urn:proofwake:adapter:local-command" &&
    event.observationIdentity?.id === id);
  if (!record) return null;

  const observation = record.observation;
  const facts = factsMap(observation);
  const matches = observation.data.kind === expected.kind &&
    observation.data.relationships?.repository === expected.repository &&
    observation.data.relationships?.revision === expected.revision &&
    observation.data.relationships?.run === runId &&
    facts.get("proofwake.command.argv-sha256") === expected.argvDigest &&
    facts.get("proofwake.command.working-directory-sha256") === expected.workingDirectoryDigest &&
    facts.get("proofwake.command.timeout-ms") === expected.timeoutMs;
  if (!matches) fail("PROOFWAKE_RUN_ID_CONFLICT", "Run ID already belongs to a different command receipt.", "$.runId");
  if (expected.dirtyBefore ||
      facts.get("proofwake.command.dirty-worktree") === true ||
      facts.get("proofwake.command.revision-changed") === true ||
      facts.get("proofwake.command.post-inspection-unavailable") === true) {
    fail("PROOFWAKE_RUN_REPLAY_UNSTABLE", "Run IDs cannot replay evidence from an unstable checkout state.", "$.runId");
  }
  return existingResult(record);
}

function validateCommand(command) {
  if (!Array.isArray(command) || command.length === 0 || command.length > COMMAND_MAX_ARGUMENTS) {
    fail("PROOFWAKE_RUN_INVALID_COMMAND", `Command must contain 1..${COMMAND_MAX_ARGUMENTS} arguments.`, "$.command");
  }
  if (command.some((value) => typeof value !== "string" || value.length > COMMAND_MAX_ARGUMENT_LENGTH)) {
    fail("PROOFWAKE_RUN_INVALID_COMMAND", "Command arguments must be bounded strings.", "$.command");
  }
  if (command[0].length === 0) fail("PROOFWAKE_RUN_INVALID_COMMAND", "Command executable must not be empty.", "$.command[0]");
}

export async function executeLocalCommand({
  repository,
  kind,
  command,
  cwd = process.cwd(),
  timeoutMs = 0,
  outputMode = "human",
  runId = randomUUID(),
  store,
  now = () => new Date(),
}) {
  if (process.env.PROOFWAKE_RUN_ACTIVE) fail("PROOFWAKE_RUN_NESTED", "Nested proofwake run invocations are rejected.");
  if (typeof repository !== "string" || !REPOSITORY.test(repository)) fail("PROOFWAKE_RUN_INVALID_REPOSITORY", "--repo must use owner/name form.", "$.repository");
  if (!SIGNAL_KINDS.has(kind)) fail("PROOFWAKE_RUN_INVALID_KIND", `Unsupported signal kind: ${kind}.`, "$.kind");
  if (!RUN_ID.test(runId)) fail("PROOFWAKE_RUN_INVALID_ID", "Run ID must be a bounded token.", "$.runId");
  validateCommand(command);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > COMMAND_TIMEOUT_MAX_MS) {
    fail("PROOFWAKE_RUN_INVALID_TIMEOUT", "Timeout must be between 0 and 86400000 milliseconds.", "$.timeoutMs");
  }
  if (outputMode !== "human" && outputMode !== "json") fail("PROOFWAKE_RUN_INVALID_OUTPUT", "Output mode must be human or json.", "$.outputMode");
  if (!store || typeof store.readAll !== "function") fail("PROOFWAKE_RUN_INVALID_STORE", "A readable event store is required.");

  const checkout = await inspectCheckout(cwd, repository);
  const argvDigest = sha256(JSON.stringify(command));
  const workingDirectoryDigest = sha256(checkout.workingDirectory);
  const executableDigest = sha256(command[0]);
  const replay = await findReplay(store, runId, {
    kind,
    repository: checkout.repository,
    revision: checkout.revision,
    argvDigest,
    workingDirectoryDigest,
    timeoutMs,
    dirtyBefore: checkout.dirtyBefore,
  });
  if (replay) return replay;

  const started = timestamp(now());
  const startedMonotonic = process.hrtime.bigint();
  let child;
  let timeout;
  let killTimer;
  let cancellationSignal = null;
  let timedOut = false;
  let outputLimited = false;
  let spawnError = null;
  let completed = false;

  const terminate = (reason, signal = "SIGTERM") => {
    if (completed || !child) return;
    if (reason === "timeout") timedOut = true;
    if (reason === "output") outputLimited = true;
    child.kill(signal);
    clearTimeout(killTimer);
    killTimer = setTimeout(() => {
      if (!completed) child.kill("SIGKILL");
    }, 2000);
    killTimer.unref?.();
  };

  const stdout = outputCounter(outputMode === "json" ? process.stderr : process.stdout, () => terminate("output"));
  const stderr = outputCounter(process.stderr, () => terminate("output"));
  const onSigint = () => {
    cancellationSignal = "SIGINT";
    terminate("cancel", "SIGINT");
  };
  const onSigterm = () => {
    cancellationSignal = "SIGTERM";
    terminate("cancel", "SIGTERM");
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  let closeResult;
  try {
    closeResult = await new Promise((resolveClose) => {
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        resolveClose(value);
      };
      try {
        child = spawn(command[0], command.slice(1), {
          cwd: checkout.workingDirectory,
          env: { ...process.env, PROOFWAKE_RUN_ACTIVE: runId },
          shell: false,
          stdio: ["inherit", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        spawnError = error;
        settle({ code: null, signal: null });
        return;
      }
      child.stdout.on("data", (chunk) => stdout.write(chunk));
      child.stderr.on("data", (chunk) => stderr.write(chunk));
      child.once("error", (error) => {
        spawnError = error;
        settle({ code: null, signal: null });
      });
      child.once("close", (code, signal) => settle({ code, signal }));
      if (timeoutMs > 0) {
        timeout = setTimeout(() => terminate("timeout"), timeoutMs);
        timeout.unref?.();
      }
    });
  } finally {
    completed = true;
    clearTimeout(timeout);
    clearTimeout(killTimer);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }

  const postRun = await inspectPostRun(checkout);
  const dirtyAfter = postRun.dirtyAfter;
  const dirty = checkout.dirtyBefore || dirtyAfter === true;
  const revisionChanged = postRun.revisionAfter !== null && postRun.revisionAfter !== checkout.revision;
  const hasCaveat = dirty || revisionChanged || postRun.unavailable;
  const durationMs = Number((process.hrtime.bigint() - startedMonotonic) / 1_000_000n);
  const finished = noEarlierThan(timestamp(now()), started);
  const ingested = noEarlierThan(timestamp(now()), finished);
  const outcome = classifyOutcome({ spawnError, timedOut, outputLimited, cancellationSignal, closeResult, hasCaveat });
  const result = {
    runId,
    repository: checkout.repository,
    revision: checkout.revision,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: Math.max(0, durationMs),
    exitCode: closeResult.code,
    signal: closeResult.signal ?? cancellationSignal,
    failureCode: outcome.failureCode,
    cliExitCode: outcome.cliExitCode,
    executable: basename(command[0]),
    executableDigest,
    argvDigest,
    workingDirectoryDigest,
    argumentCount: Math.max(0, command.length - 1),
    stdout: stdout.snapshot(),
    stderr: stderr.snapshot(),
    timeoutMs,
    timedOut,
    cancelled: Boolean(cancellationSignal),
    outputLimited,
    dirty,
    dirtyBefore: checkout.dirtyBefore,
    dirtyAfter,
    revisionAfter: postRun.revisionAfter,
    revisionChanged,
    postInspectionUnavailable: postRun.unavailable,
    hasCaveat,
    detached: checkout.detached,
    binding: checkout.binding,
  };

  const omitted = truncatedFields(result);
  const observation = {
    specversion: "1.0",
    id: `local-command.${runId}`,
    source: "urn:proofwake:adapter:local-command",
    type: `dev.proofwake.observation.${kind}.v1`,
    subject: `repo:${checkout.repository}@sha:${checkout.revision}`,
    time: result.startedAt,
    dataschema: "urn:proofwake:schema:observation:v1",
    data: {
      schemaVersion: 1,
      adapter: {
        name: "local-command",
        version: "0.3.0",
        mappingVersion: 1,
        trust: "local-operator",
        sourceSchema: "proofwake.command-receipt",
        sourceSchemaVersion: "1",
      },
      kind,
      status: outcome.status,
      timeSource: "adapter",
      observedAt: result.finishedAt,
      ingestedAt: ingested.toISOString(),
      durationMs: result.durationMs,
      relationships: {
        repository: checkout.repository,
        revision: checkout.revision,
        run: runId,
      },
      facts: commandFacts(result),
      evidence: [],
      coverage: {
        state: omitted.length > 0 ? "partial" : "complete",
        redacted: false,
        truncated: omitted.length > 0,
        omitted,
      },
    },
  };

  const stored = await new ObservationLedger(store).append(observation);
  return {
    ...result,
    observation: stored.observation,
    fingerprint: stored.fingerprint,
    storageStatus: stored.status,
    replayed: false,
  };
}
