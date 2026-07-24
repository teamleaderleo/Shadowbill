/**
 * @typedef {'none'|'low'|'medium'|'high'|'xhigh'|'max'|'unknown'} ReasoningEffort
 *
 * @typedef {Object} ChatTurnEvent
 * @property {'chat_turn'} type
 * @property {string} id
 * @property {string} timestamp
 * @property {string} conversationHash
 * @property {string} model
 * @property {ReasoningEffort} reasoningEffort
 * @property {number} visibleInputTokens
 * @property {number} visibleOutputTokens
 * @property {number=} toolActivityCount
 * @property {number=} responseDurationMs
 * @property {string=} collectorVersion
 *
 * @typedef {Object} GitCommitEvent
 * @property {'git_commit'} type
 * @property {string} id
 * @property {string} timestamp
 * @property {string} repository
 * @property {string} branch
 * @property {string} sha
 * @property {string} subject
 * @property {number} additions
 * @property {number} deletions
 * @property {number} changedFiles
 * @property {number} addedCodeTokens
 * @property {string=} collectorVersion
 *
 * @typedef {ChatTurnEvent|GitCommitEvent} ShadowbillEvent
 *
 * @typedef {Object} ModelPricing
 * @property {number} inputPerMillion
 * @property {number} cachedInputPerMillion
 * @property {number} cacheWritePerMillion
 * @property {number} outputPerMillion
 * @property {number} longContextThresholdTokens
 * @property {number} longContextInputMultiplier
 * @property {number} longContextOutputMultiplier
 *
 * @typedef {Object} EstimationProfile
 * @property {string} name
 * @property {number} cachedReadFraction
 * @property {number} cacheWriteFraction
 * @property {number} billableOutputMultiplier
 */

export {};
