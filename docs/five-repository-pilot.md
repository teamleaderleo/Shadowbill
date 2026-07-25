# Five-repository pilot

## Purpose

Proofwake's first product test should use real repositories before the observation envelope, repository policy, projections, or dashboard become expensive to change.

The pilot answers one practical question:

> Can Proofwake explain the current evidence state of five unlike repositories from bounded observations, while naming every coverage gap and source assumption?

This document selects the initial fleet, defines a small shared signal vocabulary, and sequences the work behind issues #38 through #43.

## Selected fleet

### 1. `teamleaderleo/proofwake`

Role in the pilot: self-observation and migration safety.

Why it belongs:

- Node.js CLI, HTTP service, browser extension, MCP server, and append-only local ledger;
- existing local tests, Git observations, GitHub webhooks, and optional Shadowbill estimates;
- immediate pressure on compatibility, privacy, and deterministic rebuild behaviour.

Initial expected signals:

- required `verify`: `npm test`;
- required `github-ci`: the repository's primary GitHub Actions result;
- optional `local-diagnostic`: `proofwake doctor --json`;
- optional `shadowbill-estimate`: existing estimate observations, excluded from fleet health.

### 2. `teamleaderleo/renderprove`

Role in the pilot: first native external evidence receipt.

Why it belongs:

- strict, versioned browser-review receipts with artifact digests;
- local and deployed-origin review modes;
- a clear distinction between receipt verification failure and a valid receipt reporting policy failure.

Initial expected signals:

- required `verify`: package tests and locked checks;
- required `browser-review`: a valid Renderprove receipt for the selected revision;
- optional `renderer-probe`: the pinned Podman probe on the trusted Linux worker;
- optional `github-ci`: GitHub Actions result.

### 3. `teamleaderleo/smolrunner`

Role in the pilot: Rust repository and host-diagnostic producer.

Why it belongs:

- a different language and toolchain;
- deterministic human and JSON reports;
- typed host observations that already distinguish present, absent, and unknown;
- future execution receipts with explicit ownership and authorization boundaries.

Initial expected signals:

- required `verify`: locked formatting, Clippy, and test suite result;
- required `domain-check`: reference manifest planning fixtures;
- optional `host-diagnostic`: bounded `doctor` or `host plan` report;
- optional `github-ci`: GitHub Actions result.

### 4. `teamleaderleo/stensibly`

Role in the pilot: hosted application and downstream coordination consumer.

Why it belongs:

- Bun/TypeScript application with local and hosted modes;
- REST, remote MCP, Convex, Cloudflare Worker, and Vercel surfaces;
- a natural consumer for Proofwake evidence references without making Proofwake authoritative for work state.

Initial expected signals:

- required `verify`: repository test and build gate;
- required `deployment`: production deployment observation;
- required `service-check`: the read-only hosted verification result;
- optional `browser-review`: Renderprove receipt for the public dashboard;
- optional `github-ci`: GitHub Actions result.

### 5. `teamleaderleo/one-more-legend`

Role in the pilot: deterministic domain checks plus browser and MCP deployment evidence.

Why it belongs:

- deterministic TypeScript game engine and committed browser build;
- simulation-band checks with meaningful domain failure;
- static web deployment and stateless MCP endpoint from one repository;
- a compact application where revision evidence can be inspected end to end.

Initial expected signals:

- required `verify`: `npm test`;
- required `domain-check`: `npm run sim:bands`;
- required `deployment`: Vercel deployment observation;
- optional `browser-review`: Renderprove review of the game surface;
- optional `service-check`: MCP initialization and a bounded read-only probe.

## Signal vocabulary for the pilot

The observation envelope should preserve producer-specific event types while mapping them into a deliberately small projection vocabulary:

| Projection kind | Meaning | Example producers |
| --- | --- | --- |
| `verify` | General repository test or build gate | npm, Bun, Cargo |
| `github-ci` | Provider-observed workflow/check result | GitHub |
| `browser-review` | Browser policy receipt bound to a revision | Renderprove |
| `deployment` | Deployment or release state | GitHub, Vercel adapter |
| `service-check` | Bounded live-service verification | Stensibly verifier, MCP probe |
| `domain-check` | Project-specific deterministic acceptance gate | SmolRunner plan fixtures, simulation bands |
| `host-diagnostic` | Bounded machine or runner observation | SmolRunner |
| `local-diagnostic` | Read-only local installation report | Proofwake doctor |
| `shadowbill-estimate` | Optional usage estimate family | Shadowbill adapter |

These names are projection categories, not replacements for CloudEvents, CDEvents, OpenTelemetry attributes, or producer-native event identity.

## Policy rules

Each repository policy should declare:

- canonical repository identity and local root source;
- required and optional signal kinds;
- staleness window per signal;
- adapter source and configuration source;
- whether a signal applies to every revision, default-branch revisions, releases, or deployed revisions;
- the exact observation classes allowed to satisfy it;
- approval state for autodetected configuration.

The pilot should avoid one global staleness number. A local test may become stale as soon as the revision changes, while a host diagnostic or scheduled service check may remain useful for a declared number of hours.

## Delivery sequence

### Stage A — capture fixtures before freezing v1

For each repository, collect representative sanitized fixtures for:

- passing evidence;
- terminal failing evidence;
- missing evidence;
- stale evidence;
- duplicate delivery;
- conflicting identity reuse;
- one recovery sequence;
- one unavailable or degraded adapter.

Use these fixtures to finish issue #38. The schema should be tested against actual producer outputs before it becomes the implementation contract.

### Stage B — strict emit and enrolment

Implement the smallest useful slice of issue #39:

1. `proofwake emit --json FILE` and `proofwake emit --stdin`;
2. canonical fingerprinting and idempotency conflict handling;
3. `.proofwake.json` version 1 plus an approved global-registry entry;
4. `proofwake enroll` and `proofwake repositories`;
5. source and policy provenance in every repository classification.

At the end of this stage, all five repositories should be enrolled even when several signals still arrive through hand-authored fixtures.

### Stage C — local command receipts

Implement issue #40 and replace the hand-authored `verify` and `domain-check` fixtures with bounded command receipts.

The first command matrix should cover:

- Node: Proofwake and Renderprove;
- Rust: SmolRunner;
- Bun/TypeScript: Stensibly;
- deterministic simulation: One More Legend.

### Stage D — GitHub normalization and projections

Normalize Git, pull-request, workflow, and deployment observations, then implement issue #41.

The first fleet report must distinguish:

- passing evidence;
- failing evidence;
- missing expected evidence;
- stale evidence;
- unavailable adapters;
- dormant repositories;
- partial source coverage.

Every status and attention reason must return the policy and exact source observations that produced it.

### Stage E — native receipts and fleet UI

Implement the Renderprove adapter in issue #42. Build the fleet-first dashboard and read-only reports in issue #43 only after the command-line fleet projection works across the pilot.

The dashboard should visualize an existing projection contract. It should avoid becoming the place where status rules are invented.

## Acceptance scenarios

The pilot succeeds when one CLI command and one machine-readable report can answer:

1. What is the latest known revision for each repository?
2. Which required and optional signals apply to that revision?
3. Which observations currently satisfy those signals?
4. Which signal is failing, missing, stale, partial, or unavailable?
5. Which failure later recovered, and what explicit relationship supports that conclusion?
6. Which repository deserves attention first, and which policy and observations support that recommendation?
7. What source coverage is absent from the answer?

A useful demonstration should include these deliberate states at the same time:

- one green repository;
- one repository with a failing required signal;
- one repository missing a required signal;
- one repository with a stale adapter;
- one dormant or intentionally unobserved repository;
- one observed recovery sequence.

## Decisions to defer

The pilot does not require:

- hosted public multi-tenancy;
- generic log, metric, or trace storage;
- automated remediation or work assignment;
- a universal repository score;
- a broad adapter marketplace;
- SQLite as the authoritative observation store;
- Backstage, DevLake, or OTLP integration;
- complete Shadowbill renaming before the evidence path works.

Compatibility work should still give new users Proofwake-first names and preserve existing Shadowbill installations. Large data migration and branding changes should stay separate from the observation-contract and pilot work so failures remain easy to diagnose.

## Recommended immediate next change

Finish the normative v1 observation contract with fixtures from Renderprove and SmolRunner first. They are unlike producers with existing bounded JSON outputs and strong trust boundaries. Once both fit one envelope without losing their native meaning, implement strict `emit` and enrol these five repositories.