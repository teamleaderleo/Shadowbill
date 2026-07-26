import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { ObservationLedger } from "./observation-ledger.js";
import { OBSERVATION_SCHEMA } from "./observation.js";
import { inspectRepositoryEnrollment } from "./repository-enrollment.js";
import { parseStrictJson } from "./strict-json.js";

const execFileAsync = promisify(execFile);

export const RENDERPROVE_RECEIPT_SCHEMA = "https://raw.githubusercontent.com/teamleaderleo/renderprove/main/schema/receipt-v1.schema.json";
export const RENDERPROVE_RECEIPT_MAX_BYTES = 4 * 1024 * 1024;
export const RENDERPROVE_ARTIFACT_MAX_BYTES = 128 * 1024 * 1024;
export const RENDERPROVE_ARTIFACT_TOTAL_MAX_BYTES = 512 * 1024 * 1024;
export const RENDERPROVE_MAX_CASES = 25;
export const RENDERPROVE_MAX_ARTIFACTS = 15;

const RECEIPT_KEYS = new Set([
  "$schema", "version", "project", "source", "target", "startedAt", "finishedAt",
  "durationMs", "status", "summary", "runtime", "cases",
]);
const CASE_KEYS = new Set([
  "id", "status", "startedAt", "finishedAt", "route", "viewport", "navigation",
  "page", "artifacts", "diagnostics",
]);
const DIAGNOSTIC_KINDS = ["console", "page", "request", "http"];
const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class RenderproveAdapterError extends Error {
  constructor(code, message, path = "$") {
    super(message);
    this.name = "RenderproveAdapterError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, message, path = "$") {
  throw new RenderproveAdapterError(code, message, path);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, required, path) {
  if (!isObject(value)) fail("RENDERPROVE_INVALID_TYPE", "Expected an object.", path);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("RENDERPROVE_UNKNOWN_FIELD", `Unknown receipt field: ${key}.`, `${path}.${key}`);
  }
  for (const key of required) {
    if (!(key in value)) fail("RENDERPROVE_MISSING_FIELD", `Missing receipt field: ${key}.`, `${path}.${key}`);
  }
}

function text(value, path, { min = 1, max = 4096, pattern } = {}) {
  if (typeof value !== "string") fail("RENDERPROVE_INVALID_TYPE", "Expected a string.", path);
  if (value.length < min || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("RENDERPROVE_INVALID_VALUE", `String must contain ${min}..${max} characters without controls.`, path);
  }
  if (pattern && !pattern.test(value)) fail("RENDERPROVE_INVALID_VALUE", "String has an invalid format.", path);
  return value;
}

function count(value, path, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail("RENDERPROVE_INVALID_VALUE", `Expected a non-negative integer no greater than ${maximum}.`, path);
  }
  return value;
}

function instant(value, path) {
  text(value, path, { max: 64 });
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail("RENDERPROVE_INVALID_TIMESTAMP", "Expected a canonical UTC timestamp.", path);
  }
  return value;
}

function oneOf(value, allowed, path) {
  text(value, path, { max: 64 });
  if (!allowed.has(value)) fail("RENDERPROVE_INVALID_VALUE", `Unsupported value: ${value}.`, path);
  return value;
}

function httpUrl(value, path) {
  text(value, path, { max: 8192 });
  try {
    const parsed = new URL(value);
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) throw new Error("protocol");
  } catch {
    fail("RENDERPROVE_INVALID_VALUE", "Expected an absolute HTTP or HTTPS URL.", path);
  }
  return value;
}

function portablePath(value, path) {
  text(value, path, { max: 1024 });
  if (isAbsolute(value) || value.includes("\\") || value.includes(":") || /\s/u.test(value)) {
    fail("RENDERPROVE_PATH_ESCAPE", "Path must be portable and project-relative.", path);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("RENDERPROVE_PATH_ESCAPE", "Path contains an unsafe segment.", path);
  }
  return value;
}

function validateRuntime(runtime) {
  if (!isObject(runtime)) fail("RENDERPROVE_INVALID_TYPE", "Expected an object.", "$.runtime");
  const mode = oneOf(runtime.mode, new Set(["local", "remote"]), "$.runtime.mode");
  if (mode === "remote") {
    exactKeys(runtime, new Set(["mode", "logs"]), ["mode"], "$.runtime");
    if ("logs" in runtime && runtime.logs !== null) fail("RENDERPROVE_INVALID_VALUE", "Remote logs must be null.", "$.runtime.logs");
    return { mode };
  }
  exactKeys(runtime, new Set(["mode", "command", "cwd", "logs"]), ["mode", "command", "cwd", "logs"], "$.runtime");
  if (!Array.isArray(runtime.command) || runtime.command.length < 1 || runtime.command.length > 128) {
    fail("RENDERPROVE_INVALID_VALUE", "Runtime command must contain 1..128 arguments.", "$.runtime.command");
  }
  runtime.command.forEach((entry, index) => text(entry, `$.runtime.command[${index}]`, { min: 0, max: 4096 }));
  text(runtime.cwd, "$.runtime.cwd", { max: 4096 });
  exactKeys(runtime.logs, new Set(["stdoutBytes", "stderrBytes", "exit"]), ["stdoutBytes", "stderrBytes", "exit"], "$.runtime.logs");
  count(runtime.logs.stdoutBytes, "$.runtime.logs.stdoutBytes");
  count(runtime.logs.stderrBytes, "$.runtime.logs.stderrBytes");
  if (runtime.logs.exit !== null && !isObject(runtime.logs.exit)) fail("RENDERPROVE_INVALID_TYPE", "Runtime exit must be an object or null.", "$.runtime.logs.exit");
  return { mode };
}

function validatePage(page, path) {
  if (page === null) return { unavailable: true, horizontalOverflow: false };
  exactKeys(page, new Set([
    "title", "lang", "bodyTextLength", "scrollWidth", "clientWidth", "scrollHeight", "clientHeight",
  ]), ["title", "lang", "bodyTextLength", "scrollWidth", "clientWidth", "scrollHeight", "clientHeight"], path);
  text(page.title, `${path}.title`, { min: 0, max: 8192 });
  if (page.lang !== null) text(page.lang, `${path}.lang`, { max: 128 });
  for (const key of ["bodyTextLength", "scrollWidth", "clientWidth", "scrollHeight", "clientHeight"]) count(page[key], `${path}.${key}`);
  return { unavailable: false, horizontalOverflow: page.scrollWidth > page.clientWidth };
}

function validateDiagnostic(value, path) {
  if (!isObject(value)) fail("RENDERPROVE_INVALID_TYPE", "Expected a diagnostic object.", path);
  for (const required of ["at", "kind", "message"]) {
    if (!(required in value)) fail("RENDERPROVE_MISSING_FIELD", `Missing diagnostic field: ${required}.`, `${path}.${required}`);
  }
  if (Object.keys(value).length > 16) fail("RENDERPROVE_INVALID_VALUE", "Diagnostic contains too many fields.", path);
  instant(value.at, `${path}.at`);
  const kind = oneOf(value.kind, new Set(DIAGNOSTIC_KINDS), `${path}.kind`);
  text(value.message, `${path}.message`, { min: 0, max: 32_768 });
  return kind;
}

function validateCase(value, index) {
  const path = `$.cases[${index}]`;
  exactKeys(value, CASE_KEYS, [...CASE_KEYS], path);
  const id = text(value.id, `${path}.id`, { max: 512 });
  const status = oneOf(value.status, new Set(["passed", "failed"]), `${path}.status`);
  const startedAt = instant(value.startedAt, `${path}.startedAt`);
  const finishedAt = instant(value.finishedAt, `${path}.finishedAt`);
  if (Date.parse(finishedAt) < Date.parse(startedAt)) fail("RENDERPROVE_TIME_CONFLICT", "Case finished before it started.", `${path}.finishedAt`);

  exactKeys(value.route, new Set(["name", "path", "requestedUrl", "finalUrl"]), ["name", "path", "requestedUrl", "finalUrl"], `${path}.route`);
  text(value.route.name, `${path}.route.name`, { min: 0, max: 512 });
  const routePath = text(value.route.path, `${path}.route.path`, { max: 4096 });
  if (!routePath.startsWith("/")) fail("RENDERPROVE_INVALID_VALUE", "Route path must begin with a slash.", `${path}.route.path`);
  httpUrl(value.route.requestedUrl, `${path}.route.requestedUrl`);
  text(value.route.finalUrl, `${path}.route.finalUrl`, { min: 0, max: 8192 });

  exactKeys(value.viewport, new Set(["name", "width", "height", "deviceScaleFactor"]), ["name", "width", "height", "deviceScaleFactor"], `${path}.viewport`);
  text(value.viewport.name, `${path}.viewport.name`, { max: 256 });
  for (const key of ["width", "height"]) {
    count(value.viewport[key], `${path}.viewport.${key}`, 100_000);
    if (value.viewport[key] < 240) fail("RENDERPROVE_INVALID_VALUE", "Viewport dimension must be at least 240.", `${path}.viewport.${key}`);
  }
  count(value.viewport.deviceScaleFactor, `${path}.viewport.deviceScaleFactor`, 16);
  if (value.viewport.deviceScaleFactor < 1) fail("RENDERPROVE_INVALID_VALUE", "Device scale factor must be at least 1.", `${path}.viewport.deviceScaleFactor`);

  exactKeys(value.navigation, new Set(["status", "ok"]), ["status", "ok"], `${path}.navigation`);
  if (value.navigation.status !== null) count(value.navigation.status, `${path}.navigation.status`, 999);
  if (typeof value.navigation.ok !== "boolean") fail("RENDERPROVE_INVALID_TYPE", "Navigation ok must be boolean.", `${path}.navigation.ok`);
  const page = validatePage(value.page, `${path}.page`);

  if (!Array.isArray(value.artifacts) || value.artifacts.length > RENDERPROVE_MAX_ARTIFACTS) {
    fail("RENDERPROVE_ARTIFACT_LIMIT", `A case may reference at most ${RENDERPROVE_MAX_ARTIFACTS} artifacts.`, `${path}.artifacts`);
  }
  const artifacts = value.artifacts.map((artifact, artifactIndex) => {
    const artifactPath = `${path}.artifacts[${artifactIndex}]`;
    exactKeys(artifact, new Set(["kind", "path", "mimeType", "sha256"]), ["kind", "path", "mimeType", "sha256"], artifactPath);
    if (artifact.kind !== "screenshot" || artifact.mimeType !== "image/png") {
      fail("RENDERPROVE_ARTIFACT_UNSUPPORTED", "Receipt v1 supports PNG screenshot artifacts only.", artifactPath);
    }
    return {
      path: portablePath(artifact.path, `${artifactPath}.path`),
      sha256: text(artifact.sha256, `${artifactPath}.sha256`, { min: 64, max: 64, pattern: SHA256 }),
    };
  });

  if (!Array.isArray(value.diagnostics) || value.diagnostics.length > 1024) {
    fail("RENDERPROVE_DIAGNOSTIC_LIMIT", "A case may contain at most 1024 diagnostics.", `${path}.diagnostics`);
  }
  const diagnosticKinds = Object.fromEntries(DIAGNOSTIC_KINDS.map((kind) => [kind, 0]));
  value.diagnostics.forEach((diagnostic, diagnosticIndex) => {
    diagnosticKinds[validateDiagnostic(diagnostic, `${path}.diagnostics[${diagnosticIndex}]`)] += 1;
  });
  return {
    id,
    status,
    navigationOk: value.navigation.ok,
    pageUnavailable: page.unavailable,
    horizontalOverflow: page.horizontalOverflow,
    artifacts,
    diagnosticCount: value.diagnostics.length,
    diagnosticKinds,
  };
}

export function validateRenderproveReceipt(value) {
  exactKeys(value, RECEIPT_KEYS, [...RECEIPT_KEYS], "$");
  if (value.$schema !== RENDERPROVE_RECEIPT_SCHEMA || value.version !== 1) {
    fail("RENDERPROVE_SCHEMA_UNSUPPORTED", "Unsupported Renderprove receipt schema or version.", "$.version");
  }
  const project = text(value.project, "$.project", { max: 512 });
  exactKeys(value.source, new Set(["manifest"]), ["manifest"], "$.source");
  const manifest = value.source.manifest === null ? null : portablePath(value.source.manifest, "$.source.manifest");
  exactKeys(value.target, new Set(["baseUrl"]), ["baseUrl"], "$.target");
  httpUrl(value.target.baseUrl, "$.target.baseUrl");
  const startedAt = instant(value.startedAt, "$.startedAt");
  const finishedAt = instant(value.finishedAt, "$.finishedAt");
  const durationMs = count(value.durationMs, "$.durationMs");
  if (Date.parse(finishedAt) < Date.parse(startedAt) || Date.parse(finishedAt) - Date.parse(startedAt) !== durationMs) {
    fail("RENDERPROVE_TIME_CONFLICT", "Receipt duration does not match its timestamps.", "$.durationMs");
  }
  const status = oneOf(value.status, new Set(["passed", "failed"]), "$.status");
  exactKeys(value.summary, new Set(["cases", "passed", "failed", "diagnostics"]), ["cases", "passed", "failed", "diagnostics"], "$.summary");
  for (const key of ["cases", "passed", "failed", "diagnostics"]) count(value.summary[key], `$.summary.${key}`);
  const runtime = validateRuntime(value.runtime);
  if (!Array.isArray(value.cases) || value.cases.length > RENDERPROVE_MAX_CASES) {
    fail("RENDERPROVE_CASE_LIMIT", `Receipt may contain at most ${RENDERPROVE_MAX_CASES} cases.`, "$.cases");
  }
  const cases = value.cases.map(validateCase);
  const caseIds = new Set();
  for (const item of cases) {
    if (caseIds.has(item.id)) fail("RENDERPROVE_DUPLICATE_CASE", "Receipt case IDs must be unique.", "$.cases");
    caseIds.add(item.id);
  }
  const failed = cases.filter((item) => item.status === "failed").length;
  const diagnostics = cases.reduce((total, item) => total + item.diagnosticCount, 0);
  if (value.summary.cases !== cases.length || value.summary.failed !== failed ||
      value.summary.passed !== cases.length - failed || value.summary.diagnostics !== diagnostics ||
      status !== (failed === 0 ? "passed" : "failed")) {
    fail("RENDERPROVE_SUMMARY_CONFLICT", "Receipt summary or status does not match its cases.", "$.summary");
  }
  const artifactCount = cases.reduce((total, item) => total + item.artifacts.length, 0);
  if (artifactCount > RENDERPROVE_MAX_ARTIFACTS) {
    fail("RENDERPROVE_ARTIFACT_LIMIT", `Receipt may reference at most ${RENDERPROVE_MAX_ARTIFACTS} artifacts.`, "$.cases");
  }
  return { project, manifest, startedAt, finishedAt, durationMs, status, summary: { ...value.summary }, runtime, cases };
}

function inside(root, candidate) {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readBoundedFile(root, relativePath, maximumBytes, codePrefix) {
  const canonicalRoot = await realpath(root);
  const candidate = resolve(canonicalRoot, relativePath);
  if (!inside(canonicalRoot, candidate)) fail(`${codePrefix}_PATH_ESCAPE`, "Selected file escapes the repository root.");
  let pathMetadata;
  let canonicalCandidate;
  try {
    pathMetadata = await lstat(candidate);
    canonicalCandidate = await realpath(candidate);
  } catch {
    fail(`${codePrefix}_UNAVAILABLE`, "Selected file is unavailable.");
  }
  if (pathMetadata.isSymbolicLink()) fail(`${codePrefix}_SYMLINK`, "Selected file must not be a symbolic link.");
  if (!pathMetadata.isFile()) fail(`${codePrefix}_NOT_FILE`, "Selected file must be a regular file.");
  if (!inside(canonicalRoot, canonicalCandidate)) fail(`${codePrefix}_PATH_ESCAPE`, "Selected file resolves outside the repository root.");
  if (pathMetadata.size > maximumBytes) fail(`${codePrefix}_TOO_LARGE`, `Selected file exceeds ${maximumBytes} bytes.`);
  let handle;
  try {
    handle = await open(canonicalCandidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    fail(`${codePrefix}_UNAVAILABLE`, "Selected file could not be opened.");
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameFile(before, pathMetadata)) fail(`${codePrefix}_CHANGED`, "Selected file changed before it could be read.");
    if (before.size > maximumBytes) fail(`${codePrefix}_TOO_LARGE`, `Selected file exceeds ${maximumBytes} bytes.`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    let pathAfter;
    try {
      pathAfter = await lstat(candidate);
    } catch {
      fail(`${codePrefix}_CHANGED`, "Selected file changed while it was being read.");
    }
    if (!sameFile(before, after) || !sameFile(after, pathAfter) || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      fail(`${codePrefix}_CHANGED`, "Selected file changed while it was being read.");
    }
    if (bytes.length > maximumBytes) fail(`${codePrefix}_TOO_LARGE`, `Selected file exceeds ${maximumBytes} bytes.`);
    return { bytes, sizeBytes: bytes.length, digest: createHash("sha256").update(bytes).digest("hex"), relativePath };
  } finally {
    await handle.close();
  }
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("RENDERPROVE_RECEIPT_INVALID_UTF8", "Renderprove receipt must be valid UTF-8.");
  }
}

async function git(root, args, { allowFailure = false } = {}) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, stdout: stdout.trim() };
  } catch (error) {
    if (allowFailure) return { ok: false, stdout: "", code: typeof error?.code === "number" ? error.code : null };
    fail("RENDERPROVE_GIT_FAILED", "Git inspection failed.");
  }
}

async function inspectCheckout(root) {
  const revision = (await git(root, ["rev-parse", "--verify", "HEAD"])).stdout;
  if (!REVISION.test(revision)) fail("RENDERPROVE_REVISION_UNAVAILABLE", "A full checkout revision is required.");
  const tracked = await git(root, ["diff", "--quiet", "HEAD", "--"], { allowFailure: true });
  const staged = await git(root, ["diff", "--cached", "--quiet", "HEAD", "--"], { allowFailure: true });
  if (!tracked.ok || !staged.ok) fail("RENDERPROVE_CHECKOUT_DIRTY", "Tracked checkout changes prevent revision binding.");
  const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard"])).stdout
    .split("\n").filter(Boolean).map((value) => value.replaceAll("\\", "/")).sort();
  return { revision, untracked };
}

function digestToken(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function evidenceUri(kind, digest) {
  return `urn:renderprove:${kind}:sha256:${digest}`;
}

function summaryFacts(receipt) {
  const diagnosticTotals = Object.fromEntries(DIAGNOSTIC_KINDS.map((kind) => [kind, 0]));
  let navigationFailed = 0;
  let pageUnavailable = 0;
  let horizontalOverflow = 0;
  for (const item of receipt.cases) {
    if (!item.navigationOk) navigationFailed += 1;
    if (item.pageUnavailable) pageUnavailable += 1;
    if (item.horizontalOverflow) horizontalOverflow += 1;
    for (const kind of DIAGNOSTIC_KINDS) diagnosticTotals[kind] += item.diagnosticKinds[kind];
  }
  return [
    { name: "renderprove.summary.navigation-failed", value: navigationFailed },
    { name: "renderprove.summary.page-unavailable", value: pageUnavailable },
    { name: "renderprove.summary.horizontal-overflow", value: horizontalOverflow },
    ...DIAGNOSTIC_KINDS.map((kind) => ({ name: `renderprove.diagnostics.${kind}`, value: diagnosticTotals[kind] })),
  ];
}

function buildObservation({ repository, revision, receipt, receiptFile, artifacts, ingestedAt }) {
  const receiptIdentity = digestToken(`${receipt.project}\u0000${receipt.startedAt}\u0000${receipt.finishedAt}`);
  const mappedStatus = receipt.summary.cases === 0 ? "unavailable" : receipt.status;
  const facts = [
    { name: "renderprove.project.identity", value: digestToken(receipt.project) },
    { name: "renderprove.manifest.identity", value: receipt.manifest === null ? "none" : digestToken(receipt.manifest) },
    { name: "renderprove.runtime.mode", value: receipt.runtime.mode },
    { name: "renderprove.summary.cases", value: receipt.summary.cases },
    { name: "renderprove.summary.passed", value: receipt.summary.passed },
    { name: "renderprove.summary.failed", value: receipt.summary.failed },
    { name: "renderprove.summary.diagnostics", value: receipt.summary.diagnostics },
    ...summaryFacts(receipt),
  ];
  for (const item of receipt.cases) {
    const identity = digestToken(item.id);
    facts.push({ name: `renderprove.case.${identity}.status`, value: item.status });
    facts.push({ name: `renderprove.case.${identity}.navigation-ok`, value: item.navigationOk });
  }
  const evidence = [{
    uri: evidenceUri("receipt", receiptFile.digest),
    digest: `sha256:${receiptFile.digest}`,
    sizeBytes: receiptFile.sizeBytes,
    mediaType: "application/json",
    producer: "renderprove",
    schema: "renderprove.receipt.v1",
    state: "verified",
    disclosure: "restricted-reference",
  }];
  const seen = new Set([receiptFile.digest]);
  for (const artifact of artifacts) {
    if (seen.has(artifact.digest)) continue;
    seen.add(artifact.digest);
    evidence.push({
      uri: evidenceUri("artifact", artifact.digest),
      digest: `sha256:${artifact.digest}`,
      sizeBytes: artifact.sizeBytes,
      mediaType: "image/png",
      producer: "renderprove",
      schema: "renderprove.screenshot.v1",
      state: "verified",
      disclosure: "restricted-reference",
    });
  }
  return {
    specversion: "1.0",
    id: `renderprove.${receiptIdentity}`,
    source: "urn:proofwake:adapter:renderprove",
    type: "dev.proofwake.observation.browser-review.v1",
    subject: `repo:${repository}@sha:${revision}`,
    time: receipt.finishedAt,
    dataschema: OBSERVATION_SCHEMA,
    data: {
      schemaVersion: 1,
      adapter: {
        name: "renderprove",
        version: "1.0.0",
        mappingVersion: 1,
        trust: "local-operator",
        sourceSchema: RENDERPROVE_RECEIPT_SCHEMA,
        sourceSchemaVersion: "1",
      },
      kind: "browser-review",
      status: mappedStatus,
      timeSource: "producer",
      observedAt: receipt.finishedAt,
      ingestedAt,
      durationMs: receipt.durationMs,
      relationships: { repository, revision, run: `renderprove-${receiptIdentity.slice(0, 32)}` },
      facts,
      evidence,
      coverage: { state: mappedStatus === "unavailable" ? "unavailable" : "complete", redacted: false, truncated: false, omitted: [] },
    },
  };
}

function hasPngSignature(bytes) {
  return bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

export async function ingestRenderproveReceipt({ entry, eventStore, adapterName = "renderprove", revision, now = new Date() }) {
  if (!entry?.policy || !entry?.root) fail("RENDERPROVE_REPOSITORY_INVALID", "Enrolled repository metadata is unavailable.");
  const inspection = await inspectRepositoryEnrollment(entry.root, {
    globalPolicy: entry.configuration.source === "global" ? entry.policy : undefined,
    lifecycle: entry.policy.lifecycle.state,
  });
  if (inspection.policy.repository.kind !== "remote") fail("RENDERPROVE_REPOSITORY_UNSUPPORTED", "Renderprove adapter v1 requires a remote owner/name repository identity.");
  const repository = inspection.policy.repository.id;
  const adapter = inspection.policy.adapters.find((candidate) => candidate.name === adapterName);
  if (!adapter || adapter.type !== "receipt-file" || adapter.schema !== "renderprove.receipt.v1") fail("RENDERPROVE_ADAPTER_UNDECLARED", "Repository policy does not declare the selected Renderprove receipt adapter.");
  const readiness = inspection.adapterReadiness[adapterName];
  if (!readiness || readiness.state !== "ready") fail(readiness?.code ?? "RENDERPROVE_RECEIPT_UNAVAILABLE", "Declared Renderprove receipt is not ready for ingestion.");
  const signal = inspection.policy.signals.find((candidate) => candidate.kind === "browser-review" && candidate.acceptedSources.includes(`adapter:${adapterName}`));
  if (!signal) fail("RENDERPROVE_SIGNAL_UNDECLARED", "Repository policy does not accept this adapter for browser-review evidence.");
  const before = await inspectCheckout(entry.root);
  if (revision !== undefined && revision !== before.revision) fail("RENDERPROVE_REVISION_CONFLICT", "Explicit revision must match the clean current checkout.", "$.revision");
  const receiptFile = await readBoundedFile(entry.root, adapter.path, RENDERPROVE_RECEIPT_MAX_BYTES, "RENDERPROVE_RECEIPT");
  const raw = parseStrictJson(decodeUtf8(receiptFile.bytes), {
    maxBytes: RENDERPROVE_RECEIPT_MAX_BYTES,
    maxDepth: 24,
    maxStringLength: 32_768,
    maxObjectKeys: 128,
    maxArrayLength: 2048,
    prefix: "RENDERPROVE_RECEIPT",
  });
  const receipt = validateRenderproveReceipt(raw);
  const ingestedAt = now.toISOString();
  if (Date.parse(ingestedAt) < Date.parse(receipt.finishedAt)) fail("RENDERPROVE_CLOCK_SKEW", "Receipt completion time is later than the ingestion clock.", "$.finishedAt");
  const artifactPaths = [];
  const artifactsByPath = new Map();
  let artifactBytes = 0;
  for (const item of receipt.cases) {
    for (const reference of item.artifacts) {
      artifactPaths.push(reference.path);
      const existing = artifactsByPath.get(reference.path);
      if (existing) {
        if (existing.digest !== reference.sha256) fail("RENDERPROVE_ARTIFACT_REFERENCE_CONFLICT", "One artifact path has conflicting receipt digests.");
        continue;
      }
      const artifact = await readBoundedFile(entry.root, reference.path, RENDERPROVE_ARTIFACT_MAX_BYTES, "RENDERPROVE_ARTIFACT");
      if (artifact.digest !== reference.sha256) fail("RENDERPROVE_ARTIFACT_DIGEST_MISMATCH", "Screenshot digest does not match the receipt.");
      if (!hasPngSignature(artifact.bytes)) fail("RENDERPROVE_ARTIFACT_MEDIA_MISMATCH", "Screenshot bytes do not match image/png.");
      artifactBytes += artifact.sizeBytes;
      if (artifactBytes > RENDERPROVE_ARTIFACT_TOTAL_MAX_BYTES) fail("RENDERPROVE_ARTIFACT_TOTAL_TOO_LARGE", `Verified artifacts exceed ${RENDERPROVE_ARTIFACT_TOTAL_MAX_BYTES} bytes.`);
      artifactsByPath.set(reference.path, artifact);
    }
  }
  const allowedUntracked = new Set([adapter.path, ...artifactPaths].map((value) => value.replaceAll("\\", "/")));
  if (before.untracked.some((value) => !allowedUntracked.has(value))) fail("RENDERPROVE_CHECKOUT_DIRTY", "Untracked project files prevent revision binding.");
  const after = await inspectCheckout(entry.root);
  if (after.revision !== before.revision || after.untracked.some((value) => !allowedUntracked.has(value))) fail("RENDERPROVE_CHECKOUT_CHANGED", "Checkout changed while the receipt was being verified.");
  const artifacts = [...artifactsByPath.values()];
  const observation = buildObservation({ repository, revision: before.revision, receipt, receiptFile, artifacts, ingestedAt });
  const result = await new ObservationLedger(eventStore).append(observation);
  return {
    ...result,
    receiptDigest: `sha256:${receiptFile.digest}`,
    caseCount: receipt.summary.cases,
    artifactCount: artifacts.length,
    repository,
    revision: before.revision,
    browserStatus: observation.data.status,
    producerStatus: receipt.status,
  };
}
