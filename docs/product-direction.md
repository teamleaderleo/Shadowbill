# Product direction

## One-sentence definition

**Proofwake is a local evidence index for software projects.**

It collects content-minimised observations from the tools that already build, test, review, deploy, and inspect software, then organises those observations by repository and revision.

The primary question is:

> What evidence currently exists for this revision, what failed, what recovered, and what remains unobserved?

## Why this exists

A software revision leaves evidence in many places:

- a local test command;
- a Git commit;
- a pull request and review;
- a CI workflow;
- a browser review receipt;
- a deployment status;
- a host or runner diagnostic;
- a benchmark or domain-specific probe;
- an artifact attestation;
- an optional AI-usage estimate.

Each tool usually presents its own slice. A developer working across many unlike repositories has no compact answer to:

1. What changed recently?
2. Which revisions have convincing evidence?
3. What is failing, stale, or silent?
4. What recovered after a failure?
5. Which project deserves attention next, and which observation supports that conclusion?

Proofwake exists to answer those questions without becoming another CI scheduler, task manager, log warehouse, or remediation system.

## Intended users

### Solo developer with many repositories

The first user is a developer running a personal fleet of experiments, applications, infrastructure tools, and libraries. The repositories use different languages and verification paths. Some run only locally, some use GitHub Actions, and some emit specialised receipts.

Proofwake gives that developer one trustworthy view without requiring an enterprise platform.

### Small team with heterogeneous tooling

A small team may want revision evidence and recovery history across GitHub, local development, self-hosted runners, browser reviews, deployments, and domain probes without adopting a large engineering-intelligence product.

### Platform or reliability team needing an evidence index

A larger organisation may already run OpenTelemetry, a data platform, a developer portal, and an incident system. Proofwake can remain useful as a focused evidence projection and export its observations into those systems.

## Product thesis

Proofwake should be the quiet witness across a project fleet:

- local-first;
- append-only at the observation boundary;
- content-minimised by default;
- explicit about source coverage and freshness;
- organised around repositories, revisions, runs, and evidence;
- read-heavy and non-authoritative;
- standards-native rather than schema-isolated.

Its value comes from the projection and interpretation of evidence, not from owning every source event or replacing mature telemetry infrastructure.

## What Proofwake owns

Proofwake owns five product responsibilities:

1. **Repository enrolment** — which projects are in the fleet and which signals they expect.
2. **Observation ingestion** — strict, bounded, idempotent receipt collection.
3. **Evidence indexing** — references and digests tied to repositories, revisions, runs, and declared relationships.
4. **Revision projections** — which expected signals exist, failed, recovered, became stale, or remain missing.
5. **Fleet views** — recent change, evidence coverage, recovery, staleness, and attention guidance.

## What Proofwake does not own

Proofwake does not:

- assign work or responsibility;
- hold authoritative claims, approvals, or leases;
- schedule CI or operate runners;
- deploy software;
- execute remediation;
- replace project-specific diagnostics;
- collect arbitrary logs or source payloads;
- infer causality from timestamp proximity;
- rank developers by commits, lines, hours, or activity;
- claim that passing observations prove universal correctness;
- claim provider cost or inaccessible internal token usage.

## Relationship with neighbouring projects

### Stensibly

Stensibly owns coordination decisions: work items, claims, blockers, next actions, runs, and authoritative transitions.

Proofwake records observations. A passing test receipt is evidence; Stensibly decides whether that evidence satisfies a work item or permits a transition.

### SmolRunner

SmolRunner owns runner and host desired state, diagnostics, reconciliation, and execution isolation.

Proofwake ingests bounded SmolRunner reports and receipts. It never manages the host.

### Renderprove

Renderprove owns browser evidence: screenshots, page facts, navigation results, diagnostics, and policy outcomes.

Proofwake indexes Renderprove receipts by revision and exposes their coverage and freshness.

### Domain-specific tools

Tools such as Starsector Preflight remain authoritative for their own measurements and evidence contracts. Proofwake records bounded summaries and references instead of copying their implementation or raw outputs.

### Shadowbill

The original Shadowbill compute reckoner remains a useful optional observation family. It estimates visible AI activity under explicit pricing and calibration assumptions.

AI usage showback must not define the entire product. Proofwake should remain useful when the Shadowbill adapter is disabled.

## Standards position

Proofwake should adopt existing standards before adding proprietary fields:

- **CloudEvents** for common event identity and source metadata;
- **CDEvents** for CI/CD lifecycle events where its vocabulary fits;
- **OpenTelemetry semantic conventions** for compatible CI/CD and VCS attributes;
- **SLSA and in-toto** as provenance inputs, never as formats to replace;
- **OpenLineage-style run, job, input, output, and facet concepts** where they clarify receipt relationships.

Proofwake-specific concepts should live under an explicit `proofwake.*` extension namespace.

## Language discipline

Proofwake deals in observations and evidence, not absolute proof.

Prefer:

- observed passing;
- evidence present;
- expected signal missing;
- receipt verified;
- source coverage incomplete;
- no observation received;
- recovery observed.

Avoid:

- proven correct;
- safe because CI passed;
- no failure occurred;
- developer productivity score;
- exact provider cost;
- causal attribution inferred only from time.

## Representative workflows

### Local verification

```text
commit abc123
  -> proofwake run --kind verify -- npm test
  -> receipt records command identity, revision, duration, and exit class
  -> revision abc123 gains local verification evidence
```

### Pull request to browser review

```text
GitHub PR event
  -> CI workflow completion
  -> Renderprove receipt
  -> deployment observation
  -> Proofwake shows one revision evidence timeline
```

### Failure and recovery

```text
workflow failed
  -> same revision rerun failed
  -> correction committed
  -> new revision passed
  -> Proofwake records the failure class and recovery interval
```

### Coordination handoff

```text
Proofwake detects missing required browser evidence
  -> exports an evidence reference or observation to Stensibly
  -> Stensibly creates or updates the coordinated work
```

## Product success test

The first milestone succeeds after five unlike repositories are enrolled and one command or dashboard can answer:

1. What changed recently?
2. What is the latest known revision for each repository?
3. Which expected evidence exists for those revisions?
4. Which signal is failing, stale, or missing?
5. Which failure recovered and how long did recovery take?
6. Which repository needs attention next, and what source observation supports that recommendation?

The answer must disclose source coverage and remain useful with AI-cost collection disabled.

## Open-source position

Proofwake should remain open source.

The software inspects developer and project activity. Users should be able to inspect exactly what is collected, what is discarded, how identities are correlated, and how health conclusions are calculated. An open implementation also makes adapters and event contracts easier to trust and extend.

The project uses the Apache License, Version 2.0. The permissive grant and explicit patent terms fit a tool intended for personal, commercial, and platform integration use.
