import {
  canonicalRepository,
  contentDigest,
  createActivityObservation,
  fullRevision,
  mappedTimes,
  nonNegativeInteger,
  partialCoverage,
  mappingFailure,
} from "./activity-observation.js";

const ADAPTER = Object.freeze({
  name: "git",
  version: "1.0.0",
  mappingVersion: 1,
  trust: "local-operator",
  sourceSchema: "git-commit",
  sourceSchemaVersion: "1",
});

function optionalCount(event, key, factName, code) {
  const value = nonNegativeInteger(event[key], code, key, { optional: true });
  return value === undefined ? null : { name: factName, value };
}

function commitObservationId(repository, revision) {
  const digest = contentDigest({ repository, revision }).slice("sha256:".length);
  return `git-commit-${digest}`;
}

/**
 * Maps the current local Git commit event family into Proofwake observation v1.
 * Commit prose, patches, changed paths, commands, and remote credentials are
 * intentionally outside the returned observation.
 *
 * @param {import('./types.js').GitCommitEvent|Record<string, unknown>} event
 * @param {{observedAt?: string, ingestedAt?: string}} [options]
 */
export function mapGitCommitObservation(event, options = {}) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    mappingFailure("GIT_OBSERVATION_INVALID_EVENT", "Git commit input must be an object.");
  }
  if (event.type !== undefined && event.type !== "git_commit") {
    mappingFailure("GIT_OBSERVATION_INVALID_EVENT", "Git commit input has an unsupported type.");
  }

  const repository = canonicalRepository(event.repository, "GIT_OBSERVATION_INVALID_REPOSITORY");
  const revision = fullRevision(event.sha, "GIT_OBSERVATION_INVALID_REVISION");
  const times = mappedTimes(
    event.timestamp,
    options.observedAt ?? event.timestamp,
    options.ingestedAt ?? options.observedAt ?? event.timestamp,
  );
  const facts = [
    optionalCount(event, "additions", "git.commit.additions", "GIT_OBSERVATION_INVALID_COUNT"),
    optionalCount(event, "deletions", "git.commit.deletions", "GIT_OBSERVATION_INVALID_COUNT"),
    optionalCount(event, "changedFiles", "git.commit.changed-files", "GIT_OBSERVATION_INVALID_COUNT"),
    optionalCount(event, "addedCodeTokens", "proofwake.retained-code-tokens", "GIT_OBSERVATION_INVALID_RETAINED_CODE"),
  ].filter(Boolean);

  return createActivityObservation({
    id: commitObservationId(repository, revision),
    source: "urn:proofwake:adapter:git",
    type: "dev.proofwake.git.commit.v1",
    subject: `repo:${repository}@sha:${revision}`,
    time: times.time,
    adapter: ADAPTER,
    kind: "verify",
    status: "passed",
    timeSource: "producer",
    observedAt: times.observedAt,
    ingestedAt: times.ingestedAt,
    relationships: { repository, revision },
    facts,
    evidence: [],
    coverage: partialCoverage([
      "git.commit-subject.redacted",
      "git.commit-body.redacted",
      "git.patch.redacted",
      "git.paths.redacted",
      "git.command-output.redacted",
      "git.credentials.redacted",
    ]),
  });
}
