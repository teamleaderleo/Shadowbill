import { dateInTimeZone, DEFAULT_WORKING_PROFILE } from "./estimate.js";
import { buildRangeReport, calendarDateRange } from "./range.js";

export const REPOSITORY_ALLOCATION_BASIS = "same-day-added-code-tokens";

function perOutcome(cost, count) {
  return count === 0 ? null : cost / count;
}

function repositoryState(name) {
  return {
    name,
    allocatedWorkingEstimate: 0,
    commits: 0,
    pushes: 0,
    pullRequestEvents: 0,
    workflowRunEvents: 0,
    deploymentStatusEvents: 0,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    addedCodeTokens: 0,
    mergedPullRequestIds: new Set(),
    workflowRunIds: new Set(),
    successfulWorkflowRunIds: new Set(),
    deploymentIds: new Set(),
    successfulDeploymentIds: new Set(),
  };
}

function safeCount(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function finalizeRepository(state, totalWorkingEstimate, totalAllocated) {
  const mergedPullRequests = state.mergedPullRequestIds.size;
  const workflowRuns = state.workflowRunIds.size;
  const successfulWorkflowRuns = state.successfulWorkflowRunIds.size;
  const deployments = state.deploymentIds.size;
  const successfulDeployments = state.successfulDeploymentIds.size;

  return {
    repository: state.name,
    allocatedWorkingEstimate: state.allocatedWorkingEstimate,
    shareOfTotalWorkingEstimate: totalWorkingEstimate === 0 ? null : state.allocatedWorkingEstimate / totalWorkingEstimate,
    shareOfAllocatedWorkingEstimate: totalAllocated === 0 ? null : state.allocatedWorkingEstimate / totalAllocated,
    commits: state.commits,
    pushes: state.pushes,
    pullRequestEvents: state.pullRequestEvents,
    mergedPullRequests,
    workflowRunEvents: state.workflowRunEvents,
    workflowRuns,
    successfulWorkflowRuns,
    deploymentStatusEvents: state.deploymentStatusEvents,
    deployments,
    successfulDeployments,
    additions: state.additions,
    deletions: state.deletions,
    changedFiles: state.changedFiles,
    addedCodeTokens: state.addedCodeTokens,
    costPerCommit: perOutcome(state.allocatedWorkingEstimate, state.commits),
    costPerMergedPullRequest: perOutcome(state.allocatedWorkingEstimate, mergedPullRequests),
    costPerSuccessfulWorkflowRun: perOutcome(state.allocatedWorkingEstimate, successfulWorkflowRuns),
    costPerSuccessfulDeployment: perOutcome(state.allocatedWorkingEstimate, successfulDeployments),
    costPerAddedCodeToken: state.addedCodeTokens === 0 ? null : state.allocatedWorkingEstimate / state.addedCodeTokens,
    addedCodeTokensPerAllocatedDollar: state.allocatedWorkingEstimate === 0
      ? null
      : state.addedCodeTokens / state.allocatedWorkingEstimate,
  };
}

/**
 * Allocates each local calendar day's working estimate in proportion to that
 * day's retained added-code tokens. Days without retained code remain
 * explicitly unallocated.
 *
 * @param {import('./types.js').ShadowbillEvent[]} events
 * @param {string} endDate
 * @param {number} days
 * @param {import('./types.js').ModelPricing} pricing
 * @param {import('./types.js').EstimationProfile} [workingProfile]
 * @param {string} [timeZone]
 */
export function buildRepositoryAllocationReport(
  events,
  endDate,
  days,
  pricing,
  workingProfile = DEFAULT_WORKING_PROFILE,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
) {
  const dates = calendarDateRange(endDate, days);
  const dateSet = new Set(dates);
  const range = buildRangeReport(events, endDate, days, pricing, workingProfile, timeZone);
  const repositories = new Map();
  const retainedTokensByDay = new Map(dates.map((date) => [date, new Map()]));

  const getRepository = (name) => {
    let state = repositories.get(name);
    if (!state) {
      state = repositoryState(name);
      repositories.set(name, state);
    }
    return state;
  };

  for (const event of events) {
    if (!("repository" in event) || typeof event.repository !== "string" || event.repository.length === 0) continue;
    const date = dateInTimeZone(event.timestamp, timeZone);
    if (!dateSet.has(date)) continue;
    const state = getRepository(event.repository);

    if (event.type === "git_commit") {
      const addedCodeTokens = safeCount(event.addedCodeTokens);
      state.commits += 1;
      state.additions += safeCount(event.additions);
      state.deletions += safeCount(event.deletions);
      state.changedFiles += safeCount(event.changedFiles);
      state.addedCodeTokens += addedCodeTokens;
      const dayTokens = retainedTokensByDay.get(date);
      dayTokens.set(event.repository, (dayTokens.get(event.repository) ?? 0) + addedCodeTokens);
      continue;
    }

    if (event.type === "github_push") {
      state.pushes += 1;
      continue;
    }

    if (event.type === "github_pull_request") {
      state.pullRequestEvents += 1;
      if (event.merged) state.mergedPullRequestIds.add(`${event.repository}:${event.number}`);
      continue;
    }

    if (event.type === "github_workflow_run") {
      const key = `${event.repository}:${event.runId}`;
      state.workflowRunEvents += 1;
      state.workflowRunIds.add(key);
      if (event.conclusion === "success") state.successfulWorkflowRunIds.add(key);
      continue;
    }

    if (event.type === "github_deployment") {
      const key = `${event.repository}:${event.deploymentId}`;
      state.deploymentStatusEvents += 1;
      state.deploymentIds.add(key);
      if (event.state === "success") state.successfulDeploymentIds.add(key);
    }
  }

  let allocatedWorkingEstimate = 0;
  let unallocatedWorkingEstimate = 0;
  let allocationDays = 0;
  let unallocatedDays = 0;
  const daily = [];

  for (const day of range.daily) {
    const tokenMap = retainedTokensByDay.get(day.date);
    const entries = Array.from(tokenMap.entries())
      .filter(([, tokens]) => tokens > 0)
      .sort(([left], [right]) => left.localeCompare(right));
    const totalTokens = entries.reduce((total, [, tokens]) => total + tokens, 0);
    const allocations = [];

    if (totalTokens === 0) {
      unallocatedWorkingEstimate += day.workingEstimate;
      if (day.workingEstimate > 0) unallocatedDays += 1;
    } else {
      allocationDays += 1;
      let allocatedForDay = 0;
      entries.forEach(([repository, tokens], index) => {
        const cost = index === entries.length - 1
          ? day.workingEstimate - allocatedForDay
          : day.workingEstimate * (tokens / totalTokens);
        allocatedForDay += cost;
        getRepository(repository).allocatedWorkingEstimate += cost;
        allocations.push({
          repository,
          addedCodeTokens: tokens,
          tokenShare: tokens / totalTokens,
          allocatedWorkingEstimate: cost,
        });
      });
      allocatedWorkingEstimate += day.workingEstimate;
    }

    daily.push({
      date: day.date,
      workingEstimate: day.workingEstimate,
      addedCodeTokens: totalTokens,
      allocated: totalTokens > 0,
      allocations,
    });
  }

  const repositoryReports = Array.from(repositories.values())
    .map((state) => finalizeRepository(state, range.workingEstimate, allocatedWorkingEstimate))
    .sort((left, right) =>
      right.allocatedWorkingEstimate - left.allocatedWorkingEstimate ||
      right.addedCodeTokens - left.addedCodeTokens ||
      left.repository.localeCompare(right.repository));

  return {
    startDate: range.startDate,
    endDate: range.endDate,
    calendarDays: range.calendarDays,
    activeDays: range.activeDays,
    timeZone,
    allocationBasis: REPOSITORY_ALLOCATION_BASIS,
    interpretation: "Heuristic allocation based on same-day retained added-code tokens; correlated, not causal.",
    workingEstimate: range.workingEstimate,
    allocatedWorkingEstimate,
    unallocatedWorkingEstimate,
    allocationCoverage: range.workingEstimate === 0 ? null : allocatedWorkingEstimate / range.workingEstimate,
    allocationDays,
    unallocatedDays,
    repositoryCount: repositoryReports.length,
    repositories: repositoryReports,
    daily,
  };
}
