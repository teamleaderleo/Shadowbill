import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  buildDoctorReport as buildEstimateDoctorReport,
  doctorExitCode as estimateDoctorExitCode,
} from "./doctor.js";
import { buildFleetDoctorReport } from "./fleet-doctor.js";

function findingCode(id) {
  return `SHADOWBILL_${String(id).toUpperCase().replaceAll("-", "_")}`;
}

function normalizeEstimateCheck(check) {
  return {
    ...check,
    code: check.code ?? findingCode(check.id),
    component: check.component ?? "shadowbill-estimates",
  };
}

function summaryFromChecks(checks) {
  return checks.reduce((summary, check) => {
    summary[check.status] += 1;
    return summary;
  }, { pass: 0, warn: 0, error: 0 });
}

function statusFromSummary(summary) {
  if (summary.error > 0) return "error";
  if (summary.warn > 0) return "warning";
  return "healthy";
}

async function readEventSnapshot(path) {
  try {
    const raw = await readFile(path, "utf8");
    const events = [];
    for (const line of raw.split("\n")) {
      const source = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (source.length === 0) continue;
      events.push(JSON.parse(source));
    }
    return events;
  } catch {
    return [];
  }
}

/**
 * Composes the existing Shadowbill estimate diagnostics with Proofwake fleet
 * readiness checks without changing either ledger or repository state.
 */
export async function buildProofwakeDoctorReport(options) {
  const now = options.now ?? new Date();
  const registryPath = resolve(options.registryPath ?? join(dirname(options.dataPath), "repositories.json"));
  const estimate = await buildEstimateDoctorReport({ ...options, now });
  const fleet = await buildFleetDoctorReport({
    registryPath,
    events: await readEventSnapshot(options.dataPath),
    now,
    platform: options.platform,
  });
  const estimateChecks = estimate.checks.map(normalizeEstimateCheck);
  const checks = [...estimateChecks, ...fleet.checks];
  const summary = summaryFromChecks(checks);

  return {
    service: "proofwake",
    legacyAlias: "shadowbill",
    command: "doctor",
    checkedAt: now.toISOString(),
    status: statusFromSummary(summary),
    summary,
    configuration: {
      ...estimate.configuration,
      registryPath,
    },
    modules: {
      "shadowbill-estimates": {
        status: estimate.status,
        summary: estimate.summary,
      },
      "fleet-readiness": {
        status: fleet.status,
        summary: fleet.summary,
        registry: fleet.registry,
        repositories: fleet.repositories,
      },
    },
    checks,
  };
}

export function proofwakeDoctorExitCode(report) {
  return report.summary.error > 0 ? 1 : 0;
}

export function formatProofwakeDoctorReport(report) {
  const lines = [
    `Proofwake doctor — ${report.status}`,
    `Checks: ${report.summary.pass} pass, ${report.summary.warn} warning, ${report.summary.error} error`,
    "",
  ];
  for (const check of report.checks) {
    lines.push(`[${check.status.toUpperCase()}] [${check.component}] ${check.message}`);
  }
  return lines.join("\n");
}

export { estimateDoctorExitCode };
