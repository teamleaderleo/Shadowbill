#!/usr/bin/env node
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDailyReport, DEFAULT_WORKING_PROFILE } from "./estimate.js";
import { collectHeadCommit, installPostCommitHook } from "./git.js";
import { loadPricingCatalog } from "./pricing.js";
import { createCollectorServer, listen } from "./server.js";
import { JsonlEventStore } from "./store.js";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function localToday() {
  const now = new Date();
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
}

function money(value) {
  return value === null ? "—" : `$${value.toFixed(4)}`;
}

function printReport(report) {
  console.log(`Shadowbill — ${report.date}`);
  console.log("");
  console.log(`Chat turns                 ${report.chatTurns}`);
  console.log(`Conversations              ${report.conversations}`);
  console.log(`Visible input tokens       ${report.visibleInputTokens.toLocaleString()}`);
  console.log(`Visible output tokens      ${report.visibleOutputTokens.toLocaleString()}`);
  console.log(`Commits                    ${report.commits}`);
  console.log(`Repositories               ${report.repositories}`);
  console.log(`Added code tokens          ${report.addedCodeTokens.toLocaleString()}`);
  console.log("");
  console.log(`Delivered-code floor       ${money(report.deliveredCodeFloor)}`);
  console.log(`Visible cached floor       ${money(report.visibleCachedFloor)}`);
  console.log(`Visible uncached estimate  ${money(report.visibleUncachedEstimate)}`);
  console.log(`Working estimate           ${money(report.workingEstimate)}`);
  console.log(`Working cost / commit      ${money(report.costPerCommit)}`);
}

async function main() {
  const command = process.argv[2] ?? "help";
  const dataPath = resolve(argument("--data") ?? process.env.SHADOWBILL_DATA ?? `${homedir()}/.shadowbill/events.jsonl`);
  const store = new JsonlEventStore(dataPath);
  const catalog = await loadPricingCatalog(argument("--pricing"));
  const model = argument("--model") ?? "gpt-5.6-sol";
  const pricing = catalog.models[model];
  if (!pricing) throw new Error(`Unknown model in pricing catalog: ${model}`);

  if (command === "serve") {
    const port = Number.parseInt(argument("--port") ?? "7337", 10);
    const server = createCollectorServer({ store, pricing, profile: DEFAULT_WORKING_PROFILE });
    const actualPort = await listen(server, port);
    console.log(`Shadowbill collector listening at http://127.0.0.1:${actualPort}`);
    console.log(`Event log: ${dataPath}`);
    return;
  }

  if (command === "report") {
    const report = buildDailyReport(await store.readAll(), argument("--date") ?? localToday(), pricing);
    if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
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

  console.log(`Shadowbill\n\nCommands:\n  serve [--port 7337]\n  report [--date YYYY-MM-DD] [--json]\n  ingest-git [--repo PATH]\n  hook install [PATH]\n\nOptions:\n  --data PATH\n  --model gpt-5.6-sol\n  --pricing PATH`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
