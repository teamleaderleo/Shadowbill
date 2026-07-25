# Roadmap

This roadmap turns the current Shadowbill implementation into Proofwake without discarding working code or breaking existing local data.

## Product objective

Proofwake should become a local, standards-native evidence index that makes heterogeneous project receipts legible across a personal or small-team software fleet.

The initial success case is five unlike repositories with useful revision evidence, failure, recovery, staleness, and attention views.

## Milestone 0 — establish the project contract

Status: documentation and migration planning.

- [x] Rename the GitHub repository to Proofwake.
- [x] Define the product purpose, users, boundaries, and relationship with neighbouring tools.
- [x] Choose Apache-2.0 and add the repository licence.
- [x] Define the high-level architecture and standards position.
- [ ] Complete the Shadowbill-to-Proofwake compatibility migration plan.
- [ ] Add `proofwake` CLI and MCP aliases while preserving legacy entrypoints.
- [ ] Update package, extension, dashboard, help text, examples, and documentation branding.
- [ ] Define environment-variable precedence and deprecation output.
- [ ] Define safe discovery or migration from `~/.shadowbill` to the eventual Proofwake data location.
- [ ] Publish a first tagged release after the compatibility path is tested.

Exit criteria:

- existing Shadowbill users keep access to their ledgers and commands;
- new users encounter Proofwake terminology first;
- project scope is understandable from the README and linked documents;
- licensing is explicit.

## Milestone 1 — observation envelope and strict emitter

Define the smallest durable v1 observation contract.

- [ ] Map the common envelope to CloudEvents 1.0.
- [ ] Map CI/CD event kinds to CDEvents where suitable.
- [ ] Adopt OpenTelemetry VCS and CI/CD semantic attributes where suitable.
- [ ] Define `proofwake.*` extensions for evidence coverage, disclosure, and repository policy.
- [ ] Define source time, observed time, and ingestion time semantics.
- [ ] Define source trust and disclosure classes.
- [ ] Define stable failure codes.
- [ ] Define event identity, request fingerprint, duplicate replay, and conflicting-key rejection.
- [ ] Define maximum event, string, array, and evidence-reference sizes.
- [ ] Add strict nested duplicate-key and non-standard-number rejection where JSON is accepted.
- [ ] Implement `proofwake emit --json FILE` and `proofwake emit --stdin`.
- [ ] Add deterministic fixtures and round-trip export tests.

Exit criteria:

- one local producer can emit a bounded event twice and receive one stored effect;
- conflicting reuse of the same event identity fails visibly;
- no arbitrary payload or content-bearing field reaches the ledger.

## Milestone 2 — repository enrolment and fleet inventory

- [ ] Define `.proofwake.json` version 1.
- [ ] Support explicit global registry entries for repositories that should not commit local configuration.
- [ ] Validate repository identity, expected signals, staleness windows, and adapter paths.
- [ ] Let autodetection propose configuration without silently approving it.
- [ ] Add `proofwake enroll`, `proofwake repositories`, and `proofwake doctor` registry checks.
- [ ] Classify enrolled repositories as active, dormant, misconfigured, or unobserved.
- [ ] Show source freshness and coverage per repository.

Exit criteria:

- five unlike repositories can be enrolled;
- Proofwake reports which projects are active, dormant, or missing observations;
- every policy conclusion names its configuration source.

## Milestone 3 — local command receipts

Implement the fastest broadly useful adapter.

```text
proofwake run --repo owner/name --kind verify -- npm test
```

- [ ] Bind the command receipt to repository identity and current revision.
- [ ] Record start, completion, duration, exit class, and cancellation.
- [ ] Record a reviewed command identity without storing shell history or environment dumps.
- [ ] Keep stdout and stderr out of the ledger by default.
- [ ] Record bounded byte and line counts, truncation state, and optional external log reference.
- [ ] Support declared artifact references with digest, size, and media type.
- [ ] Preserve child exit behaviour with stable Proofwake-specific failure codes.
- [ ] Add interruption, timeout, oversized-output, and nested invocation tests.

Exit criteria:

- Node, Rust, and one additional repository can record local verification receipts;
- raw source and command output remain excluded;
- interrupted and failed runs remain useful observations.

## Milestone 4 — Git and GitHub normalisation

- [ ] Migrate existing local Git events into the v1 envelope.
- [ ] Preserve retained-code estimates as an optional measurement rather than the repository association authority.
- [ ] Normalise push, pull-request, workflow-run, check, deployment, and release observations.
- [ ] Track workflow attempt and rerun lineage.
- [ ] Record signed webhook delivery health separately from domain event status.
- [ ] Add historical backfill with explicit coverage windows and rate bounds.
- [ ] Export compatible CDEvents where mappings are defined.

Exit criteria:

- a repository revision can display commit, pull request, CI, and deployment observations in one timeline;
- duplicate webhook delivery remains idempotent;
- backfilled and live observations are visibly distinguished.

## Milestone 5 — revision evidence projection

This is the first core Proofwake product milestone.

- [ ] Build per-revision expected-signal matrices.
- [ ] Compute green, red, yellow, and grey state from declared policy.
- [ ] Expose the exact observations behind every state.
- [ ] Detect missing and stale expected signals.
- [ ] Model failure-to-passing recovery intervals.
- [ ] Identify repeated reruns and bounded flaky-outcome candidates.
- [ ] Distinguish no evidence from failing evidence.
- [ ] Rebuild projections deterministically from the ledger.
- [ ] Add report coverage and projection-version metadata.

Exit criteria:

- `proofwake inspect REVISION` answers which expected evidence exists and why;
- `proofwake fleet` identifies current failures, missing evidence, and stale adapters;
- no status relies on timestamp proximity as causality.

## Milestone 6 — first native adapter: Renderprove

Renderprove is the first native cross-project adapter because it already emits strict, bounded browser evidence receipts.

- [ ] Validate receipt schema and supported versions.
- [ ] Bind receipt identity, manifest identity, source revision, review cases, and policy result.
- [ ] Index screenshots and diagnostics by reference and digest without copying them into the ledger.
- [ ] Preserve disclosure and retention classes.
- [ ] Distinguish receipt verification failure from browser policy failure.
- [ ] Add fixtures from a simple public app, a stateful app, and a protected dashboard.
- [ ] Report browser-review coverage in the revision evidence matrix.

Exit criteria:

- three unlike web applications expose browser-review evidence through Proofwake;
- a deliberately broken revision fails for the expected reason;
- evidence references remain independently verifiable.

## Milestone 7 — fleet dashboard and read-only MCP

- [ ] Replace the cost-first dashboard home with fleet inventory and attention.
- [ ] Show latest revision, age, evidence coverage, current failure, and source freshness.
- [ ] Add repository evidence timelines.
- [ ] Add failure and recovery views.
- [ ] Add panel-local errors so one adapter cannot blank the whole dashboard.
- [ ] Persist range, repository, revision, and timezone state in the URL.
- [ ] Add JSON, JSONL, and CSV export.
- [ ] Add read-only MCP tools for fleet, repository, revision, failure, and recovery reports.
- [ ] Keep the existing Shadowbill estimates as an optional secondary view.

Exit criteria:

- one screen answers what changed, what is failing, what is stale, and what needs attention;
- every recommendation links to source observations;
- disabled or failing adapters degrade locally.

## Milestone 8 — ecosystem adapters and exports

Add integrations only after the core projection proves useful.

- [ ] SmolRunner doctor, plan, and execution receipt summaries.
- [ ] Starsector Preflight and other domain-receipt adapters.
- [ ] SLSA and in-toto provenance indexing.
- [ ] OpenLineage-style run import where appropriate.
- [ ] OTLP export for compatible observations and metrics.
- [ ] CDEvents import and export.
- [ ] Optional Backstage card or plugin.
- [ ] Optional Apache DevLake export or plugin.
- [ ] Optional Stensibly evidence-reference adapter.

Exit criteria:

- Proofwake integrates with larger platforms without requiring them for local use;
- adapter contracts remain narrow, versioned, and independently testable.

## Milestone 9 — Shadowbill observation family

Preserve the original experiment as an explicitly bounded module.

- [ ] Rename UI and API presentation to “Shadowbill estimates” within Proofwake.
- [ ] Keep pricing catalogs and calibration profiles versioned.
- [ ] Mark every number as visible activity, API-equivalent estimate, or delivered-work indicator.
- [ ] Remove any implication that an estimate represents provider internal cost or billing.
- [ ] Evaluate compliant collection methods and keep unsupported collection outside the default product path.
- [ ] Support complete disablement without reducing fleet evidence functionality.

Exit criteria:

- the original cost experiment remains available and honestly labelled;
- Proofwake’s main value does not depend on AI-usage collection.

## Product quality bar

Every adapter and user-facing feature must include:

- exact trust and authority boundary;
- schema and maximum sizes;
- privacy and disclosure classification;
- idempotency behaviour;
- stable machine-readable failures;
- source coverage and freshness;
- visible success and failure states;
- degraded-mode behaviour;
- fixtures from at least one real repository;
- focused automated regression coverage;
- migration behaviour for future schema changes.

## Explicit non-goals before the first stable release

Do not build:

- hosted public multi-tenancy;
- arbitrary log ingestion;
- a distributed tracing backend;
- a generic metrics database;
- automated remediation;
- CI scheduling;
- task management;
- agent orchestration;
- employee or repository productivity scoring;
- a universal DORA suite;
- a new provenance or event standard;
- raw prompt, response, source, or secret storage.

## Suggested implementation order

1. Compatibility naming migration
2. Observation envelope and `emit`
3. Repository registry
4. Local command receipts
5. GitHub normalisation
6. Revision evidence projection
7. Renderprove adapter
8. Fleet dashboard and MCP
9. Optional exports and native adapters
10. Shadowbill module cleanup
