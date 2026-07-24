/** @type {import('./types.js').EstimationProfile} */
export const DEFAULT_WORKING_PROFILE = {
  name: "working",
  cachedReadFraction: 0.7,
  cacheWriteFraction: 0.1,
  billableOutputMultiplier: 2.5,
};

/** @type {import('./types.js').EstimationProfile} */
export const VISIBLE_CACHED_PROFILE = {
  name: "visible-cached-floor",
  cachedReadFraction: 1,
  cacheWriteFraction: 0,
  billableOutputMultiplier: 1,
};

/** @type {import('./types.js').EstimationProfile} */
export const VISIBLE_UNCACHED_PROFILE = {
  name: "visible-uncached",
  cachedReadFraction: 0,
  cacheWriteFraction: 0,
  billableOutputMultiplier: 1,
};

function assertFraction(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1`);
  }
}

/**
 * @param {import('./types.js').ChatTurnEvent} turn
 * @param {import('./types.js').ModelPricing} pricing
 * @param {import('./types.js').EstimationProfile} profile
 */
export function estimateTurnCost(turn, pricing, profile) {
  assertFraction(profile.cachedReadFraction, "cachedReadFraction");
  assertFraction(profile.cacheWriteFraction, "cacheWriteFraction");

  const classifiedFraction = profile.cachedReadFraction + profile.cacheWriteFraction;
  if (classifiedFraction > 1) {
    throw new Error("cachedReadFraction + cacheWriteFraction cannot exceed 1");
  }
  if (profile.billableOutputMultiplier < 1 || !Number.isFinite(profile.billableOutputMultiplier)) {
    throw new Error("billableOutputMultiplier must be a finite value of at least 1");
  }

  const cachedReadTokens = turn.visibleInputTokens * profile.cachedReadFraction;
  const cacheWriteTokens = turn.visibleInputTokens * profile.cacheWriteFraction;
  const uncachedInputTokens = turn.visibleInputTokens - cachedReadTokens - cacheWriteTokens;
  const billableOutputTokens = turn.visibleOutputTokens * profile.billableOutputMultiplier;
  const longContextPricingApplied = turn.visibleInputTokens > pricing.longContextThresholdTokens;
  const inputMultiplier = longContextPricingApplied ? pricing.longContextInputMultiplier : 1;
  const outputMultiplier = longContextPricingApplied ? pricing.longContextOutputMultiplier : 1;

  const cachedReadCost = (cachedReadTokens / 1_000_000) * pricing.cachedInputPerMillion * inputMultiplier;
  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * pricing.cacheWritePerMillion * inputMultiplier;
  const uncachedInputCost = (uncachedInputTokens / 1_000_000) * pricing.inputPerMillion * inputMultiplier;
  const outputCost = (billableOutputTokens / 1_000_000) * pricing.outputPerMillion * outputMultiplier;

  return {
    cachedReadTokens,
    cacheWriteTokens,
    uncachedInputTokens,
    billableOutputTokens,
    cachedReadCost,
    cacheWriteCost,
    uncachedInputCost,
    outputCost,
    totalCost: cachedReadCost + cacheWriteCost + uncachedInputCost + outputCost,
    longContextPricingApplied,
  };
}

export function dateInTimeZone(isoTimestamp, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(isoTimestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

/**
 * Resolves append-only browser captures into one latest estimate per logical turn.
 * The earliest turn timestamp is retained so a later revision stays attributed to
 * the day on which the turn first appeared.
 * @param {import('./types.js').ShadowbillEvent[]} events
 */
export function resolveChatTurnRevisions(events) {
  const records = [];
  const groups = new Map();

  for (const event of events) {
    if (event.type !== "chat_turn") continue;
    if (!event.logicalTurnHash) {
      records.push({ turn: event, revisionCount: 1 });
      continue;
    }

    const key = `${event.conversationHash}:${event.logicalTurnHash}`;
    const capturedAt = Date.parse(event.capturedAt ?? event.timestamp);
    const timestamp = Date.parse(event.timestamp);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        latest: event,
        latestCapturedAt: capturedAt,
        earliestTimestamp: timestamp,
        revisionCount: 1,
      });
      continue;
    }

    existing.revisionCount += 1;
    existing.earliestTimestamp = Math.min(existing.earliestTimestamp, timestamp);
    if (capturedAt > existing.latestCapturedAt ||
        (capturedAt === existing.latestCapturedAt && event.id > existing.latest.id)) {
      existing.latest = event;
      existing.latestCapturedAt = capturedAt;
    }
  }

  for (const group of groups.values()) {
    records.push({
      turn: {
        ...group.latest,
        timestamp: new Date(group.earliestTimestamp).toISOString(),
      },
      revisionCount: group.revisionCount,
    });
  }

  return records.sort((left, right) => {
    const timestampDifference = Date.parse(left.turn.timestamp) - Date.parse(right.turn.timestamp);
    return timestampDifference || left.turn.id.localeCompare(right.turn.id);
  });
}

function perOutcome(cost, count) {
  return count === 0 ? null : cost / count;
}

/**
 * @param {import('./types.js').ShadowbillEvent[]} events
 * @param {string} date
 * @param {import('./types.js').ModelPricing} pricing
 * @param {import('./types.js').EstimationProfile} [workingProfile]
 */
export function buildDailyReport(events, date, pricing, workingProfile = DEFAULT_WORKING_PROFILE, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const chatRecords = resolveChatTurnRevisions(events)
    .filter((record) => dateInTimeZone(record.turn.timestamp, timeZone) === date);
  const chats = chatRecords.map((record) => record.turn);
  const dayEvents = events.filter((event) => event.type !== "chat_turn" && dateInTimeZone(event.timestamp, timeZone) === date);
  const commits = dayEvents.filter((event) => event.type === "git_commit");
  const pushes = dayEvents.filter((event) => event.type === "github_push");
  const pullRequests = dayEvents.filter((event) => event.type === "github_pull_request");
  const workflowRuns = dayEvents.filter((event) => event.type === "github_workflow_run");
  const deployments = dayEvents.filter((event) => event.type === "github_deployment");
  const sum = (values) => values.reduce((total, value) => total + value, 0);
  const estimated = (profile) => sum(chats.map((chat) => estimateTurnCost(chat, pricing, profile).totalCost));

  const addedCodeTokens = sum(commits.map((commit) => commit.addedCodeTokens));
  const deliveredCodeFloor = (addedCodeTokens / 1_000_000) * pricing.outputPerMillion;
  const workingEstimate = estimated(workingProfile);
  const uniqueCount = (values) => new Set(values).size;
  const mergedPullRequests = uniqueCount(pullRequests.filter((event) => event.merged).map((event) => `${event.repository}:${event.number}`));
  const workflowRunCount = uniqueCount(workflowRuns.map((event) => `${event.repository}:${event.runId}`));
  const successfulWorkflowRuns = uniqueCount(workflowRuns.filter((event) => event.conclusion === "success").map((event) => `${event.repository}:${event.runId}`));
  const deploymentCount = uniqueCount(deployments.map((event) => `${event.repository}:${event.deploymentId}`));
  const successfulDeployments = uniqueCount(deployments.filter((event) => event.state === "success").map((event) => `${event.repository}:${event.deploymentId}`));
  const repositoryNames = dayEvents
    .filter((event) => "repository" in event && typeof event.repository === "string")
    .map((event) => event.repository);
  const chatRevisionEvents = sum(chatRecords.map((record) => record.revisionCount));

  return {
    date,
    chatTurns: chats.length,
    chatRevisionEvents,
    supersededChatRevisions: chatRevisionEvents - chats.length,
    conversations: new Set(chats.map((chat) => chat.conversationHash)).size,
    visibleInputTokens: sum(chats.map((chat) => chat.visibleInputTokens)),
    visibleOutputTokens: sum(chats.map((chat) => chat.visibleOutputTokens)),
    commits: commits.length,
    pushes: pushes.length,
    pullRequestEvents: pullRequests.length,
    mergedPullRequests,
    workflowRunEvents: workflowRuns.length,
    workflowRuns: workflowRunCount,
    successfulWorkflowRuns,
    deploymentStatusEvents: deployments.length,
    deployments: deploymentCount,
    successfulDeployments,
    repositories: new Set(repositoryNames).size,
    additions: sum(commits.map((commit) => commit.additions)),
    deletions: sum(commits.map((commit) => commit.deletions)),
    addedCodeTokens,
    deliveredCodeFloor,
    visibleCachedFloor: estimated(VISIBLE_CACHED_PROFILE),
    visibleUncachedEstimate: estimated(VISIBLE_UNCACHED_PROFILE),
    workingEstimate,
    costPerCommit: perOutcome(workingEstimate, commits.length),
    costPerMergedPullRequest: perOutcome(workingEstimate, mergedPullRequests),
    costPerSuccessfulWorkflowRun: perOutcome(workingEstimate, successfulWorkflowRuns),
    costPerSuccessfulDeployment: perOutcome(workingEstimate, successfulDeployments),
    costPerAddedCodeToken: addedCodeTokens === 0 ? null : workingEstimate / addedCodeTokens,
  };
}
