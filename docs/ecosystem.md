# Ecosystem and build-versus-integrate decisions

Proofwake sits near several mature tool categories. This document records what should be reused, what should be integrated, and why the project still deserves an independent core.

## Decision summary

Proofwake should remain an independent local tool, but it must avoid recreating generic telemetry infrastructure.

Its independent value is narrow:

> Build a revision-centred evidence projection across unlike project tools, then expose fleet status, missing evidence, failures, recovery, and source coverage.

Everything else should use existing standards or become an adapter.

## OpenTelemetry

OpenTelemetry provides a vendor-neutral telemetry model, SDKs, semantic conventions, and a Collector with receivers, processors, and exporters.

Relevant existing work includes semantic conventions for:

- version-control systems;
- CI/CD pipelines and tasks;
- status and error classification;
- duration and run metrics.

### Adopt

- compatible attribute names;
- OTLP export;
- Collector integration for organisations that already operate it;
- trace-compatible run relationships where useful.

### Do not recreate

- general traces, logs, and metrics transport;
- an agent SDK ecosystem;
- a full telemetry collector pipeline;
- a general-purpose observability backend.

### Why Proofwake remains useful

OpenTelemetry transports and describes telemetry. It does not provide Proofwake’s repository enrolment, revision evidence policy, missing-signal projection, or local fleet attention view.

References:

- https://opentelemetry.io/docs/collector/
- https://opentelemetry.io/docs/specs/semconv/cicd/
- https://opentelemetry.io/docs/specs/semconv/registry/attributes/vcs/

## CloudEvents

CloudEvents defines a common event envelope with fields such as event ID, source, type, time, subject, and data schema.

### Adopt

- the common event envelope;
- `source + id` duplicate identity semantics;
- standard content modes and JSON representation;
- extension attributes only when required.

### Do not recreate

- another top-level event envelope with different names for the same concepts.

### Proofwake extension

Proofwake-specific evidence, disclosure, coverage, and repository-policy concepts should live in the data schema or a namespaced extension.

Reference:

- https://github.com/cloudevents/spec

## CDEvents

CDEvents defines common events across source control, continuous integration, tests, deployment, operations, tickets, and pipeline orchestration. It is built on CloudEvents.

### Adopt

- event types and subject models where they match GitHub, CI, test, and deployment observations;
- import and export support;
- compatibility fixtures.

### Extend only where required

Proofwake still needs concepts such as:

- expected evidence policy;
- revision proof coverage;
- local receipt disclosure classes;
- source freshness and missing expected signals;
- attention recommendations grounded in observations.

Reference:

- https://cdevents.dev/docs/

## Apache DevLake

Apache DevLake ingests developer-tool data, normalises it, stores it, and supports engineering and DORA dashboards.

### Use DevLake instead when the primary goal is

- cross-repository GitHub or GitLab analytics;
- standard DORA metrics;
- team-level throughput dashboards;
- broad historical API ingestion;
- relational analysis through Grafana or SQL.

### Integrate

- export selected Proofwake observations;
- consider a plugin after the local event model stabilises;
- let DevLake handle broad engineering analytics.

### Why Proofwake remains separate

Proofwake targets one operator or a small project fleet, content-minimised observations, local command receipts, domain-specific evidence, and revision proof coverage. It should work without a database-and-Grafana platform and should avoid caching arbitrary raw provider responses.

Reference:

- https://devlake.apache.org/

## Backstage

Backstage provides a software catalogue and developer portal with repository-owned entity metadata and plugins.

### Integrate

- expose a Proofwake entity card or plugin;
- link a catalogue component to its latest revision evidence and current missing signals.

### Do not fold the core into Backstage

Proofwake should work for a solo developer without running a developer portal. Backstage is a presentation and catalogue integration, not the required local collector and ledger.

Reference:

- https://backstage.io/docs/

## Engineering-intelligence products

Commercial products such as LinearB, Swarmia, Datadog CI Visibility, and platform-native analytics already provide combinations of:

- pull-request flow;
- CI performance;
- DORA metrics;
- deployment tracking;
- team comparisons;
- custom engineering metrics.

### Do not compete on

- employee scoring;
- generic DORA dashboards;
- organisation-wide productivity rankings;
- another broad SaaS data connector catalogue.

### Proofwake distinction

Proofwake asks:

> What evidence exists across this unusual project fleet?

It should not ask:

> How productive is this engineering organisation?

## SLSA and in-toto

SLSA provenance and in-toto attestations provide authenticated supply-chain evidence about how artifacts were produced.

### Adopt

- ingest and index attestations;
- show provenance coverage by revision and artifact;
- preserve external signatures and verification results.

### Do not recreate

- another provenance statement format;
- another signing or attestation protocol.

References:

- https://slsa.dev/
- https://in-toto.io/

## OpenLineage

OpenLineage models jobs, runs, inputs, outputs, state transitions, and extensible facets for data pipelines.

### Borrow

- the clear split between job identity and run identity;
- input and output evidence relationships;
- additive facets;
- start and terminal run observations.

### Integrate selectively

OpenLineage import may be useful for data-oriented repositories. Proofwake should not pretend every software project is a data pipeline.

Reference:

- https://openlineage.io/

## Existing observability platforms

Grafana, Prometheus, Loki, Tempo, Jaeger, Datadog, Honeycomb, Elastic, Sentry, SkyWalking, and similar systems already handle runtime metrics, logs, traces, errors, and service health.

### Export or link

- emit compatible metrics or OTLP data;
- link to external traces, incidents, and dashboards;
- index evidence references and high-level outcomes.

### Do not ingest by default

- raw logs;
- arbitrary traces;
- full metric streams;
- production payloads.

Proofwake’s local ledger should stay bounded and understandable.

## Fold decisions for neighbouring repositories

### Stensibly

**Decision: separate, integrated.**

Stensibly owns authoritative coordination state. Proofwake owns observations and evidence projections.

A source event does not become an approval, completion, claim, or assignment merely because Proofwake accepted it.

Proofwake may export evidence references or missing-signal observations to Stensibly. Stensibly decides what coordinated action follows.

### SmolRunner

**Decision: separate, emitting adapter.**

SmolRunner owns host and runner state. It intentionally keeps its interface compact and avoids a mandatory dashboard or database.

SmolRunner should emit bounded diagnostic and execution receipts. Proofwake should never manage the machine.

### Renderprove

**Decision: separate, first native adapter.**

Renderprove owns browser review receipts. Proofwake indexes those receipts across repositories and revisions.

### Domain tools

**Decision: separate, narrow receipt adapters.**

Preflight, Quarry, calendars, simulations, and future experiments retain their own domain semantics. Proofwake ingests strict summaries and evidence references.

## Independent-project test

Proofwake deserves its own repository only while it satisfies all of these conditions:

1. It remains useful without a hosted control plane.
2. It can ingest unlike project evidence without owning those projects.
3. It provides a revision evidence projection that existing transport and analytics tools do not directly provide.
4. It remains content-minimised and locally inspectable.
5. It integrates with standards instead of replacing them.
6. It avoids task management, CI scheduling, remediation, and employee scoring.

If the project drifts into a generic telemetry store or engineering dashboard, fold the work into an existing open-source platform instead.

## Open-source and licensing decision

Proofwake should remain open source under Apache-2.0.

Reasons:

- telemetry collection needs inspectable privacy behaviour;
- users need to verify exactly what is retained and discarded;
- local and enterprise adapters benefit from permissive integration terms;
- explicit patent terms reduce uncertainty for contributors and adopters;
- the core can remain open even if optional hosted operations, support, or managed integrations exist later.

The repository should never use “source available” language for an Apache-2.0 core. If commercial offerings appear, distinguish the hosted service from the licensed project clearly.
