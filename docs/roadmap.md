# Roadmap

This roadmap tracks the current Proofwake product rather than the order in which the Shadowbill experiment originally grew.

Snapshot: 2026-07-26.

## Product objective

Proofwake is a local evidence index for software projects. It collects bounded, content-minimised observations from local commands, Git, GitHub, CI, browser reviews, deployments, domain tools, and optional AI-usage estimates, then organises them by repository and revision.

The initial success case is a five-repository pilot with useful evidence, failure, recovery, staleness, and attention views.

## Current product baseline

The following capabilities are merged on `main`:

- Proofwake is the primary package and CLI identity, with Shadowbill command, environment-variable, and data-path compatibility.
- Observation v1 has a strict CloudEvents-compatible envelope, JSON Schema, bounded parser, canonical fingerprints, duplicate replay, and conflict rejection.
- `proofwake emit` accepts one strict observation from a file or stdin through a hardened local boundary.
- Repository policy v1 defines identity, lifecycle, expected signals, freshness, accepted sources, and bounded receipt-file adapters.
- `proofwake enroll` and `proofwake repositories` provide dry-run-first enrolment and policy-aware fleet inventory.
- `proofwake run` records bounded local command receipts tied to an exact repository revision while keeping raw arguments, environment values, stdout, and stderr outside the ledger.
- `proofwake inspect` and `proofwake fleet` rebuild deterministic evidence projections with green, red, yellow, and grey states, source cursors, bounded history, and evidence-backed attention reasons.
- The original Shadowbill estimate collector, reports, dashboard, diagnostics, Git/GitHub collection, and MCP tools remain available as an optional module.

The first native Renderprove receipt adapter is active work in issue #42 and pull request #63.

## Five-repository pilot

| Repository | Role in the pilot | Initial evidence path | Stage |
| --- | --- | --- | --- |
| Proofwake | Self-observation and policy dogfood | local command receipts, Git/GitHub, policy checks | baseline available |
| Renderprove | Browser-review producer | strict receipt v1 and screenshot digests | native adapter in progress |
| SmolRunner | Runner and host-diagnostics producer | doctor, plan, and execution receipt summaries | fixture available; native adapter later |
| Stensibly | Coordination consumer | evidence references and attention output | policy fixture available; integration later |
| One More Legend | Unlike application workload | local verification and domain receipts | policy fixture available; pilot wiring later |

The pilot succeeds when all five repositories can be enrolled and their expected evidence can be inspected without copying source, logs, secrets, prompts, or full external receipts into the ledger.

## Active lanes

### Lane A — finish the first native adapter

Owner issue: #42. Active pull request: #63.

- validate Renderprove receipt v1 and every declared screenshot digest;
- bind evidence to one stable tracked checkout revision;
- map review status, case identities, coverage, receipt digest, and artifact digests into observation v1;
- keep URLs, page titles, diagnostics, commands, environment-adjacent values, and local paths outside the ledger;
- prove replay, conflict, path, mutation, digest, and dirty-checkout behaviour.

Exit: three unlike web applications expose independently verifiable browser-review evidence through Proofwake.

### Lane B — expose Proofwake-native read-only interfaces

Owner issue: #43 plus a focused MCP child issue.

- add read-only MCP tools for fleet status, repository status, and revision evidence;
- reuse the same registry and ledger snapshot semantics as the CLI;
- retain existing Shadowbill MCP tools as compatibility interfaces;
- expose projection version, source cursor, policy source, evidence references, coverage, and degraded states;
- add JSON and CSV exports after the report contracts settle.

Exit: CLI and MCP return equivalent projections for the same registry and ledger snapshot.

### Lane C — build the fleet-first dashboard

Owner issue: #43.

- replace the cost-first home view with enrolled repositories and evidence attention;
- show latest revision, current status, missing or stale required evidence, current failure, recent recovery, and source freshness;
- make every conclusion inspectable through its policy and source observations;
- isolate repository and panel failures;
- preserve repository, revision, range, timezone, and view state in the URL;
- keep Shadowbill estimates as a secondary view.

Exit: one screen answers what changed, what is failing, what is stale, and which repository needs attention.

### Lane D — close core v1 follow-up debt

- extend `proofwake doctor` with registry, policy, dual-data-path, and adapter-readiness checks;
- add CloudEvents-compatible JSONL export fixtures;
- add declared artifact references and external log references to local command receipts;
- cover the child-completed-before-ledger-acknowledgement crash window;
- define an explicit data migration command and release policy;
- publish the first tagged Proofwake release.

### Lane E — normalise existing Git and GitHub observations

- map existing local Git and signed GitHub events into observation v1;
- preserve retained-code estimates as an optional measurement;
- model workflow attempts and reruns consistently;
- distinguish live and backfilled coverage;
- add bounded historical backfill;
- export CDEvents where the mapping is exact.

## Milestone status

### Milestone 0 — identity and compatibility

Status: operational baseline delivered; release and explicit migration remain.

Delivered:

- Proofwake package and CLI identity;
- Shadowbill binary and environment aliases;
- deterministic new-versus-legacy data-path selection;
- refusal of ambiguous dual implicit ledgers;
- Proofwake-first extension, dashboard, help, examples, and documentation;
- read-only identity and path inspection.

Remaining:

- explicit restart-safe data migration;
- alias support horizon;
- first tagged release and release notes.

### Milestone 1 — observation envelope and strict emitter

Status: core v1 delivered.

Delivered:

- CloudEvents-compatible observation envelope;
- time, repository, revision, relationship, trust, disclosure, coverage, evidence, and adapter contracts;
- strict bounds, UTF-8, duplicate-key, unknown-field, depth, and non-finite-number rejection;
- canonical semantic fingerprints;
- source-scoped replay and conflicting-identity rejection;
- `proofwake emit` with stable human and JSON output;
- adversarial parser and file-boundary coverage.

Remaining:

- export fixtures and broader standards round trips;
- migration mappings for every legacy event family.

### Milestone 2 — repository enrolment and fleet inventory

Status: core v1 delivered.

Delivered:

- repository policy v1 and JSON Schema;
- remote and privacy-preserving local identities;
- active and dormant lifecycle intent;
- expected signals, applicability, freshness, accepted sources, and receipt adapters;
- committed and explicitly approved global policy sources;
- dry-run-first enrolment and reviewed registry mutation;
- policy-aware inventory with degraded repositories preserved.

Remaining:

- registry checks in `proofwake doctor`;
- polished migration and recovery guidance for registry changes.

### Milestone 3 — local command receipts

Status: useful v1 delivered.

Delivered:

- shell-free argument-vector execution;
- exact starting-revision and repository binding;
- bounded stdout and stderr accounting with raw-output exclusion;
- passing, warning, failure, timeout, cancellation, output-limit, signal, and spawn-failure receipts;
- dirty-worktree, detached-HEAD, changed-revision, and post-inspection caveats;
- stable run IDs for retry after response loss;
- child exit preservation and machine-output isolation.

Remaining:

- declared artifact references;
- external log references;
- concurrent same-ID reservation;
- process-group termination where supported;
- crash recovery between child completion and ledger acknowledgement.

### Milestone 4 — Git and GitHub normalisation

Status: legacy collection works; observation-v1 normalisation remains.

### Milestone 5 — revision evidence projection

Status: projection v1 delivered.

Delivered:

- per-revision expected-signal matrices;
- passing, failing, missing, stale, partial, unavailable, warning, and selector-unavailable states;
- green, red, yellow, and grey repository status;
- exact source observations, evidence references, coverage, trust, policy, and bounded history;
- same-revision rerun recovery and verified descendant recovery;
- deterministic registry-and-ledger snapshots, ordering, projection version, and source cursors;
- panel-local degradation and score-free fleet attention.

Remaining:

- historical default-branch membership;
- deployed-revision, release, host, service, and deployment selectors;
- richer provider lineage, rename, transfer, force-push, and shallow-history behaviour;
- persistent projection caches when scale requires them.

### Milestone 6 — first native adapter: Renderprove

Status: in progress in #63.

### Milestone 7 — fleet dashboard and read-only MCP

Status: next active product milestone.

### Milestone 8 — ecosystem adapters and exports

Status: later, after the fleet interface proves useful.

Candidates:

- SmolRunner doctor, plan, and execution receipt summaries;
- Starsector Preflight and other domain receipts;
- SLSA and in-toto provenance;
- OpenLineage-style run import;
- OTLP and CDEvents export;
- optional Backstage and Apache DevLake integrations;
- Stensibly evidence-reference integration.

### Milestone 9 — Shadowbill observation family

Status: maintained as an optional bounded module.

- label every number as visible activity, API-equivalent estimate, or delivered-work indicator;
- preserve versioned pricing and calibration assumptions;
- support complete disablement without reducing fleet evidence functionality;
- keep provider-internal cost and billing claims outside the product.

## Recommended next three pull requests

1. Finish and merge the Renderprove receipt adapter in #63.
2. Add Proofwake-native read-only MCP tools for fleet, repository, and revision projections.
3. Add a fleet-first dashboard baseline backed by the same projection output.

Doctor/export debt and Git/GitHub normalisation can proceed beside these three when they touch separate files.

## Product quality bar

Every adapter and user-facing feature must include:

- an exact authority and trust boundary;
- a versioned schema and explicit maximum sizes;
- privacy, disclosure, and retention behaviour;
- idempotency and conflict behaviour;
- stable machine-readable failures;
- source coverage and freshness;
- visible passing, failing, missing, stale, partial, and unavailable states where relevant;
- local degraded behaviour;
- fixtures from a real or sanitised producer;
- focused regression coverage;
- a future schema migration path.

## Boundaries before the first stable release

Proofwake stays away from:

- hosted public multi-tenancy;
- arbitrary log ingestion;
- distributed tracing storage;
- generic metrics storage;
- automated remediation;
- CI scheduling;
- task management;
- agent orchestration;
- employee or repository productivity scoring;
- a universal DORA suite;
- a new provenance or event standard;
- raw prompt, response, source, log, secret, or environment storage.
