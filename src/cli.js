#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadOrCreateCollectorToken } from "./auth.js";
import { buildDoctorReport, doctorExitCode, formatDoctorReport } from "./doctor.js";
import { buildDailyReport, dateInTimeZone, DEFAULT_WORKING_PROFILE } from "./estimate.js";
import { collectHeadCommit, installPostCommitHook } from "./git.js";
import { DEFAULT_ALLOWED_HOSTS } from "./http-security.js";
import {
  ENVIRONMENT_ALIASES,
  LEGACY_NAME,
  PRODUCT_NAME,
  resolveStorageIdentity,
  selectCompatibleEnvironment,
} from "./identity.js";
import { loadPricingCatalog } from "./pricing.js";
import { runProofwakeMcpStdioServer } from "./proofwake-mcp.js";
import { buildRangeReport, calendarDateRange } from "./range.js";
import { buildRepositoryAllocationReport } from "./repositories.js";
import { RepositoryRegistryStore } from "./repository-registry.js";
import { createCollectorServer, listen } from "./server.js";
import { JsonlEventStore } from "./store.js";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function pathArgument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return value;
}

function reportDays(value) {
  if (value === undefined) return 1;
  if (!/^\d+$/.test(value)) throw new Error("--days must be an integer between 1 and 365");
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
    throw new Error("--days must be an integer between 1 and 365");
  }
  return days;
}

function configuredAllowedHosts(value) {
  if (value === undefined) return undefined;
  const hosts = value.split(",").map((host) => host.trim());
  if (hosts.length === 0 || hosts.some((host) => host.length === 0)) {
    throw new Error("--allowed-hosts must contain a comma-separated host list");
  }
  return hosts;
}

function money(value) {
  return value === null ? "—" : `$${value.toFixed(4)}`;
}

function percentage(value) {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function printDailyReport(report) {
  console.log(`${PRODUCT_NAME} — ${LEGACY_NAME} estimates — ${report.date}`);
  console.log("");
  console.log(`Chat turns                 ${report.chatTurns}`);
  console.log(`Chat capture events        ${report.chatRevisionEvents}`);
  console.log(`Superseded captures        ${report.supersededChatRevisions}`);
  console.log(`Conversations              ${report.conversations}`);
  console.log(`Visible input tokens       ${report.visibleInputTokens.toLocaleString()}`);
  console.log(`Visible output tokens      ${report.visibleOutputTokens.toLocaleString()}`);
  console.log(`Commits                    ${report.commits}`);
  console.log(`Pushes                     ${report.pushes}`);
  console.log(`Merged pull requests       ${report.mergedPullRequests}`);
  console.log(`Successful workflow runs   ${report.successfulWorkflowRuns}`);
  console.log(`Successful deployments     ${report.successfulDeployments}`);
  console.log(`Repositories               ${report.repositories}`);
  console.log(`Added code tokens          ${report.addedCodeTokens.toLocaleString()}`);
  console.log("");
  console.log(`Delivered-code floor       ${money(report.deliveredCodeFloor)}`);
  console.log(`Visible cached floor       ${money(report.visibleCachedFloor)}`);
  console.log(`Visible uncached estimate  ${money(report.visibleUncachedEstimate)}`);
  console.log(`Working estimate           ${money(report.workingEstimate)}`);
  console.log(`Working cost / commit      ${money(report.costPerCommit)}`);
  console.log(`Working cost / merged PR   ${money(report.costPerMergedPullRequest)}`);
  console.log(`Working cost / CI success  ${money(report.costPerSuccessfulWorkflowRun)}`);
  console.log(`Working cost / deployment  ${money(report.costPerSuccessfulDeployment)}`);
}

function printRangeReport(report) {
  console.log(`${PRODUCT_NAME} — ${LEGACY_NAME} estimates — ${report.startDate} through ${report.endDate}`);
  console.log("");
  console.log(`Calendar days              ${report.calendarDays}`);
  console.log(`Active days                ${report.activeDays}`);
  console.log(`Chat turns                 ${report.chatTurns}`);
  console.log(`Chat capture events        ${report.chatRevisionEvents}`);
  console.log(`Superseded captures        ${report.supersededChatRevisions}`);
  console.log(`Conversations              ${report.conversations}`);
  console.log(`Visible input tokens       ${report.visibleInputTokens.toLocaleString()}`);
  console.log(`Visible output tokens      ${report.visibleOutputTokens.toLocaleString()}`);
  console.log(`Commits                    ${report.commits}`);
  console.log(`Merged pull requests       ${report.mergedPullRequests}`);
  console.log(`Successful workflow runs   ${report.successfulWorkflowRuns}`);
  console.log(`Successful deployments     ${report.successfulDeployments}`);
  console.log(`Repositories               ${report.repositories}`);
  console.log(`Added code tokens          ${report.addedCodeTokens.toLocaleString()}`);
  console.log("");
  console.log(`Working estimate           ${money(report.workingEstimate)}`);
  console.log(`Average / calendar day     ${money(report.averageWorkingCostPerCalendarDay)}`);
  console.log(`Average / active day       ${money(report.averageWorkingCostPerActiveDay)}`);
  console.log(`Working cost / commit      ${money(report.costPerCommit)}`);
  console.log(`Working cost / merged PR   ${money(report.costPerMergedPullRequest)}`);
  console.log(`Working cost / CI success  ${money(report.costPerSuccessfulWorkflowRun)}`);
  console.log(`Working cost / deployment  ${money(report.costPerSuccessfulDeployment)}`);
  console.log(`Peak chat day              ${report.peakChatTurnDay ? `${report.peakChatTurnDay.date} (${report.peakChatTurnDay.value})` : "—"}`);
  console.log(`Peak cost day              ${report.peakWorkingCostDay ? `${report.peakWorkingCostDay.date} (${money(report.peakWorkingCostDay.value)})` : "—"}`);
}

function printRepositoryReport(report) {
  console.log(`${PRODUCT_NAME} — ${LEGACY_NAME} repository estimates — ${report.startDate} through ${report.endDate}`);
  console.log("");
  console.log(`Allocation basis           ${report.allocationBasis}`);
  console.log(`Working estimate           ${money(report.workingEstimate)}`);
  console.log(`Allocated estimate         ${money(report.allocatedWorkingEstimate)}`);
  console.log(`Unallocated estimate       ${money(report.unallocatedWorkingEstimate)}`);
  console.log(`Allocation coverage        ${percentage(report.allocationCoverage)}`);
  console.log(`Repositories               ${report.repositoryCount}`);

  for (const repository of report.repositories) {
    console.log("");
    console.log(repository.repository);
    console.log(`  Allocated estimate       ${money(repository.allocatedWorkingEstimate)}`);
    console.log(`  Retained code tokens     ${repository.addedCodeTokens.toLocaleString()}`);
    console.log(`  Commits                  ${repository.commits}`);
    console.log(`  Merged pull requests     ${repository.mergedPullRequests}`);
    console.log(`  Successful CI runs       ${repository.successfulWorkflowRuns}`);
    console.log(`  Successful deployments  ${repository.successfulDeployments}`);
    console.log(`  Cost / commit            ${money(repository.costPerCommit)}`);
    console.log(`  Cost / merged PR         ${money(repository.costPerMergedPullRequest)}`);
  }

  console.log("");
  console.log(report.interpretation);
}

function selectEnvironment(key) {
  const [primaryName, legacyName] = ENVIRONMENT_ALIASES[key];
  return selectCompatibleEnvironment(process.env, primaryName, legacyName);
}

function printCompatibilityWarnings(warnings) {
  for (const warning of [...new Set(warnings)]) {
    console.error(`${PRODUCT_NAME} compatibility: ${warning}`);
  }
}

async function main() {
  const command = process.argv[2] ?? "help";
  const storage = await resolveStorageIdentity({
    explicitDataPath: argument("--data"),
    explicitTokenPath: argument("--collector-token-file"),
  });
  const collectorTokenEnvironment = selectEnvironment("collectorToken");
  const timeZoneEnvironment = selectEnvironment("timezone");
  const githubSecretEnvironment = selectEnvironment("githubWebhookSecret");
  const allowedHostsEnvironment = selectEnvironment("allowedHosts");
  const mcpWritesEnvironment = selectEnvironment("mcpAllowWrites");
  const compatibilityWarnings = [
    ...storage.warnings,
    ...collectorTokenEnvironment.warnings,
    ...timeZoneEnvironment.warnings,
    ...githubSecretEnvironment.warnings,
    ...allowedHostsEnvironment.warnings,
    ...mcpWritesEnvironment.warnings,
  ];

  const dataPath = storage.dataPath;
  const tokenPath = storage.tokenPath;
  const pricingPath = argument("--pricing");
  const model = argument("--model") ?? "gpt-5.6-sol";
  const timeZone = argument("--timezone") ?? timeZoneEnvironment.value ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  if (command === "status") {
    const status = {
      service: "proofwake",
      legacyAlias: "shadowbill",
      command: "status",
      compatibilityMode: storage.compatibilityMode,
      configuration: {
        dataPath,
        dataSource: storage.dataSource,
        tokenPath,
        tokenPathSource: storage.tokenSource,
        collectorTokenSource: collectorTokenEnvironment.source,
        timeZone,
        timeZoneSource: argument("--timezone") !== undefined ? "argument" : timeZoneEnvironment.source ?? "system",
        githubWebhookSecretSource: githubSecretEnvironment.source,
        allowedHostsSource: allowedHostsEnvironment.source,
        mcpAllowWritesSource: mcpWritesEnvironment.source,
      },
      defaults: storage.defaults,
      warnings: compatibilityWarnings,
    };
    if (process.argv.includes("--json")) console.log(JSON.stringify(status, null, 2));
    else {
      console.log(`${PRODUCT_NAME} identity`);
      console.log(`Data: ${status.configuration.dataPath} (${status.configuration.dataSource})`);
      console.log(`Collector token file: ${status.configuration.tokenPath} (${status.configuration.tokenPathSource})`);
      console.log(`Compatibility mode: ${status.compatibilityMode ? "Shadowbill paths or variables active" : "no"}`);
      if (status.warnings.length > 0) {
        console.log("");
        for (const warning of status.warnings) console.log(`Warning: ${warning}`);
      }
    }
    return;
  }

  printCompatibilityWarnings(compatibilityWarnings);

  if (command === "doctor") {
    const report = await buildDoctorReport({
      dataPath,
      tokenPath,
      tokenFromEnvironment: collectorTokenEnvironment.value !== undefined,
      pricingPath,
      model,
      timeZone,
    });
    if (process.argv.includes("--json")) console.log(JSON.stringify({
      ...report,
      service: "proofwake",
      module: "shadowbill-estimates",
      compatibility: {
        active: storage.compatibilityMode,
        dataSource: storage.dataSource,
        tokenPathSource: storage.tokenSource,
        warnings: compatibilityWarnings,
      },
    }, null, 2));
    else console.log(formatDoctorReport({ ...report, service: "proofwake" }).replace(/^Shadowbill doctor/, `${PRODUCT_NAME} doctor`));
    process.exitCode = doctorExitCode(report);
    return;
  }

  const store = new JsonlEventStore(dataPath);
  const catalog = await loadPricingCatalog(pricingPath);
  const pricing = catalog.models[model];
  if (!pricing) throw new Error(`Unknown model in pricing catalog: ${model}`);

  if (command === "serve") {
    const port = Number.parseInt(argument("--port") ?? "7337", 10);
    const githubWebhookSecret = argument("--github-secret") ?? githubSecretEnvironment.value;
    const collectorToken = collectorTokenEnvironment.value ?? await loadOrCreateCollectorToken(tokenPath);
    const allowedHosts = configuredAllowedHosts(argument("--allowed-hosts") ?? allowedHostsEnvironment.value);
    if (collectorToken.length < 32) {
      const source = collectorTokenEnvironment.source ?? "collector token file";
      throw new Error(`Collector token from ${source} must contain at least 32 characters`);
    }
    const server = createCollectorServer({
      store,
      pricing,
      profile: DEFAULT_WORKING_PROFILE,
      githubWebhookSecret,
      collectorToken,
      allowedHosts,
      timeZone,
    });
    const actualPort = await listen(server, port);
    console.log(`${PRODUCT_NAME} collector listening at http://127.0.0.1:${actualPort}`);
    console.log(`Event log: ${dataPath}`);
    console.log("Browser event authentication: enabled");
    console.log(collectorTokenEnvironment.value !== undefined
      ? `Collector token source: ${collectorTokenEnvironment.source}`
      : `Collector token file: ${tokenPath}`);
    console.log(`Allowed HTTP hosts: ${(allowedHosts ?? DEFAULT_ALLOWED_HOSTS).join(", ")}`);
    console.log(`GitHub webhooks: ${githubWebhookSecret ? "enabled" : "disabled"}`);
    console.log(`Report timezone: ${timeZone}`);
    return;
  }

  if (command === "mcp") {
    const allowWrites = process.argv.includes("--allow-writes") || mcpWritesEnvironment.value === "1";
    const registryPath = resolve(pathArgument("--registry") ?? join(dirname(dataPath), "repositories.json"));
    const registryStore = new RepositoryRegistryStore(registryPath);
    await runProofwakeMcpStdioServer({
      store,
      registryStore,
      pricing,
      profile: DEFAULT_WORKING_PROFILE,
      timeZone,
      allowWrites,
    });
    return;
  }

  if (command === "report") {
    const events = await store.readAll();
    const endDate = argument("--date") ?? dateInTimeZone(new Date().toISOString(), timeZone);
    const days = reportDays(argument("--days"));
    calendarDateRange(endDate, days);
    const byRepository = process.argv.includes("--by-repository");
    const report = byRepository
      ? buildRepositoryAllocationReport(events, endDate, days, pricing, DEFAULT_WORKING_PROFILE, timeZone)
      : days === 1
        ? buildDailyReport(events, endDate, pricing, DEFAULT_WORKING_PROFILE, timeZone)
        : buildRangeReport(events, endDate, days, pricing, DEFAULT_WORKING_PROFILE, timeZone);
    if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else if (byRepository) printRepositoryReport(report);
    else if (days === 1) printDailyReport(report);
    else printRangeReport(report);
    return;
  }

  if (command === "ingest-git") {
    const event = await collectHeadCommit(argument("--repo") ?? process.cwd());
    await store.append(event);
    console.log(JSON.stringify(event));
    return;
  }

  if (command === "hook" && process.argv[3] === "install") {
    const repo = argument("--repo") ?? process.argv[4] ?? process.cwd();
    const hook = await installPostCommitHook(repo, fileURLToPath(import.meta.url));
    console.log(`Installed ${hook}`);
    return;
  }

  console.log(`${PRODUCT_NAME}\n\nThe evidence trail behind every revision.\n\nCurrent commands:\n  status [--json]\n  serve [--port 7337] [--github-secret SECRET] [--allowed-hosts HOSTS]\n  mcp [--registry PATH] [--allow-writes]\n  report [--date YYYY-MM-DD] [--days 1..365] [--by-repository] [--json]\n  doctor [--json]\n  ingest-git [--repo PATH]\n  hook install [PATH]\n\nOptions:\n  --data PATH\n  --registry PATH\n  --model gpt-5.6-sol\n  --pricing PATH\n  --github-secret SECRET (or PROOFWAKE_GITHUB_WEBHOOK_SECRET)\n  --collector-token-file PATH (or PROOFWAKE_COLLECTOR_TOKEN_FILE)\n  PROOFWAKE_COLLECTOR_TOKEN (direct token override)\n  --allowed-hosts HOST[,HOST...] (or PROOFWAKE_ALLOWED_HOSTS)\n  --timezone IANA_NAME (or PROOFWAKE_TIMEZONE)\n  --allow-writes (or PROOFWAKE_MCP_ALLOW_WRITES=1)\n\nLegacy SHADOWBILL_* variables and the shadowbill binary remain compatibility aliases.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
