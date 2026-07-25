# Repository enrolment and inventory

## Commands

Inspect one repository without changing the registry:

```bash
proofwake enroll /path/to/repository
proofwake enroll /path/to/repository --output json
```

Persist the inspected proposal:

```bash
proofwake enroll /path/to/repository --write
```

List the enrolled fleet:

```bash
proofwake repositories
proofwake repositories --output json
```

The registry defaults to `repositories.json` beside the active Proofwake event ledger. `--registry PATH` selects another local registry. `--data PATH` selects the event ledger used for storage identity and inventory observations.

## Authority order

Proofwake selects policy in this order:

1. a tracked and clean `.proofwake.json` in the Git repository;
2. an explicitly supplied global policy with `--policy FILE`;
3. an autodetected proposal.

A committed policy is authoritative. Supplying a different global policy while `.proofwake.json` exists fails with `REPOSITORY_CONFIGURATION_CONFLICT`.

Autodetection never writes by itself. Persisting an autodetected proposal requires both:

```bash
proofwake enroll PATH --write --approve-autodetected
```

The approved proposal is stored as a global policy snapshot in the local registry. Adding a committed policy later shadows an identical global policy. A different committed policy is reported as a configuration conflict.

## Repository identity

Remote policies use canonical `owner/name` identity. Proofwake verifies the configured identity against every canonical Git remote URL; remote names such as `origin`, `upstream`, and `review` are not authoritative.

A repository with multiple remotes is valid when at least one remote matches the policy. A remote policy with no canonical remote, or no matching remote, fails closed.

Local-only policies use the privacy-preserving `localId` from repository policy v1. Autodetection derives a temporary local identity from the canonical checkout path and warns that moving the checkout changes that proposal. Committing an explicit local policy is preferred.

Detached HEAD is supported. The exact revision remains available; default-branch selection is reported as unavailable until a branch or provider observation supplies it.

## Registry contract

The local registry records:

- repository identity and display label;
- canonical checkout root and filesystem identity;
- committed or global policy source;
- validated policy snapshot and fingerprint;
- explicit approval method;
- enrolment and update timestamps.

It excludes credentials, commands, environment values, source content, logs, and adapter receipt contents.

Registry updates use a local lock, temporary owner-only file, file sync, atomic rename, and parent-directory sync. Re-enrolling unchanged metadata is idempotent. Changed identity, root, or policy requires `--replace`.

## Adapter readiness

Enrolment checks only whether each declared receipt-file adapter path is:

- inside the canonical repository root;
- a regular file;
- not a symbolic link;
- currently present.

It does not parse or ingest the receipt yet. Missing optional adapter files remain visible readiness results rather than preventing policy enrolment.

## Inventory projection

`proofwake repositories` reports per repository:

- active, dormant, unobserved, or misconfigured classification;
- green, yellow, red, or grey health;
- current checkout revision and branch;
- effective policy source and whether committed policy changed since enrolment;
- adapter readiness;
- observation count and latest observation time;
- every expected signal with requirement, applicability, state, selected receipt, and reason;
- one evidence-grounded attention reason.

A signal is satisfied only by observations whose adapter is allowed by `acceptedSources`. Revision signals also require the exact selected revision.

Required failing evidence produces red health. Required missing, stale, partial, unavailable, warning, unknown, or selection-unavailable evidence produces yellow. Optional signals remain visible without changing health.

## Current v1 selection limits

The local checkout supplies selection for:

- `every-revision`;
- `default-branch` while a branch is available.

`deployed-revision` and `release` policy remain explicit but report `selection-unavailable` until deployment and release selectors are implemented. Proofwake does not silently substitute the current checkout for those meanings.

## Configuration changes

For committed policy, the repository file remains authoritative after enrolment. When its fingerprint changes, inventory uses the current committed policy and reports `policyChanged: true`; re-enrol with `--write --replace` to acknowledge the new registry snapshot.

For global policy, a newly committed identical policy becomes authoritative and the global snapshot is reported as shadowed. A different committed policy is a visible conflict.
