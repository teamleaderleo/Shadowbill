/**
 * @typedef {'none'|'low'|'medium'|'high'|'xhigh'|'max'|'unknown'} ReasoningEffort
 *
 * @typedef {Object} ChatTurnEvent
 * @property {'chat_turn'} type
 * @property {string} id
 * @property {string} timestamp
 * @property {string=} capturedAt
 * @property {string=} logicalTurnHash
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
 * @typedef {Object} GitHubPushEvent
 * @property {'github_push'} type
 * @property {string} id
 * @property {string} timestamp
 * @property {string} repository
 * @property {string} ref
 * @property {string} branch
 * @property {string} before
 * @property {string} after
 * @property {number} commitCount
 * @property {boolean} created
 * @property {boolean} deleted
 * @property {boolean} forced
 * @property {string} deliveryId
 *
 * @typedef {Object} GitHubPullRequestEvent
 * @property {'github_pull_request'} type
 * @property {string} id
 * @property {string} timestamp
 * @property {string} repository
 * @property {string} action
 * @property {number} number
 * @property {string} state
 * @property {boolean} merged
 * @property {boolean} draft
 * @property {string} headSha
 * @property {string} baseSha
 * @property {string|null} mergeCommitSha
 * @property {number} additions
 * @property {number} deletions
 * @property {number} changedFiles
 * @property {string} deliveryId
 *
 * @typedef {Object} GitHubWorkflowRunEvent
 * @property {'github_workflow_run'} type
 * @property {string} id
 * @property {string} timestamp
 * @property {string} repository
 * @property {number} runId
 * @property {string} workflow
 * @property {string} status
 * @property {string|null} conclusion
 * @property {string} headSha
 * @property {number} runAttempt
 * @property {number|null} durationMs
 * @property {string} deliveryId
 *
 * @typedef {Object} GitHubDeploymentEvent
 * @property {'github_deployment'} type
 * @property {string} id
 * @property {string} timestamp
 * @property {string} repository
 * @property {number} deploymentId
 * @property {string} state
 * @property {string} environment
 * @property {string} sha
 * @property {string} ref
 * @property {string} deliveryId
 *
 * @typedef {ChatTurnEvent|GitCommitEvent|GitHubPushEvent|GitHubPullRequestEvent|GitHubWorkflowRunEvent|GitHubDeploymentEvent} ShadowbillEvent
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
