# Activity report compatibility view

## Status

This document defines the migration seam between legacy Shadowbill delivery events and Proofwake observation-v1 activity. It does not change collector writes by itself.

The implementation lives in `src/activity-view.js`.

## Purpose

Estimate and repository-allocation reports historically read these ledger event families directly:

- `git_commit`;
- `github_push`;
- `github_pull_request`;
- `github_workflow_run`;
- `github_deployment`.

During issue #69, new local Git and signed GitHub deliveries will become observation-v1 records. Reports need one bounded view that can read both generations without rewriting history and without counting one source effect twice.

## Observation types

The compatibility view recognises only these explicit observation types:

- `dev.proofwake.git.commit.v1`;
- `dev.proofwake.github.push.v1`;
- `dev.proofwake.github.pull-request.v1`;
- `dev.proofwake.github.workflow-run.v1`;
- `dev.proofwake.github.deployment-status.v1`.

Other observation types remain outside estimate reports.

Local commit observations require adapter name `git` with `local-operator` trust. GitHub observations require adapter name `github` with `signed-provider` trust. A structurally incomplete, malformed, or differently trusted record is ignored by this view and cannot suppress legacy activity.

## Identity and duplicate representation

The observation `(source, id)` pair is hashed for the internal compatibility event ID. Raw source identifiers do not become report event IDs.

Duplicate-representation keys are:

- local commit: repository plus full revision;
- GitHub delivery: provider delivery ID, carried as the observation ID.

When a recognised observation and a legacy event have the same key, the observation-backed representation is selected and the legacy representation is suppressed. This handles a bounded transition or atomic compatibility record without double counting.

The view does not heuristically merge different provider deliveries or unrelated observations that happen to share timestamps, repository identity, run identity, or status.

## Scalar fact contract

Facts are optional unless listed as required below. Missing optional counts become zero and missing optional private labels become empty strings. Content-bearing values are deliberately not reconstructed.

### Local Git commit

Relationships:

- `repository` — required;
- `revision` — required full SHA-1.

Allowlisted facts:

- `git.additions`;
- `git.deletions`;
- `git.changed-files`;
- `git.added-code-tokens`.

Commit subject and branch name remain excluded from the compatibility output.

### GitHub push

Relationships:

- `repository` — required;
- `revision` — optional current revision.

Allowlisted facts:

- `github.push.before`;
- `github.push.after`;
- `github.push.commit-count`;
- `github.push.created`;
- `github.push.deleted`;
- `github.push.forced`.

Ref and branch text remain excluded.

### GitHub pull request

Relationships:

- `repository` — required;
- `revision` — optional selected or merged revision.

Required fact:

- `github.pull-request.number`.

Allowlisted optional facts:

- `github.pull-request.action`;
- `github.pull-request.state`;
- `github.pull-request.merged`;
- `github.pull-request.draft`;
- `github.pull-request.head-sha`;
- `github.pull-request.base-sha`;
- `github.pull-request.merge-commit-sha`;
- `github.pull-request.additions`;
- `github.pull-request.deletions`;
- `github.pull-request.changed-files`.

Pull-request title, body, comments, author text, labels, and URLs remain excluded.

### GitHub workflow run

Relationships:

- `repository` — required;
- `revision` — optional head revision;
- `workflowAttempt` — optional positive attempt number, defaulting to one.

Required fact:

- `github.workflow-run.id`.

Allowlisted optional facts:

- `github.workflow-run.head-sha`;
- `github.workflow-run.duration-ms`.

Observation status maps to the legacy conclusion used by aggregate reports. Workflow display names and logs remain excluded.

### GitHub deployment status

Relationships:

- `repository` — required;
- `revision` — optional deployment revision.

Required fact:

- `github.deployment.id`.

Allowlisted optional fact:

- `github.deployment.sha`.

Observation status maps to the legacy deployment state. Environment names, refs, URLs, descriptions, and provider payload content remain excluded.

## Boundaries

The compatibility view is read-only. It never appends, rewrites, repairs, or deletes ledger records.

It preserves existing non-observation rows in their original order. Unrecognised observation records are excluded from estimate activity. Projection readers continue to consume the original observation records rather than this compatibility view.

Release observations are intentionally absent because existing estimate reports have no release metric. A later report can add them without widening this compatibility contract.
