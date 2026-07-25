# Repository policy v1

## Purpose

A repository policy declares which evidence Proofwake expects for one project. It is repository-owned configuration, not an execution script.

The committed filename is `.proofwake.json`. The schema identifier is:

```text
urn:proofwake:schema:repository-policy:v1
```

The published JSON Schema is [`schema/repository-policy-v1.schema.json`](../schema/repository-policy-v1.schema.json). The zero-dependency validator is [`src/repository-policy.js`](../src/repository-policy.js).

## Authority

A valid `.proofwake.json` committed in the selected repository is authoritative for that repository's evidence policy.

Autodetection may later propose a policy, but a proposal does not become authoritative until the operator writes the committed file or explicitly approves an entry in the local global registry.

The future global registry will wrap the same validated policy with local-only metadata such as repository root, configuration source, approval timestamp, last inspection time, and adapter readiness. Those values do not belong in committed policy.

## Privacy boundary

Committed policy contains no:

- local filesystem root;
- absolute receipt path;
- command or shell fragment;
- environment value;
- credential or token;
- source text or patch;
- log or diagnostic message;
- arbitrary adapter payload.

Receipt adapters name one portable repository-relative file. Runtime ingestion must still apply no-follow, regular-file, root-containment, size, schema, and disclosure checks before accepting a receipt.

## Complete example

```json
{
  "version": 1,
  "repository": {
    "kind": "remote",
    "id": "teamleaderleo/renderprove",
    "provider": "github"
  },
  "lifecycle": {
    "state": "active",
    "dormantAfterDays": 30
  },
  "signals": [
    {
      "kind": "verify",
      "requirement": "required",
      "subject": "revision",
      "appliesTo": "every-revision",
      "freshness": { "mode": "revision" },
      "acceptedSources": ["local-command"]
    },
    {
      "kind": "browser-review",
      "requirement": "required",
      "subject": "revision",
      "appliesTo": "every-revision",
      "freshness": { "mode": "revision" },
      "acceptedSources": ["adapter:renderprove"]
    }
  ],
  "adapters": [
    {
      "name": "renderprove",
      "type": "receipt-file",
      "path": ".renderprove/receipt.json",
      "schema": "renderprove.receipt.v1",
      "trust": "verified-receipt"
    }
  ]
}
```

## Repository identity

### Remote

```json
{
  "kind": "remote",
  "id": "owner/name",
  "provider": "github"
}
```

The identifier is canonical lowercase `owner/name`. Proofwake does not infer authority from the repository directory name alone.

### Local-only

```json
{
  "kind": "local",
  "localId": "sha256:...",
  "displayName": "private-experiment"
}
```

A local-only identity uses a generated digest and a bounded display slug. It does not disclose a local path. Remote and local identity fields are mutually exclusive.

## Lifecycle

An active policy declares when an inactive repository may be classified as dormant:

```json
{
  "state": "active",
  "dormantAfterDays": 30
}
```

An explicitly dormant policy is:

```json
{ "state": "dormant" }
```

Active policy requires at least one required signal. Dormant policy cannot require signals. This keeps an intentionally archived experiment distinct from an active repository that has stopped reporting.

## Expected signals

Policy v1 uses the projection vocabulary selected for the five-repository pilot:

- `verify`;
- `github-ci`;
- `browser-review`;
- `deployment`;
- `service-check`;
- `domain-check`;
- `host-diagnostic`;
- `local-diagnostic`;
- `shadowbill-estimate`.

Each kind appears at most once. Renderprove's pinned renderer probe maps to optional `domain-check`; producer-native type and evidence still preserve its narrower meaning.

A signal declares:

- `requirement`: `required` or `optional`;
- `subject`: `revision`, `repository`, `host`, `service`, or `deployment`;
- `appliesTo`;
- `freshness`;
- one or more accepted sources.

## Applicability

Applicability says which selected entity the signal policy covers. It is separate from the observation subject type.

Revision observations may apply to:

- `every-revision`;
- `default-branch`;
- `deployed-revision`;
- `release`.

Other subject types have one matching applicability:

- repository subject → `repository`;
- host subject → `host`;
- service subject → `service`;
- deployment subject → `deployment`.

Examples:

```json
{
  "kind": "github-ci",
  "subject": "revision",
  "appliesTo": "default-branch"
}
```

```json
{
  "kind": "browser-review",
  "subject": "revision",
  "appliesTo": "deployed-revision"
}
```

The validator rejects subject/applicability combinations that cannot be projected consistently.

## Freshness

Revision freshness means evidence must match the selected exact revision:

```json
{ "mode": "revision" }
```

Duration freshness means evidence remains current for a bounded number of hours:

```json
{ "mode": "duration", "hours": 24 }
```

No freshness requirement is allowed only for optional signals:

```json
{ "mode": "none" }
```

Revision subjects require revision freshness. Other subjects cannot use revision freshness.

## Accepted sources

Built-in source names are:

- `local-command`;
- `github`;
- `manual`.

A declared adapter is referenced as `adapter:renderprove`. Every adapter source must resolve to one adapter in the same policy. Source entries and adapter names are unique.

Accepted source names declare which producer classes may satisfy a signal kind. They do not make an observation authoritative by themselves; observation type, trust, repository binding, subject, and source validation still apply.

## Receipt-file adapters

Policy v1 supports one adapter type:

```json
{
  "name": "renderprove",
  "type": "receipt-file",
  "path": ".renderprove/receipt.json",
  "schema": "renderprove.receipt.v1",
  "trust": "verified-receipt"
}
```

The path:

- uses forward slashes;
- is relative to the approved repository root;
- names one file rather than a glob;
- contains no empty, current, or parent segment;
- contains no colon, whitespace, Windows drive prefix, or backslash.

The schema is a stable token or absolute URI. Trust uses the observation-v1 trust vocabulary. Policy validation does not read the receipt; adapter readiness and receipt ingestion remain separate operations.

## Normalisation and fingerprint

The validator returns a normalised policy:

- remote IDs, providers, adapter names, local display names, and accepted sources are lowercase;
- object fields are copied through exact allowlists;
- no undeclared values survive validation.

`repositoryPolicyFingerprint(policy)` validates the policy, canonicalises object-key order, preserves array order, and returns a SHA-256 digest. The future registry can use this fingerprint to detect policy changes without treating filesystem timestamps as authority.

## Five-repository pilot

Valid policy fixtures exist for Proofwake, Renderprove, SmolRunner, Stensibly, and One More Legend. They encode the expected signals and applicability selected in [`five-repository-pilot.md`](five-repository-pilot.md).

## Stable validator failures

Initial codes include:

- `REPOSITORY_POLICY_INVALID_VERSION`;
- `REPOSITORY_POLICY_INVALID_TYPE`;
- `REPOSITORY_POLICY_INVALID_VALUE`;
- `REPOSITORY_POLICY_UNKNOWN_FIELD`;
- `REPOSITORY_POLICY_MISSING_FIELD`;
- `REPOSITORY_POLICY_DUPLICATE_VALUE`;
- `REPOSITORY_POLICY_IDENTITY_CONFLICT`;
- `REPOSITORY_POLICY_LIFECYCLE_CONFLICT`;
- `REPOSITORY_POLICY_APPLICABILITY_CONFLICT`;
- `REPOSITORY_POLICY_FRESHNESS_CONFLICT`;
- `REPOSITORY_POLICY_PATH_ESCAPE`;
- `REPOSITORY_POLICY_ADAPTER_MISSING`.

Each error includes a JSON-style path. Rejected values should not be copied into machine-readable diagnostics unless the value is itself a bounded non-content identifier.

## Deferred to enrolment

This contract does not yet:

- locate Git repository roots;
- compare configured identity with remotes;
- persist approved global registry entries;
- resolve committed/global policy conflicts;
- inspect adapter files;
- classify source freshness;
- produce fleet inventory.

Those behaviours belong to `proofwake enroll`, `proofwake repositories`, and repository diagnostics built on this contract.
