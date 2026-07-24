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

function localDate(isoTimestamp) {
  const date = new Date(isoTimestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * @param {import('./types.js').ShadowbillEvent[]} events
 * @param {string} date
 * @param {import('./types.js').ModelPricing} pricing
 * @param {import('./types.js').EstimationProfile} [workingProfile]
 */
export function buildDailyReport(events, date, pricing, workingProfile = DEFAULT_WORKING_PROFILE) {
  const dayEvents = events.filter((event) => localDate(event.timestamp) === date);
  const chats = dayEvents.filter((event) => event.type === "chat_turn");
  const commits = dayEvents.filter((event) => event.type === "git_commit");
  const sum = (values) => values.reduce((total, value) => total + value, 0);
  const estimated = (profile) => sum(chats.map((chat) => estimateTurnCost(chat, pricing, profile).totalCost));

  const addedCodeTokens = sum(commits.map((commit) => commit.addedCodeTokens));
  const deliveredCodeFloor = (addedCodeTokens / 1_000_000) * pricing.outputPerMillion;
  const workingEstimate = estimated(workingProfile);

  return {
    date,
    chatTurns: chats.length,
    conversations: new Set(chats.map((chat) => chat.conversationHash)).size,
    visibleInputTokens: sum(chats.map((chat) => chat.visibleInputTokens)),
    visibleOutputTokens: sum(chats.map((chat) => chat.visibleOutputTokens)),
    commits: commits.length,
    repositories: new Set(commits.map((commit) => commit.repository)).size,
    additions: sum(commits.map((commit) => commit.additions)),
    deletions: sum(commits.map((commit) => commit.deletions)),
    addedCodeTokens,
    deliveredCodeFloor,
    visibleCachedFloor: estimated(VISIBLE_CACHED_PROFILE),
    visibleUncachedEstimate: estimated(VISIBLE_UNCACHED_PROFILE),
    workingEstimate,
    costPerCommit: commits.length === 0 ? null : workingEstimate / commits.length,
    costPerAddedCodeToken: addedCodeTokens === 0 ? null : workingEstimate / addedCodeTokens,
  };
}
