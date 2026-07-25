# Architecture

## System role

Proofwake is a local evidence index positioned between project-specific producers and optional downstream systems.

```text
Git / GitHub / CI / deployments
local command receipts
Renderprove / SmolRunner / domain tools
SLSA / in-toto / CDEvents / OTLP
optional Shadowbill estimates
                |
                v
       Proofwake ingestion boundary
                |
        append-only observation ledger
                |
   repository and revision projections
                |
 CLI / dashboard / MCP / export adapters
                |
   Stensibly / Backstage / DevLake / OTLP
```

Proofwake observes and projects. It does not become the authority for the systems above or below it.

## Architectural principles

1. **Content-minimised by default.** Store identifiers, counts, states, timings, digests, and evidence references. Exclude prompts, responses, source patches, arbitrary logs, secrets, and provider payloads.
2. **Strict at ingestion.** Every adapter has a versioned schema, size bounds, allowlisted fields, stable failure codes, and idempotency behaviour.
3. **Append observations; rebuild projections.** Source observations are durable. Fleet and revision views are derived and may be rebuilt.
4. **Authority stays with the producer.** A receipt reports what one source observed. Proofwake does not turn it into a broader correctness claim.
5. **Relationships are explicit.** Revision, run, workflow, deployment, causation, and correlation references come from source evidence. Timestamp proximity alone creates no relationship.
6. **Local operation first.** The first supported deployment is one operator, one local ledger, and optional loopback interfaces.
7. **Standards before extensions.** Reuse CloudEvents, CDEvents, OpenTelemetry conventions, and provenance formats where they fit.
8. **Useful under partial coverage.** Missing adapters and stale sources produce visible coverage gaps instead of hiding the whole report.

## Components

### 1. Repository registry

The registry identifies enrolled repositories and expected evidence policy.

A repository may commit `.proofwake.json` or use an explicitly approved global registry entry.

Example:

```json
{
  "version": 1,
  "repository": "owner/name",
  "staleAfterHours": 72,
  "expectedSignals": [
    { "kind": "verify", "required": true },
    { "kind": "browser-review", "required": false }
  ],
  "adapters": {
    "renderprove": ".renderprove/receipt.json"
  }
}
```

Autodiscovery may suggest a configuration. It must not silently make policy authoritative.

### 2. Ingestion boundary

Initial ingestion paths:

- `proofwake emit` for strict event JSON;
- `proofwake run` for local command receipts;
- signed GitHub webhooks;
- file-based receipt adapters;
- optional OTLP, CloudEvents, or CDEvents receivers later.

Each ingestion path must define:

- maximum request and field sizes;
- accepted content type and schema version;
- source identity and trust class;
- idempotency key construction;
- duplicate and conflicting-duplicate behaviour;
- redaction and truncation rules;
- stable success and failure codes;
- degraded-mode behaviour.

### 3. Observation ledger

The current JSONL ledger is a suitable first storage boundary because it is local, inspectable, append-oriented, and already has durable-write protections.

The long-term contract matters more than the storage engine:

- accepted observations are immutable;
- duplicate delivery is idempotent;
- conflicting reuse of an event identity fails;
- incomplete writes are detected and preserved for reviewed recovery;
- projections can be rebuilt from accepted observations;
- exports preserve schema and source identity.

A later SQLite projection or index may improve query performance without replacing the append-only source ledger.

### 4. Projection engine

The projection engine builds views for:

- repository inventory;
- latest observed revision;
- revision evidence matrix;
- expected signal coverage;
- source freshness;
- current failing signals;
- failure-to-recovery intervals;
- rerun lineage and flaky-outcome candidates;
- release and deployment observations;
- active and dormant repository classification;
- attention recommendations with evidence citations.

Projection status must state:

- source coverage;
- last ingestion time;
- latest source time;
- stale or partial adapters;
- schema or migration warnings;
- assumptions used by any heuristic.

### 5. Interfaces

#### CLI

Planned core commands:

```text
proofwake emit
proofwake run
proofwake enroll
proofwake status
proofwake inspect
proofwake fleet
proofwake export
proofwake doctor
```

#### Dashboard

The dashboard should focus on evidence coverage and attention rather than generic chart volume:

- fleet inventory;
- latest revision and age;
- required signal matrix;
- current failures and missing evidence;
- recovery history;
- per-repository evidence timeline;
- source coverage and freshness.

#### MCP

MCP should remain read-only by default and return bounded projections rather than raw ledger contents.

Useful tools:

- `proofwake_fleet_status`;
- `proofwake_repository_status`;
- `proofwake_revision_evidence`;
- `proofwake_recent_failures`;
- `proofwake_recovery_report`.

#### Exports

Support JSON, JSONL, CSV, CloudEvents/CDEvents-compatible output, and OTLP where practical.

## Observation envelope

Proofwake should use a CloudEvents-compatible envelope and add a bounded data object.

Conceptual example:

```json
{
  "specversion": "1.0",
  "id": "01J...",
  "source": "urn:proofwake:adapter:github",
  "type": "urn:cdevents:build:finished:supported-version",
  "time": "2026-07-25T14:32:27Z",
  "subject": "repo:owner/name@sha:abc123",
  "dataschema": "urn:proofwake:schema:observation:v1",
  "data": {
    "proofwakeSchemaVersion": 1,
    "adapter": {
      "name": "github",
      "version": "1.0.0",
      "trust": "signed-provider"
    },
    "repository": "owner/name",
    "revision": "abc123",
    "kind": "verify",
    "status": "passed",
    "durationMs": 42123,
    "correlation": {
      "workflowRunId": "12345",
      "pullRequest": 88
    },
    "evidence": [
      {
        "uri": "github://owner/name/actions/runs/12345",
        "digest": "sha256:...",
        "mediaType": "application/json",
        "disclosure": "metadata"
      }
    ],
    "redacted": false,
    "truncated": false,
    "ingestedAt": "2026-07-25T14:32:29Z"
  }
}
```

The exact v1 mapping must be designed and tested before implementation. The example establishes intent rather than a frozen schema.

## Identity and idempotency

An accepted observation needs stable identity.

Preferred order:

1. provider event or delivery ID with provider/source namespace;
2. source receipt ID or content digest;
3. deterministic ID derived from a complete canonical semantic payload;
4. generated local ID only when the source offers no stable identity.

The ledger stores the event identity and a request fingerprint.

- identical duplicate: return the original accepted result;
- same identity with a different fingerprint: reject as an idempotency conflict;
- similar timestamps or payload fields: never treated as duplicates by heuristic alone.

## Time and ordering

- Source time describes when the producer says the event occurred.
- Observed time describes when an adapter observed it.
- Ingestion time describes when Proofwake accepted it.
- Provider sequence, revision ancestry, run attempt, explicit causation, or aggregate sequence should settle order when available.
- Wall-clock time is for display and bounded staleness policy, not a universal correctness order.

## Evidence model

An evidence reference records:

- URI or local path class;
- content digest;
- size when known;
- media type;
- producing tool and version;
- disclosure class;
- whether it was verified, unavailable, redacted, or truncated.

Proofwake indexes evidence. It should avoid copying large artifacts into the ledger.

### Disclosure classes

Initial classes:

- `public-metadata` — safe repository, revision, state, count, and timing fields;
- `private-metadata` — local paths, machine identity, private repository names, or internal endpoints;
- `restricted-reference` — pointer to evidence requiring separate authority;
- `content-excluded` — source content intentionally discarded before persistence.

Adapters must declare which classes they can emit.

## Trust classes

Initial source trust classes:

- `local-operator` — emitted by a trusted local command;
- `signed-provider` — verified webhook or provider signature;
- `verified-receipt` — schema and digest-verified project receipt;
- `authenticated-client` — accepted from a scoped client credential;
- `untrusted-observation` — syntactically accepted but not authoritative for security-sensitive conclusions.

Trust class affects presentation and downstream use. It does not convert an observation into a coordination decision.

## Health and attention model

Repository health should derive from declared expected signals.

Example states:

- **green** — every currently required signal has a fresh passing observation for the selected revision;
- **red** — a required signal has a terminal failing observation without a later passing observation under the same declared policy;
- **yellow** — required evidence is missing, stale, partial, or blocked by an unavailable adapter;
- **grey** — repository is dormant or no policy is declared.

Every status must expose the observations and policy that produced it.

An attention recommendation may consider:

- active revision with failed required evidence;
- required signal overdue past its policy window;
- repeated reruns or failure recurrence;
- recent activity with no verification evidence;
- deployment observation without expected build or test evidence;
- source adapter becoming stale.

It must never present raw activity count as developer value.

## Compatibility migration

The repository was renamed from Shadowbill to Proofwake while the implementation still uses:

- `shadowbill` CLI and MCP names;
- `SHADOWBILL_*` environment variables;
- `~/.shadowbill` data paths;
- historical event kinds and documentation;
- browser extension branding.

Migration should preserve existing installations:

1. add `proofwake` aliases before removing anything;
2. read legacy environment variables with explicit precedence and deprecation notices;
3. discover the legacy data directory and provide a reviewed migration command;
4. keep historical event schemas readable;
5. version exported formats independently from branding;
6. document a removal horizon before deleting aliases.

## Security boundary

Proofwake processes developer telemetry and local evidence references. Security requirements include:

- loopback-first network binding;
- exact Host and origin validation;
- scoped authentication for writes;
- signed webhook verification before parsing;
- strict JSON parsing and bounded input;
- no-follow and regular-file checks for local receipt ingestion where supported;
- owner-only local secrets and ledger metadata;
- exclusion of secret-bearing environment dumps and raw command output;
- explicit remote-hosting profile rather than accidental exposure.

## Deployment profiles

### Local personal fleet

The first-class profile:

- one operator;
- local ledger;
- loopback collector and dashboard;
- local CLI and MCP;
- GitHub webhook through an explicitly configured reverse proxy only when needed.

### Small shared installation

A later profile may add:

- authenticated users;
- scoped repositories;
- durable database projection;
- remote collectors;
- retention and deletion policy;
- audit and backup operations.

This profile should arrive only after the local event and projection contracts are stable.

## Decisions deliberately deferred

- hosted multi-tenancy;
- arbitrary logs, traces, and metric storage;
- automatic remediation;
- project ranking;
- universal DORA implementation;
- a new provenance standard;
- a new CI pipeline language;
- agent orchestration;
- distributed consensus or workflow authority.
