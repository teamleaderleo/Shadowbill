# Proofwake observation v1

## Status

This document defines the first executable observation contract for Proofwake. The JSON Schema lives at `schema/observation-v1.schema.json`; the zero-dependency reference parser and validator live at `src/observation.js`.

The JavaScript validator is authoritative for rules JSON Schema cannot express, including duplicate-key rejection, byte and depth limits, timestamp ordering, subject/relationship agreement, coverage consistency, and canonical fingerprinting.

## Purpose

An observation is one bounded statement from one declared source. It records what that source observed, how the source is trusted, which project subject it concerns, which evidence references support it, and which information was excluded.

An observation never becomes a universal correctness claim. A passing browser receipt reports that one declared review passed. A warning host diagnostic reports what one host probe observed. Repository policy and revision projections interpret those observations later.

## CloudEvents mapping

Observation v1 uses the CloudEvents 1.0 JSON event attributes:

- `specversion` — always `1.0`;
- `id` — stable within the declared `source` namespace;
- `source` — adapter or provider URI;
- `type` — producer-compatible event type or `dev.proofwake.observation.<kind>.v1`;
- `subject` — canonical Proofwake subject string;
- `time` — source time;
- `dataschema` — `urn:proofwake:schema:observation:v1`;
- `data` — the bounded Proofwake observation body.

CDEvents and OpenTelemetry mappings belong in adapters. The common envelope preserves their source type and identifiers without claiming every event is natively a CDEvent or span.

## Identity and duplicate delivery

The pair `(source, id)` is the observation identity.

Preferred identity order:

1. verified provider delivery or event identity;
2. verified source receipt identity or digest;
3. deterministic identity derived from the complete mapped semantic payload;
4. generated local identity when the source exposes none.

Proofwake computes a canonical SHA-256 request fingerprint after validation. Object keys are sorted recursively. Array order remains significant. `data.ingestedAt` is excluded so replaying the same accepted source observation later retains the same fingerprint.

Ingestion behaviour:

- absent identity: append the accepted observation and fingerprint;
- existing identity with the same fingerprint: return the original accepted effect;
- existing identity with a different fingerprint: reject with `OBSERVATION_ID_CONFLICT`;
- similar timestamps, subjects, facts, or evidence digests never create heuristic deduplication.

## Time

Three times remain separate:

- `time` — when the producer or provider says the event occurred;
- `data.observedAt` — when the adapter observed the source;
- `data.ingestedAt` — when Proofwake accepted the observation.

`data.timeSource` declares whether `time` came from the producer, provider, or adapter. Every timestamp uses canonical UTC ISO 8601 with milliseconds. `observedAt` cannot precede `time`; `ingestedAt` cannot precede `observedAt`.

Wall-clock proximity establishes no causation or recovery relationship.

## Subjects

Supported subjects are:

- `repo:OWNER/NAME@sha:FULL40HEX` — one exact repository revision;
- `repo:OWNER/NAME` — a repository without a selected revision;
- `host:IDENTITY` — a host or runner installation;
- `service:IDENTITY` — a live service;
- `deployment:IDENTITY` — a deployment;
- `run:IDENTITY` — an explicit run or workflow attempt;
- `artifact:sha256:DIGEST` — an artifact or receipt.

Repository-revision subjects require matching `data.relationships.repository` and `data.relationships.revision`. Repository subjects require a matching repository relationship. Host and service observations may relate to repositories through declared policy while preserving their native subject.

## Adapter declaration

`data.adapter` records:

- adapter name and version;
- adapter mapping version;
- trust class;
- producer source schema identity and version.

Trust classes are:

- `local-operator`;
- `signed-provider`;
- `verified-receipt`;
- `authenticated-client`;
- `untrusted-observation`.

Trust affects interpretation and downstream authority. It never upgrades an observation into a coordination decision.

## Projection kind and status

The initial kinds are:

- `verify`;
- `github-ci`;
- `browser-review`;
- `deployment`;
- `service-check`;
- `domain-check`;
- `host-diagnostic`;
- `local-diagnostic`;
- `shadowbill-estimate`.

Statuses are `passed`, `failed`, `warning`, `unknown`, `unavailable`, and `cancelled`.

A valid source receipt that reports failure maps to a valid observation with status `failed`. Receipt verification failure is an adapter failure and must remain distinct.

## Relationships

`data.relationships` may contain explicit repository, revision, run, workflow attempt, deployment, service, causation, and correlation identities.

Relationships come from source evidence or declared local binding. Timestamp proximity creates none. A revision always requires a repository. Correlation identities are bounded, unique tokens and carry no causal meaning by themselves.

## Facts

`data.facts` is a bounded list of unique namespaced scalar facts.

Fact names use lowercase dotted identifiers such as:

- `renderprove.summary.cases`;
- `renderprove.case.home-desktop.status`;
- `smolrunner.check.systemd`.

Values may be booleans, safe integers, or short tokens without whitespace, URI separators, or shell syntax. Facts cannot carry prose, URLs, file paths, commands, logs, prompts, responses, diagnostic messages, page titles, or environment values.

Each adapter owns an explicit fact allowlist. Passing the common validator alone never authorizes copying arbitrary producer fields.

## Evidence references

`data.evidence` contains at most sixteen references. Each reference declares:

- absolute URI;
- SHA-256 digest;
- optional byte size;
- media type;
- producer and schema identity;
- verification state;
- disclosure class.

Evidence bytes remain outside the observation ledger. Disclosure classes are `public-metadata`, `private-metadata`, `restricted-reference`, and `content-excluded`.

## Coverage

`data.coverage` declares `complete`, `partial`, or `unavailable` coverage, plus redaction and truncation flags and namespaced omission identifiers.

Complete coverage cannot list omissions. Redacted and truncated observations must name the corresponding omitted classes. Coverage reports what the adapter mapped, not whether every possible external source exists.

## Bounds

The executable parser enforces:

- UTF-8 JSON input represented as a JavaScript string;
- maximum 65,536 bytes;
- maximum nesting depth 16;
- duplicate-key rejection at every object level;
- ordinary JSON numbers only;
- exact field allowlists;
- at most 64 facts, 16 evidence references, 16 omissions, 8 correlations;
- field-specific string and integer limits.

Unknown fields fail closed. Future fields require a new schema or mapping version.

## Stable validation codes

The reference implementation currently emits:

- `OBSERVATION_INVALID_JSON`;
- `OBSERVATION_TOO_LARGE`;
- `OBSERVATION_TOO_DEEP`;
- `OBSERVATION_DUPLICATE_KEY`;
- `OBSERVATION_INVALID_TYPE`;
- `OBSERVATION_UNKNOWN_FIELD`;
- `OBSERVATION_MISSING_FIELD`;
- `OBSERVATION_INVALID_LENGTH`;
- `OBSERVATION_INVALID_VALUE`;
- `OBSERVATION_INVALID_TIMESTAMP`;
- `OBSERVATION_INVALID_SUBJECT`;
- `OBSERVATION_DUPLICATE_VALUE`;
- `OBSERVATION_RELATIONSHIP_CONFLICT`;
- `OBSERVATION_TIME_CONFLICT`;
- `OBSERVATION_COVERAGE_CONFLICT`.

Ingestion adds `OBSERVATION_ID_CONFLICT` when the same identity is reused with a different semantic fingerprint.

## Producer fixture mappings

### Renderprove receipt v1

The pilot mapping retains receipt schema/version, bounded status and counts, case identity and state, navigation boolean, duration, receipt digest, and disclosure decisions.

It excludes base/request/final URLs, page titles, diagnostic messages, runtime commands, working directories, screenshot paths, and screenshot bytes. Because Renderprove receipt v1 lacks repository and revision identity, the pilot fixture uses an explicit `local-operator` binding to an enrolled checkout revision.

### SmolRunner doctor v1

The pilot mapping retains report schema version, overall state, stable check IDs and states, host subject, report digest, and coverage.

It excludes check summaries, details, executable paths, operating-system prose, and other producer text. The host remains the subject even when repository policy later uses that observation as supporting evidence.

## Evolution

Observation v1 is strict. Compatible adapters may add new producer mappings through a new `mappingVersion` while preserving this envelope. New common fields, kinds, statuses, subject forms, or fact value classes require a reviewed schema revision.

Historical observations remain immutable. Projections declare their own version and rebuild from the ledger.
