const SAFE_PROBLEM_MESSAGES = new Map([
  ["REPOSITORY_ROOT_MISSING", "Enrolled repository root is missing."],
  ["REPOSITORY_ROOT_INVALID", "Enrolled repository root is invalid."],
  ["REPOSITORY_ROOT_REPLACED", "Enrolled repository root identity changed."],
  ["REPOSITORY_POLICY_MISSING", "Committed repository policy is missing."],
  ["REPOSITORY_CONFIGURATION_CONFLICT", "Committed and approved repository policies differ."],
  ["PROJECTION_POLICY_UNAVAILABLE", "Repository policy is unavailable."],
  ["PROJECTION_REVISION_UNAVAILABLE", "Selected revision is unavailable."],
  ["PROJECTION_INVALID_REVISION", "Selected revision is invalid."],
]);

const OMITTED_KEYS = new Set([
  "path",
  "root",
  "cwd",
  "stdout",
  "stderr",
  "logs",
  "prompt",
  "response",
  "token",
  "secret",
  "environment",
]);

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeProblemMessage(code) {
  if (SAFE_PROBLEM_MESSAGES.has(code)) return SAFE_PROBLEM_MESSAGES.get(code);
  if (typeof code === "string" && code.startsWith("REPOSITORY_POLICY_")) {
    return "Repository policy is invalid.";
  }
  if (typeof code === "string" && code.startsWith("REPOSITORY_")) {
    return "Repository configuration is invalid.";
  }
  if (typeof code === "string" && code.startsWith("PROJECTION_")) {
    return "Repository projection is unavailable.";
  }
  return "Repository inspection failed.";
}

function safeProblem(problem) {
  const code = typeof problem?.code === "string" ? problem.code : "REPOSITORY_INSPECTION_FAILED";
  return { code, message: safeProblemMessage(code) };
}

function safeEvidenceUri(reference) {
  if (typeof reference.uri === "string" && /^(?:https|urn):/iu.test(reference.uri)) return reference.uri;
  if (typeof reference.digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(reference.digest)) {
    return `urn:proofwake:evidence:${reference.digest}`;
  }
  return "urn:proofwake:evidence:content-excluded";
}

function safeEvidence(reference) {
  if (!isObject(reference)) return copy(reference);
  const result = {};
  for (const [key, value] of Object.entries(reference)) {
    if (OMITTED_KEYS.has(key)) continue;
    if (key === "uri") {
      result.uri = safeEvidenceUri(reference);
      continue;
    }
    result[key] = copy(value);
  }
  return result;
}

function safePolicy(policy) {
  if (!isObject(policy)) return copy(policy);
  const result = {};
  for (const [key, value] of Object.entries(policy)) {
    if (key === "adapters" && Array.isArray(value)) {
      result.adapters = value.map((adapter) => {
        if (!isObject(adapter)) return copy(adapter);
        const disclosed = {};
        for (const [adapterKey, adapterValue] of Object.entries(adapter)) {
          if (adapterKey === "path" || OMITTED_KEYS.has(adapterKey)) continue;
          disclosed[adapterKey] = copy(adapterValue);
        }
        return disclosed;
      });
      continue;
    }
    if (OMITTED_KEYS.has(key)) continue;
    result[key] = copy(value);
  }
  return result;
}

function copy(value) {
  if (Array.isArray(value)) return value.map(copy);
  if (!isObject(value)) return value;

  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    if (OMITTED_KEYS.has(key)) continue;
    if (key === "policy") {
      result[key] = safePolicy(nested);
      continue;
    }
    if (key === "problems" && Array.isArray(nested)) {
      result[key] = nested.map(safeProblem);
      continue;
    }
    if (key === "panelError" && nested !== null) {
      result[key] = safeProblem(nested);
      continue;
    }
    if (key === "evidence" && Array.isArray(nested)) {
      result[key] = nested.map(safeEvidence);
      continue;
    }
    result[key] = copy(nested);
  }
  return result;
}

function alignAttention(report) {
  if (isObject(report.configuration) && Array.isArray(report.configuration.problems) &&
      report.configuration.problems.length > 0 && report.attention?.type === "configuration") {
    report.attention.reason = report.configuration.problems[0].message;
  }
  if (Array.isArray(report.repositories)) {
    for (const repository of report.repositories) {
      if (repository.attention?.type === "configuration") {
        repository.attention.reason = "Repository configuration is invalid.";
      }
      if (repository.panelError && repository.attention?.type === "projection-error") {
        repository.attention.reason = repository.panelError.message;
      }
    }
  }
  return report;
}

/**
 * Applies the MCP disclosure boundary to an already-built Proofwake projection.
 * Projection selection, status, evidence, trust, coverage, attempts, recovery,
 * and cursors remain unchanged; local and content-derived configuration detail
 * stays outside the MCP response.
 */
export function discloseProofwakeProjection(projection) {
  return alignAttention(copy(projection));
}
