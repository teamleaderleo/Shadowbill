# Proofwake observation contract v1

## Status

This document defines the first implemented Proofwake observation contract. It is intentionally smaller than the full architecture described in [`architecture.md`](architecture.md).

The implementation includes:

- a CloudEvents-compatible JSON envelope;
- strict JSON parsing with duplicate-key, depth, array, string, and total-byte bounds;
- exact field allowlists;
- repository, revision, trust, evidence, privacy, and relationship fields;
- canonical semantic fingerprints;
- `source + id` idempotency;
- the local `proofwake emit` command.

The stable schema identifier is:

```text
urn:proofwake:schema:observation:1
```

The JSON Schema is [`schema/observation-v1.schema.json`](../schema/observation-v1.schema.json).

## Standards baseline

### CloudEvents

Proofwake v1 uses the CloudEvents 1.0 context model and JSON envelope. The published CloudEvents specification release is v1.0.2, while compliant events use the context value:

```json
{ "specversion": "1.0" }
```

Proofwake requires these CloudEvents context attributes:

- `specversion`;
- `id`;
- `source`;
- `type`;
- `time`;
- `subject`;
- `datacontenttype`;
- `dataschema`;
- `data`.

CloudEvents itself treats `source + id` as the identity of a distinct event. Proofwake adopts that identity directly.

### CDEvents

CDEvents v0.5.0 builds on CloudEvents and defines delivery-oriented event and subject models. Proofwake accepts CDEvents-style event names where they fit, but does not claim that every Proofwake event is a conforming CDEvent.

Adapters should use an existing CDEvents type before inventing a Proofwake-specific type. Source-specific meaning remains in the strict `data` fields and evidence references.

### OpenTelemetry semantic conventions

Proofwake v1 allowlists a small set of current OpenTelemetry VCS and CI/CD attribute names:

- `vcs.repository.url.full`;
- `vcs.repository.name`;
- `vcs.owner.name`;
- `vcs.provider.name`;
- `vcs.ref.head.revision`;
- `vcs.ref.head.name`;
- `vcs.ref.head.type`;
- `vcs.change.id`;
- `vcs.change.state`;
- `cicd.pipeline.name`;
- `cicd.pipeline.action.name`.

The upstream CI/CD and VCS conventions include release-candidate and development fields. Proofwake freezes the names accepted by schema v1. Upstream convention changes require an explicit Proofwake schema revision rather than silent reinterpretation.

## Example

```json
{
  "specversion": "1.0",
  "id": "local-verify-1",
  "source": "urn:proofwake:adapter:local-cli",
  "type": "dev.proofwake.verify.finished.v1",
  "time": "2026-07-25T17:00:00Z",
  "subject": "repo:team/repo@sha:0123456789012345678901234567890123456789",
  "datacontenttype": "application/json",
  "dataschema": "urn:proofwake:schema:observation:1",
  "data": {
    "schemaVersion": 1,
    "adapter": {
      "name": "local-cli",
      "version": "0.3.0",
      "trust": "local-operator"
    },
    "repository": {
      "kind": "remote",
      "id": "team/repo",
      "url": "https://github.com/team/repo",
      "provider": "github"
    },
    "revision": {
      "algorithm": "git-sha1",
      "id": "0123456789012345678901234567890123456789"
    },
    "kind": "verify",
    "status": "passed",
    "observedAt": "2026-07-25T17:00:01Z",
    "durationMs": 1250,
    "attempt": 1,
    "evidence": [],
    "attributes": {
      "vcs.provider.name": "github",
      "vcs.ref.head.revision": "0123456789012345678901234567890123456789"
    },
    "redacted": false,
    "truncated": false
  }
}
```

## Local emission

From an installed package:

```bash
proofwake emit --json observation.json
cat observation.json | proofwake emit --stdin
```

During repository development:

```bash
npm run emit -- --json observation.json
```

Choose an explicit ledger when testing or operating multiple installations:

```bash
proofwake emit --json observation.json --data /private/path/events.jsonl
```

Successful output is one JSON line:

```json
{
  "accepted": true,
  "duplicate": false,
  "source": "urn:proofwake:adapter:local-cli",
  "id": "local-verify-1",
  "fingerprint": "sha256-without-prefix",
  "ingestedAt": "2026-07-25T17:01:00.000Z",
  "dataPath": "/home/user/.proofwake/events.jsonl"
}
```

The output does not include evidence content, secrets, source text, prompts, responses, command output, or environment values.

## Identity and idempotency

The event identity is the ordered pair:

```text
(source, id)
```

Proofwake stores a SHA-256 semantic fingerprint with each accepted v1 observation.

- A new identity is appended once.
- An identical normalised event delivered again returns `duplicate: true` and the original ingestion time.
- Reusing the same identity with changed semantics fails with `PW_IDEMPOTENCY_CONFLICT`.
- Similar timestamps, repository names, revisions, or evidence digests never create an implicit duplicate relationship.

Legacy Shadowbill events retain their historical top-level `id` behaviour. The new source-scoped path is used only for prepared Proofwake observations.

## Canonical fingerprint

Fingerprint input is the normalised observation before Proofwake storage extensions are added.

Normalisation includes:

- timestamps converted to UTC ISO strings;
- remote repository IDs converted to lowercase canonical `owner/name` form;
- Git object IDs converted to lowercase;
- default empty evidence and attribute collections;
- default `redacted: false` and `truncated: false`;
- exact field allowlists;
- standardised URLs where defined.

Canonical JSON then:

1. sorts object keys lexicographically at every level;
2. preserves array order;
3. emits no insignificant whitespace;
4. uses JSON scalar encoding;
5. rejects non-finite numbers and non-JSON values.

The SHA-256 digest is stored as the lower-case hexadecimal `proofwakefingerprint` CloudEvents extension attribute.

Storage also adds:

- `proofwakeschema: "1"`;
- `proofwakeingestedat` as a UTC timestamp.

Those storage extensions are excluded from the semantic fingerprint.

## Time semantics

- `time` is the source-declared event time.
- `data.observedAt` is when the adapter observed the result.
- `proofwakeingestedat` is when the local ledger accepted it.

Wall-clock proximity never establishes causality.

Explicit `data.relationships.causedBy` references declare causation. `correlatedWith` declares a weaker source-provided association. Both use CloudEvents `source + id` references and are bounded to 16 entries per list.

## Repository and revision identity

### Remote repository

```json
{
  "kind": "remote",
  "id": "owner/name",
  "url": "https://github.com/owner/name",
  "provider": "github"
}
```

The canonical `id` is lowercase `owner/name`. Provider and URL are optional metadata.

### Local repository

```json
{
  "kind": "local",
  "localId": "sha256:..."
}
```

A local repository does not put a filesystem path into the ledger. The adapter supplies a stable SHA-256 identity derived under its documented policy.

### Revision

Supported algorithms:

- `git-sha1` with a full 40-character object ID;
- `git-sha256` with a full 64-character object ID;
- `opaque` with a bounded producer-defined identifier.

Abbreviated Git object IDs are rejected.

## Evidence references

Proofwake indexes evidence instead of copying large artifacts into the ledger.

Each reference includes:

- absolute `uri`;
- lowercase `sha256:<64 hex>` digest;
- optional byte size;
- media type;
- producer name and version;
- optional schema URI;
- state;
- disclosure class.

States:

- `available`;
- `verified`;
- `unavailable`;
- `redacted`;
- `truncated`.

Disclosure classes:

- `public-metadata`;
- `private-metadata`;
- `restricted-reference`;
- `content-excluded`.

The v1 envelope allows at most 16 evidence references.

## Trust classes

- `local-operator`;
- `signed-provider`;
- `verified-receipt`;
- `authenticated-client`;
- `untrusted-observation`.

Trust describes the source boundary. It does not turn an observation into an approval, assignment, completion decision, or universal correctness claim.

## Privacy boundary

The v1 schema has no arbitrary payload, message, log, note, description, command-output, environment, prompt, response, patch, or source-content field.

Unknown fields fail closed at every declared object boundary. The `attributes` object accepts only the explicitly documented OpenTelemetry-compatible keys.

This prevents those content classes from entering through the supported envelope. Adapters remain responsible for ensuring that values placed in allowed metadata fields do not contain secrets or content that violates their disclosure contract.

## Parser bounds

The runtime parser enforces:

- 65,536 total UTF-8 bytes;
- valid UTF-8 at the CLI boundary;
- 12 nested levels;
- 4,096 characters per JSON string;
- 64 keys per object;
- 32 items per general JSON array;
- duplicate-key rejection at every object level;
- finite JSON numbers only;
- no trailing content.

JSON Schema does not represent duplicate-key or total-byte rules. Runtime parsing is authoritative for those constraints.

## Stable failure codes

Initial machine-readable codes include:

- `PW_INPUT_REQUIRED`;
- `PW_OBSERVATION_TOO_LARGE`;
- `PW_JSON_UTF8`;
- `PW_JSON_SYNTAX`;
- `PW_JSON_DUPLICATE_KEY`;
- `PW_JSON_DEPTH`;
- `PW_JSON_STRING_TOO_LONG`;
- `PW_JSON_OBJECT_TOO_LARGE`;
- `PW_JSON_ARRAY_TOO_LARGE`;
- `PW_JSON_NON_FINITE`;
- `PW_SCHEMA_REQUIRED`;
- `PW_SCHEMA_INVALID`;
- `PW_SCHEMA_UNKNOWN_FIELD`;
- `PW_IDEMPOTENCY_CONFLICT`;
- `PW_EMIT_FAILED`.

Errors are written to stderr as:

```text
CODE: human-readable message
```

No rejected input body is echoed.

## Forward compatibility

- `dataschema` identifies the complete Proofwake data contract.
- A breaking field or semantic change requires a new schema URN.
- Existing v1 events remain readable.
- New fields do not enter v1 through permissive `additionalProperties` behaviour.
- CloudEvents patch releases do not change `specversion: "1.0"`.
- Upstream CDEvents and OpenTelemetry changes are adopted through reviewed mappings and schema revisions.

## Legacy mapping

Current Shadowbill events remain unchanged in this slice.

Future migration adapters may map:

- `git_commit` to a revision observation;
- `github_push` to a source-control observation;
- `github_pull_request` to a change observation;
- `github_workflow_run` to a CI/CD observation;
- `github_deployment` to a deployment observation;
- `chat_turn` to the optional Shadowbill estimate family.

Migration must append mapped observations or rebuild a derived projection. It must not rewrite the historical append-only ledger in place.
