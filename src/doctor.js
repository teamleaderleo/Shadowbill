import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { buildDailyReport, dateInTimeZone, DEFAULT_WORKING_PROFILE } from "./estimate.js";
import { loadPricingCatalog } from "./pricing.js";

const DEFAULT_STALE_LOCK_MS = 300_000;
const PRICING_FIELDS = [
  "inputPerMillion",
  "cachedInputPerMillion",
  "cacheWritePerMillion",
  "outputPerMillion",
  "longContextThresholdTokens",
  "longContextInputMultiplier",
  "longContextOutputMultiplier",
];

function isCode(error, code) {
  return error && typeof error === "object" && "code" in error && error.code === code;
}

function diagnostic(id, status, message, details = {}) {
  return { id, status, message, details };
}

function modeDetails(metadata, platform) {
  if (!metadata || platform === "win32") return { permissionCheck: "unsupported" };
  const mode = metadata.mode & 0o777;
  return {
    permissionCheck: "supported",
    mode: `0${mode.toString(8).padStart(3, "0")}`,
    ownerOnly: (mode & 0o077) === 0,
  };
}

async function metadata(path) {
  try {
    return { exists: true, value: await stat(path) };
  } catch (error) {
    if (isCode(error, "ENOENT")) return { exists: false, value: null };
    throw error;
  }
}

function parseJsonl(raw, timestampField) {
  const records = [];
  let latestTimestamp = null;
  const lines = raw.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const source = lines[index].endsWith("\r") ? lines[index].slice(0, -1) : lines[index];
    if (source.length === 0) continue;
    let record;
    try {
      record = JSON.parse(source);
    } catch (error) {
      return {
        readable: false,
        records,
        latestTimestamp,
        errorLine: index + 1,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    records.push(record);
    const timestamp = record && typeof record === "object" ? record[timestampField] : undefined;
    if (typeof timestamp === "string" && !Number.isNaN(Date.parse(timestamp))) {
      const normalized = new Date(timestamp).toISOString();
      if (latestTimestamp === null || normalized > latestTimestamp) latestTimestamp = normalized;
    }
  }

  return { readable: true, records, latestTimestamp, errorLine: null, error: null };
}

async function inspectJsonl(path, timestampField) {
  const file = await metadata(path);
  if (!file.exists) {
    return {
      exists: false,
      sizeBytes: 0,
      modifiedAt: null,
      readable: true,
      records: [],
      latestTimestamp: null,
      errorLine: null,
      error: null,
      metadata: null,
    };
  }

  const raw = await readFile(path, "utf8");
  return {
    exists: true,
    sizeBytes: file.value.size,
    modifiedAt: file.value.mtime.toISOString(),
    metadata: file.value,
    ...parseJsonl(raw, timestampField),
  };
}

function permissionDiagnostic(id, label, path, fileMetadata, platform) {
  if (!fileMetadata) return null;
  const details = { path, ...modeDetails(fileMetadata, platform) };
  if (details.permissionCheck === "unsupported") {
    return diagnostic(id, "pass", `${label} permission checks are unavailable on this platform.`, details);
  }
  if (!details.ownerOnly) {
    return diagnostic(id, "error", `${label} permissions are broader than owner-only.`, details);
  }
  return diagnostic(id, "pass", `${label} permissions are owner-only.`, details);
}

function validatePricingModel(pricing) {
  if (!pricing || typeof pricing !== "object") return "model pricing must be an object";
  for (const field of PRICING_FIELDS) {
    const value = pricing[field];
    if (!Number.isFinite(value) || value <= 0) return `${field} must be a positive finite number`;
  }
  if (!Number.isSafeInteger(pricing.longContextThresholdTokens)) {
    return "longContextThresholdTokens must be a positive safe integer";
  }
  return null;
}

function validTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds a fully read-only diagnostic report.
 * @param {{
 *   dataPath: string,
 *   tokenPath: string,
 *   tokenFromEnvironment?: boolean,
 *   pricingPath?: string,
 *   model: string,
 *   timeZone: string,
 *   now?: Date,
 *   platform?: NodeJS.Platform,
 *   staleLockMs?: number,
 * }} options
 */
export async function buildDoctorReport(options) {
  const now = options.now ?? new Date();
  const platform = options.platform ?? process.platform;
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const lockPath = `${options.dataPath}.lock`;
  const lockOwnerPath = join(lockPath, "owner.json");
  const recoveryPath = `${options.dataPath}.recovery.jsonl`;
  const checks = [];

  let ledger;
  try {
    ledger = await inspectJsonl(options.dataPath, "timestamp");
    if (!ledger.exists) {
      checks.push(diagnostic("ledger", "warn", "Ledger does not exist yet.", {
        path: options.dataPath,
        sizeBytes: 0,
        eventCount: 0,
        lastEventAt: null,
      }));
    } else if (!ledger.readable) {
      checks.push(diagnostic("ledger", "error", `Ledger contains invalid JSONL at line ${ledger.errorLine}.`, {
        path: options.dataPath,
        sizeBytes: ledger.sizeBytes,
        eventCountBeforeError: ledger.records.length,
        errorLine: ledger.errorLine,
      }));
    } else if (ledger.records.length === 0) {
      checks.push(diagnostic("ledger", "warn", "Ledger is readable but empty.", {
        path: options.dataPath,
        sizeBytes: ledger.sizeBytes,
        eventCount: 0,
        lastEventAt: null,
      }));
    } else {
      checks.push(diagnostic("ledger", "pass", "Ledger is readable.", {
        path: options.dataPath,
        sizeBytes: ledger.sizeBytes,
        eventCount: ledger.records.length,
        lastEventAt: ledger.latestTimestamp,
        modifiedAt: ledger.modifiedAt,
      }));
    }
    const permission = permissionDiagnostic("ledger-permissions", "Ledger", options.dataPath, ledger.metadata, platform);
    if (permission) checks.push(permission);
  } catch (error) {
    ledger = { exists: false, readable: false, records: [] };
    checks.push(diagnostic("ledger", "error", "Ledger could not be inspected.", {
      path: options.dataPath,
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  try {
    const lock = await metadata(lockPath);
    if (!lock.exists) {
      checks.push(diagnostic("ledger-lock", "pass", "No ledger lock is present.", { path: lockPath }));
    } else {
      const ageMs = Math.max(0, now.getTime() - lock.value.mtimeMs);
      let ownerAcquiredAt = null;
      let ownerMetadata = null;
      try {
        ownerMetadata = await metadata(lockOwnerPath);
        if (ownerMetadata.exists) {
          const owner = JSON.parse(await readFile(lockOwnerPath, "utf8"));
          if (owner && typeof owner.acquiredAt === "string" && !Number.isNaN(Date.parse(owner.acquiredAt))) {
            ownerAcquiredAt = new Date(owner.acquiredAt).toISOString();
          }
        }
      } catch {
        ownerMetadata = ownerMetadata ?? { exists: false, value: null };
      }
      checks.push(diagnostic("ledger-lock", "warn", ageMs > staleLockMs
        ? "A stale-looking ledger lock is present."
        : "An active ledger lock is present.", {
        path: lockPath,
        ageMs,
        staleThresholdMs: staleLockMs,
        ownerMetadataPresent: Boolean(ownerMetadata?.exists),
        ownerAcquiredAt,
      }));
      const ownerPermission = permissionDiagnostic(
        "lock-owner-permissions",
        "Lock owner metadata",
        lockOwnerPath,
        ownerMetadata?.value,
        platform,
      );
      if (ownerPermission) checks.push(ownerPermission);
    }
  } catch (error) {
    checks.push(diagnostic("ledger-lock", "error", "Ledger lock state could not be inspected.", {
      path: lockPath,
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  try {
    const recovery = await inspectJsonl(recoveryPath, "recoveredAt");
    if (!recovery.exists) {
      checks.push(diagnostic("recovery", "pass", "No recovery sidecar is present.", { path: recoveryPath }));
    } else if (!recovery.readable) {
      checks.push(diagnostic("recovery", "error", `Recovery sidecar contains invalid JSONL at line ${recovery.errorLine}.`, {
        path: recoveryPath,
        sizeBytes: recovery.sizeBytes,
        recordCountBeforeError: recovery.records.length,
        errorLine: recovery.errorLine,
      }));
    } else {
      checks.push(diagnostic("recovery", "warn", "A recovery sidecar is present.", {
        path: recoveryPath,
        sizeBytes: recovery.sizeBytes,
        recordCount: recovery.records.length,
        latestRecoveryAt: recovery.latestTimestamp,
        modifiedAt: recovery.modifiedAt,
      }));
    }
    const permission = permissionDiagnostic("recovery-permissions", "Recovery sidecar", recoveryPath, recovery.metadata, platform);
    if (permission) checks.push(permission);
  } catch (error) {
    checks.push(diagnostic("recovery", "error", "Recovery sidecar could not be inspected.", {
      path: recoveryPath,
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  if (options.tokenFromEnvironment) {
    checks.push(diagnostic("collector-token", "pass", "Collector token is supplied by the environment.", {
      source: "environment",
    }));
  } else {
    try {
      const token = await metadata(options.tokenPath);
      if (!token.exists) {
        checks.push(diagnostic("collector-token", "warn", "Collector token file does not exist yet.", {
          path: options.tokenPath,
          source: "file",
        }));
      } else {
        checks.push(diagnostic("collector-token", "pass", "Collector token file exists.", {
          path: options.tokenPath,
          source: "file",
          sizeBytes: token.value.size,
          modifiedAt: token.value.mtime.toISOString(),
        }));
        const permission = permissionDiagnostic("collector-token-permissions", "Collector token", options.tokenPath, token.value, platform);
        if (permission) checks.push(permission);
      }
    } catch (error) {
      checks.push(diagnostic("collector-token", "error", "Collector token file could not be inspected.", {
        path: options.tokenPath,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  let catalog = null;
  let pricing = null;
  try {
    catalog = await loadPricingCatalog(options.pricingPath);
    if (typeof catalog.version !== "string" || catalog.version.length === 0 ||
        !catalog.models || typeof catalog.models !== "object" || Object.keys(catalog.models).length === 0) {
      throw new Error("pricing catalog is missing version or models");
    }
    pricing = catalog.models[options.model];
    if (!pricing) {
      checks.push(diagnostic("pricing", "error", `Selected model is absent from the pricing catalog: ${options.model}.`, {
        pricingPath: options.pricingPath ?? "bundled",
        catalogVersion: catalog.version,
        model: options.model,
      }));
    } else {
      const pricingError = validatePricingModel(pricing);
      if (pricingError) throw new Error(pricingError);
      checks.push(diagnostic("pricing", "pass", "Pricing catalog and selected model are valid.", {
        pricingPath: options.pricingPath ?? "bundled",
        catalogVersion: catalog.version,
        model: options.model,
      }));
    }
  } catch (error) {
    checks.push(diagnostic("pricing", "error", "Pricing catalog could not be validated.", {
      pricingPath: options.pricingPath ?? "bundled",
      model: options.model,
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  const timeZoneIsValid = validTimeZone(options.timeZone);
  checks.push(timeZoneIsValid
    ? diagnostic("timezone", "pass", "Report timezone is valid.", { timeZone: options.timeZone })
    : diagnostic("timezone", "error", "Report timezone is invalid.", { timeZone: options.timeZone }));

  if (ledger.readable && pricing && timeZoneIsValid) {
    try {
      const date = dateInTimeZone(now.toISOString(), options.timeZone);
      const report = buildDailyReport(ledger.records, date, pricing, DEFAULT_WORKING_PROFILE, options.timeZone);
      checks.push(diagnostic("report", "pass", "A one-day report can be built.", {
        date,
        chatTurns: report.chatTurns,
        commits: report.commits,
        workingEstimate: report.workingEstimate,
      }));
    } catch (error) {
      checks.push(diagnostic("report", "error", "A one-day report could not be built.", {
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  } else {
    checks.push(diagnostic("report", "error", "A one-day report cannot be tested until ledger, pricing, and timezone checks pass."));
  }

  const summary = checks.reduce((result, check) => {
    result[check.status] += 1;
    return result;
  }, { pass: 0, warn: 0, error: 0 });
  const status = summary.error > 0 ? "error" : summary.warn > 0 ? "warning" : "healthy";

  return {
    service: "shadowbill",
    command: "doctor",
    checkedAt: now.toISOString(),
    status,
    summary,
    configuration: {
      dataPath: options.dataPath,
      tokenPath: options.tokenFromEnvironment ? null : options.tokenPath,
      tokenSource: options.tokenFromEnvironment ? "environment" : "file",
      pricingPath: options.pricingPath ?? "bundled",
      model: options.model,
      timeZone: options.timeZone,
    },
    checks,
  };
}

export function doctorExitCode(report) {
  return report.summary.error > 0 ? 1 : 0;
}

export function formatDoctorReport(report) {
  const lines = [
    `Shadowbill doctor — ${report.status}`,
    `Checks: ${report.summary.pass} pass, ${report.summary.warn} warning, ${report.summary.error} error`,
    "",
  ];
  for (const check of report.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.message}`);
  }
  return lines.join("\n");
}
