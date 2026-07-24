import { buildDailyReport, dateInTimeZone, DEFAULT_WORKING_PROFILE, resolveChatTurnRevisions } from "./estimate.js";

function parseCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("date must use YYYY-MM-DD format");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("date must be a real calendar date");
  }
  return parsed;
}

export function shiftCalendarDate(date, amount) {
  if (!Number.isSafeInteger(amount)) throw new Error("calendar-day shift must be an integer");
  const parsed = parseCalendarDate(date);
  parsed.setUTCDate(parsed.getUTCDate() + amount);
  return parsed.toISOString().slice(0, 10);
}

export function calendarDateRange(endDate, days) {
  parseCalendarDate(endDate);
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
    throw new Error("days must be an integer between 1 and 365");
  }
  const startDate = shiftCalendarDate(endDate, 1 - days);
  return Array.from({ length: days }, (_, index) => shiftCalendarDate(startDate, index));
}

function sum(reports, field) {
  return reports.reduce((total, report) => total + report[field], 0);
}

function perOutcome(cost, count) {
  return count === 0 ? null : cost / count;
}

function peakDay(reports, field) {
  let peak = null;
  for (const report of reports) {
    if (peak === null || report[field] > peak.value) peak = { date: report.date, value: report[field] };
  }
  return peak?.value > 0 ? peak : null;
}

function active(report) {
  return report.chatTurns > 0 || report.commits > 0 || report.pushes > 0 ||
    report.pullRequestEvents > 0 || report.workflowRunEvents > 0 || report.deploymentStatusEvents > 0;
}

/**
 * @param {import('./types.js').ShadowbillEvent[]} events
 * @param {string} endDate
 * @param {number} days
 * @param {import('./types.js').ModelPricing} pricing
 * @param {import('./types.js').EstimationProfile} [workingProfile]
 * @param {string} [timeZone]
 */
export function buildRangeReport(
  events,
  endDate,
  days,
  pricing,
  workingProfile = DEFAULT_WORKING_PROFILE,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
) {
  const dates = calendarDateRange(endDate, days);
  const dateSet = new Set(dates);
  const daily = dates.map((date) => buildDailyReport(events, date, pricing, workingProfile, timeZone));
  const activeDays = daily.filter(active).length;
  const inRange = (event) => dateSet.has(dateInTimeZone(event.timestamp, timeZone));
  const rangeEvents = events.filter((event) => event.type !== "chat_turn" && inRange(event));
  const rangeTurns = resolveChatTurnRevisions(events)
    .map((record) => record.turn)
    .filter(inRange);
  const uniqueCount = (values) => new Set(values).size;
  const mergedPullRequests = uniqueCount(rangeEvents
    .filter((event) => event.type === "github_pull_request" && event.merged)
    .map((event) => `${event.repository}:${event.number}`));
  const workflowRuns = uniqueCount(rangeEvents
    .filter((event) => event.type === "github_workflow_run")
    .map((event) => `${event.repository}:${event.runId}`));
  const successfulWorkflowRuns = uniqueCount(rangeEvents
    .filter((event) => event.type === "github_workflow_run" && event.conclusion === "success")
    .map((event) => `${event.repository}:${event.runId}`));
  const deployments = uniqueCount(rangeEvents
    .filter((event) => event.type === "github_deployment")
    .map((event) => `${event.repository}:${event.deploymentId}`));
  const successfulDeployments = uniqueCount(rangeEvents
    .filter((event) => event.type === "github_deployment" && event.state === "success")
    .map((event) => `${event.repository}:${event.deploymentId}`));
  const repositories = uniqueCount(rangeEvents
    .filter((event) => "repository" in event && typeof event.repository === "string")
    .map((event) => event.repository));
  const workingEstimate = sum(daily, "workingEstimate");
  const commits = sum(daily, "commits");
  const addedCodeTokens = sum(daily, "addedCodeTokens");

  return {
    startDate: dates[0],
    endDate,
    calendarDays: days,
    activeDays,
    timeZone,
    chatTurns: sum(daily, "chatTurns"),
    chatRevisionEvents: sum(daily, "chatRevisionEvents"),
    supersededChatRevisions: sum(daily, "supersededChatRevisions"),
    conversations: uniqueCount(rangeTurns.map((turn) => turn.conversationHash)),
    visibleInputTokens: sum(daily, "visibleInputTokens"),
    visibleOutputTokens: sum(daily, "visibleOutputTokens"),
    commits,
    pushes: sum(daily, "pushes"),
    pullRequestEvents: sum(daily, "pullRequestEvents"),
    mergedPullRequests,
    workflowRunEvents: sum(daily, "workflowRunEvents"),
    workflowRuns,
    successfulWorkflowRuns,
    deploymentStatusEvents: sum(daily, "deploymentStatusEvents"),
    deployments,
    successfulDeployments,
    repositories,
    additions: sum(daily, "additions"),
    deletions: sum(daily, "deletions"),
    addedCodeTokens,
    deliveredCodeFloor: sum(daily, "deliveredCodeFloor"),
    visibleCachedFloor: sum(daily, "visibleCachedFloor"),
    visibleUncachedEstimate: sum(daily, "visibleUncachedEstimate"),
    workingEstimate,
    averageChatTurnsPerCalendarDay: sum(daily, "chatTurns") / days,
    averageChatTurnsPerActiveDay: activeDays === 0 ? 0 : sum(daily, "chatTurns") / activeDays,
    averageWorkingCostPerCalendarDay: workingEstimate / days,
    averageWorkingCostPerActiveDay: activeDays === 0 ? 0 : workingEstimate / activeDays,
    costPerCommit: perOutcome(workingEstimate, commits),
    costPerMergedPullRequest: perOutcome(workingEstimate, mergedPullRequests),
    costPerSuccessfulWorkflowRun: perOutcome(workingEstimate, successfulWorkflowRuns),
    costPerSuccessfulDeployment: perOutcome(workingEstimate, successfulDeployments),
    costPerAddedCodeToken: addedCodeTokens === 0 ? null : workingEstimate / addedCodeTokens,
    peakChatTurnDay: peakDay(daily, "chatTurns"),
    peakWorkingCostDay: peakDay(daily, "workingEstimate"),
    daily,
  };
}
