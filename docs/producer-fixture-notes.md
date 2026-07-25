# Producer fixture notes for observation v1

This document records constraints discovered while selecting the first real inputs for the Proofwake observation envelope. It supports issue #38 and the [five-repository pilot](five-repository-pilot.md).

The fixtures live under `test/fixtures/producers/`. They represent producer contracts before Proofwake mapping. They are not accepted Proofwake observations and should not freeze the v1 envelope by example alone.

## Renderprove receipt v1

Source contract:

- `teamleaderleo/renderprove/schema/receipt-v1.schema.json`;
- strict JSON Schema with `additionalProperties: false` at the main object boundaries;
- top-level review result, bounded case identities, navigation and page facts, screenshot references and SHA-256 digests, and timestamped diagnostics.

Fixture:

- `test/fixtures/producers/renderprove/receipt-passed-v1.json`.

### Fields worth retaining

A Proofwake adapter can retain bounded mappings of:

- receipt schema identifier and version;
- producer identity and adapter version;
- project identity;
- review start, finish, and duration;
- overall and per-case status;
- stable case ID, route identity, viewport identity, and navigation status;
- page measurement counts;
- artifact media type and digest;
- diagnostic count and diagnostic kind;
- receipt digest and verification result;
- redaction, truncation, and disclosure decisions made by the adapter.

### Fields requiring classification or exclusion

- base, requested, and final URLs may expose private hosts, paths, queries, or deployment identity;
- page titles and diagnostic messages are content-bearing free text;
- screenshot paths may expose local layout even when project-relative;
- local runtime command and working directory may disclose executable arguments and local paths;
- screenshot bytes belong outside the observation ledger.

The first adapter should omit diagnostic messages, page titles, runtime commands, working directories, and raw URLs from the common observation data. It may emit classified references or normalized route identities under an explicit private-metadata policy.

### Missing revision binding

Receipt v1 contains a project identity and manifest provenance, but it does not contain a repository identity or commit revision.

Proofwake therefore cannot claim that a receipt is revision-bound from the receipt alone. One of these contracts is needed:

1. Renderprove receipt v2 includes canonical repository and full revision identity;
2. Renderprove emits a signed or digest-bound sidecar with repository and revision;
3. Proofwake ingests the receipt from an enrolled checkout and records a separate local-operator observation that binds the verified receipt digest to the checkout revision;
4. a trusted runner supplies an explicit execution receipt binding artifact digest, repository, and revision.

Option 3 is suitable for the first local pilot if the trust class states that the binding comes from the local operator. A later Renderprove or SmolRunner receipt should provide stronger portable binding.

## SmolRunner doctor report v1

Source contract:

- `schema_version`;
- aggregate `overall` state;
- an array of checks with stable IDs, state, summary, and optional detail;
- check states serialize as `pass`, `warn`, or `fail`.

Fixture:

- `test/fixtures/producers/smolrunner/doctor-warning-v1.json`.

### Fields worth retaining

A Proofwake adapter can retain bounded mappings of:

- report schema version;
- producer and adapter version;
- overall state;
- stable check ID and check state;
- observation time and ingestion time;
- declared host identity class when configured;
- report digest and verification result;
- source coverage and unavailable checks.

### Free-text boundary

SmolRunner summaries and details may contain operating-system labels, executable paths, host facts, or future diagnostics. The common Proofwake observation should treat these strings as content-bearing producer output.

The first adapter should map known check IDs and states while discarding summary and detail text. A classified external evidence reference may point to the complete local report when the operator chooses to retain it.

### Host subject

A doctor report describes a host, not a repository revision. The v1 observation envelope therefore needs a subject model broader than `repo:owner/name@sha:...`.

At minimum, the subject model should support:

- repository revision;
- repository without a selected revision;
- host or runner installation;
- deployment or service;
- run or workflow attempt;
- artifact or evidence receipt.

Repository policy may use a fresh host observation as supporting coverage for a repository, but the host observation itself should keep its native subject. The projection must name the policy relationship that makes it relevant.

## Consequences for the v1 envelope

### Keep the common envelope small

The common data object should carry:

- producer and schema identity;
- native subject and explicit repository/revision relationships when present;
- source, observed, and ingestion times;
- projection kind and bounded status;
- trust and disclosure classes;
- evidence references and digests;
- adapter mapping version;
- redaction, truncation, and source-coverage state.

Producer-specific details should live in a versioned, bounded extension object only when a projection or audit path needs them.

### Separate source validation from semantic mapping

The adapter pipeline should expose distinct outcomes for:

1. source file or input could not be opened safely;
2. source bytes exceeded bounds;
3. producer schema was unsupported or invalid;
4. receipt digest changed during read;
5. source was valid but lacked required binding context;
6. source was valid and mapped to one or more accepted observations;
7. accepted event identity conflicted with a prior fingerprint.

A valid producer report that contains a failing status remains a successfully verified source observation.

### Require adapter-owned allowlists

Proofwake should never copy a producer object into `data` wholesale. Each adapter needs an explicit field mapping, per-field disclosure class, maximum size, and behaviour for unsupported values.

The Renderprove and SmolRunner fixtures provide the first test that two unlike producers can fit the same envelope while keeping different native subjects and privacy boundaries.

## Immediate implementation slice

1. Add draft Proofwake observation fixtures produced from both source fixtures.
2. Define the subject union and explicit relationship fields.
3. Define adapter mapping version and source-schema identity.
4. Define stable validation and mapping failure codes.
5. Add tests proving free-text producer fields cannot enter the common observation data.
6. Add duplicate replay and conflicting-identity fixtures for both mapped observations.
