import { lstat } from "node:fs/promises";
import { buildRepositoryInventory } from "./repository-inventory.js";
import { RepositoryRegistryStore } from "./repository-registry.js";

function isCode(error, code) {
  return error && typeof error === "object" && "code" in error && error.code === code;
}

function check(id, code, component, status, message, details = {}) {
  return { id, code, component, status, message, details };
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

function statusFromChecks(checks) {
  if (checks.some((entry) => entry.status === "error")) return "error";
  if (checks.some((entry) => entry.status === "warn")) return "warning";
  return "healthy";
}

function summaryFromChecks(checks) {
  return checks.reduce((summary, entry) => {
    summary[entry.status] += 1;
    return summary;
  }, { pass: 0, warn: 0, error: 0 });
}

function publicRegistryMessage(code) {
  if (code === "REPOSITORY_REGISTRY_SYMLINK") return "Repository registry is a symbolic link.";
  if (code === "REPOSITORY_REGISTRY_NOT_FILE") return "Repository registry is not a regular file.";
  if (code === "REPOSITORY_REGISTRY_TOO_LARGE") return "Repository registry exceeds its size limit.";
  if (code === "REPOSITORY_REGISTRY_INVALID_UTF8") return "Repository registry is not valid UTF-8.";
  if (code === "REPOSITORY_REGISTRY_INVALID" || code === "REPOSITORY_REGISTRY_UNKNOWN_FIELD" ||
      code === "REPOSITORY_REGISTRY_IDENTITY_MISMATCH" || code === "REPOSITORY_REGISTRY_FINGERPRINT_MISMATCH" ||
      code === "REPOSITORY_REGISTRY_DUPLICATE") {
    return "Repository registry does not satisfy version 1.";
  }
  if (code === "REPOSITORY_REGISTRY_CHANGED") return "Repository registry changed during inspection.";
  return "Repository registry could not be inspected.";
}

function adapterSummary(readiness) {
  return Object.entries(readiness ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({
      name,
      schema: value.schema,
      trust: value.trust,
      state: value.state,
      code: value.code ?? null,
      ...(Number.isSafeInteger(value.sizeBytes) ? { sizeBytes: value.sizeBytes } : {}),
    }));
}

function repositoryStatus(repository, adapters) {
  if ((repository.problems ?? []).length > 0) return "error";
  if (adapters.some((adapter) => adapter.state === "unsafe")) return "error";
  if (repository.policyChanged || adapters.some((adapter) => adapter.state !== "ready")) return "warn";
  return "pass";
}

function repositoryCode(repository, adapters, status) {
  if ((repository.problems ?? []).length > 0) return repository.problems[0].code ?? "REPOSITORY_READINESS_FAILED";
  const unsafe = adapters.find((adapter) => adapter.state === "unsafe");
  if (unsafe) return unsafe.code ?? "REPOSITORY_ADAPTER_UNSAFE";
  if (repository.policyChanged) return "REPOSITORY_POLICY_CHANGED";
  const unavailable = adapters.find((adapter) => adapter.state !== "ready");
  if (unavailable) return unavailable.code ?? "REPOSITORY_ADAPTER_NOT_READY";
  return status === "pass" ? "REPOSITORY_READY" : "REPOSITORY_READINESS_DEGRADED";
}

function repositoryMessage(repository, adapters, status) {
  if ((repository.problems ?? []).length > 0) return "Repository configuration is not ready for fleet projections.";
  if (adapters.some((adapter) => adapter.state === "unsafe")) return "Repository contains an unsafe adapter receipt path.";
  if (repository.policyChanged) return "Repository policy changed since enrolment.";
  if (adapters.some((adapter) => adapter.state !== "ready")) return "One or more repository adapters are not ready.";
  return status === "pass" ? "Repository and declared adapters are ready." : "Repository readiness is degraded.";
}

async function inspectRepository(entry, events, now) {
  try {
    const report = await buildRepositoryInventory({
      registryStore: { read: async () => ({ version: 1, entries: [entry] }) },
      eventStore: { readAll: async () => events },
      now,
    });
    const repository = report.repositories[0];
    const adapters = adapterSummary(repository.adapterReadiness);
    const status = repositoryStatus(repository, adapters);
    const code = repositoryCode(repository, adapters, status);
    return {
      check: check(
        `repository:${repository.repository.identity}`,
        code,
        "repository",
        status,
        repositoryMessage(repository, adapters, status),
        {
          repository: repository.repository.identity,
          label: repository.repository.label,
          classification: repository.classification,
          policySource: repository.policySource,
          policyChanged: Boolean(repository.policyChanged),
          globalPolicyShadowed: Boolean(repository.globalPolicyShadowed),
          problems: (repository.problems ?? []).map((problem) => ({
            code: problem.code,
            ...(typeof problem.path === "string" ? { path: problem.path } : {}),
          })),
          adapters,
        },
      ),
      repository: {
        identity: repository.repository.identity,
        label: repository.repository.label,
        status,
        code,
        classification: repository.classification,
        policySource: repository.policySource,
        policyChanged: Boolean(repository.policyChanged),
        globalPolicyShadowed: Boolean(repository.globalPolicyShadowed),
        problems: (repository.problems ?? []).map((problem) => ({
          code: problem.code,
          ...(typeof problem.path === "string" ? { path: problem.path } : {}),
        })),
        adapters,
      },
    };
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "REPOSITORY_INSPECTION_FAILED";
    return {
      check: check(
        `repository:${entry.repository.identity}`,
        code,
        "repository",
        "error",
        "Repository readiness could not be inspected.",
        { repository: entry.repository.identity, label: entry.repository.label },
      ),
      repository: {
        identity: entry.repository.identity,
        label: entry.repository.label,
        status: "error",
        code,
        classification: "misconfigured",
        policySource: entry.configuration?.source ?? null,
        policyChanged: false,
        globalPolicyShadowed: false,
        problems: [{ code }],
        adapters: [],
      },
    };
  }
}

/**
 * Builds read-only repository-registry and adapter readiness diagnostics.
 * The caller supplies an already-read event snapshot so doctor never invokes
 * the durable event store's recovery path.
 * @param {{registryPath: string, events?: object[], now?: Date, platform?: NodeJS.Platform}} options
 */
export async function buildFleetDoctorReport(options) {
  const now = options.now ?? new Date();
  const platform = options.platform ?? process.platform;
  const events = Array.isArray(options.events) ? options.events : [];
  const checks = [];
  const repositories = [];
  const registryStore = new RepositoryRegistryStore(options.registryPath);
  let registry = null;
  let registryMetadata = null;

  try {
    registryMetadata = await lstat(options.registryPath);
  } catch (error) {
    if (!isCode(error, "ENOENT")) {
      checks.push(check(
        "repository-registry",
        "REPOSITORY_REGISTRY_UNAVAILABLE",
        "registry",
        "error",
        "Repository registry could not be inspected.",
      ));
    }
  }

  if (registryMetadata?.isSymbolicLink()) {
    checks.push(check(
      "repository-registry",
      "REPOSITORY_REGISTRY_SYMLINK",
      "registry",
      "error",
      "Repository registry is a symbolic link.",
    ));
  } else if (registryMetadata && !registryMetadata.isFile()) {
    checks.push(check(
      "repository-registry",
      "REPOSITORY_REGISTRY_NOT_FILE",
      "registry",
      "error",
      "Repository registry is not a regular file.",
    ));
  } else if (checks.length === 0) {
    try {
      registry = await registryStore.read();
      if (!registryMetadata) {
        checks.push(check(
          "repository-registry",
          "REPOSITORY_REGISTRY_MISSING",
          "registry",
          "warn",
          "Repository registry does not exist yet.",
          { exists: false, version: registry.version, entryCount: 0 },
        ));
      } else {
        checks.push(check(
          "repository-registry",
          registry.entries.length === 0 ? "REPOSITORY_REGISTRY_EMPTY" : "REPOSITORY_REGISTRY_READY",
          "registry",
          registry.entries.length === 0 ? "warn" : "pass",
          registry.entries.length === 0 ? "Repository registry is readable but empty." : "Repository registry is readable.",
          {
            exists: true,
            version: registry.version,
            entryCount: registry.entries.length,
            sizeBytes: registryMetadata.size,
            modifiedAt: registryMetadata.mtime.toISOString(),
          },
        ));
        const permissions = modeDetails(registryMetadata, platform);
        checks.push(check(
          "repository-registry-permissions",
          permissions.permissionCheck === "unsupported"
            ? "REPOSITORY_REGISTRY_PERMISSION_CHECK_UNSUPPORTED"
            : permissions.ownerOnly
              ? "REPOSITORY_REGISTRY_PERMISSIONS_READY"
              : "REPOSITORY_REGISTRY_PERMISSIONS_INSECURE",
          "registry",
          permissions.permissionCheck === "unsupported" || permissions.ownerOnly ? "pass" : "error",
          permissions.permissionCheck === "unsupported"
            ? "Repository registry permission checks are unavailable on this platform."
            : permissions.ownerOnly
              ? "Repository registry permissions are owner-only."
              : "Repository registry permissions are broader than owner-only.",
          permissions,
        ));
      }
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "REPOSITORY_REGISTRY_UNAVAILABLE";
      checks.push(check(
        "repository-registry",
        code,
        "registry",
        "error",
        publicRegistryMessage(code),
      ));
    }
  }

  if (registry) {
    for (const entry of registry.entries) {
      const result = await inspectRepository(entry, events, now);
      checks.push(result.check);
      repositories.push(result.repository);
    }
  }

  const registryChecks = checks.filter((entry) => entry.component === "registry");
  const repositoryChecks = checks.filter((entry) => entry.component === "repository");
  const registryUnavailable = registry === null || registryChecks.some((entry) => entry.status === "error");
  const fleetStatus = registryUnavailable
    ? "error"
    : registry.entries.length === 0
      ? "warn"
      : repositoryChecks.some((entry) => entry.status === "error")
        ? "error"
        : repositoryChecks.some((entry) => entry.status === "warn")
          ? "warn"
          : "pass";
  checks.push(check(
    "fleet-readiness",
    fleetStatus === "pass" ? "FLEET_READY" : fleetStatus === "warn" ? "FLEET_READINESS_DEGRADED" : "FLEET_UNAVAILABLE",
    "fleet",
    fleetStatus,
    fleetStatus === "pass"
      ? "Fleet projections and declared adapters are ready."
      : fleetStatus === "warn"
        ? "Fleet readiness is degraded but usable."
        : "Fleet projections are unavailable for one or more repositories.",
    {
      repositoryCount: repositories.length,
      ready: repositories.filter((repository) => repository.status === "pass").length,
      warning: repositories.filter((repository) => repository.status === "warn").length,
      error: repositories.filter((repository) => repository.status === "error").length,
    },
  ));

  return {
    service: "proofwake",
    module: "fleet-readiness",
    checkedAt: now.toISOString(),
    status: statusFromChecks(checks),
    summary: summaryFromChecks(checks),
    registry: {
      path: options.registryPath,
      exists: Boolean(registryMetadata),
      version: registry?.version ?? null,
      entryCount: registry?.entries.length ?? null,
      ...(registryMetadata?.isFile() ? {
        sizeBytes: registryMetadata.size,
        modifiedAt: registryMetadata.mtime.toISOString(),
      } : {}),
    },
    repositories,
    checks,
  };
}
