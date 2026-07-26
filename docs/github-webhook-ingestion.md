# Signed GitHub webhook ingestion

Proofwake accepts live GitHub deliveries at `POST /v1/github/webhooks` when the collector starts with a GitHub webhook secret.

## Authority boundary

The raw request body is retained in memory only long enough to verify `X-Hub-Signature-256` and parse the JSON payload. Signature verification is the authority boundary. Proofwake never constructs a `signed-provider` observation before verification succeeds.

After successful verification, the collector:

1. validates bounded `X-GitHub-Event` and `X-GitHub-Delivery` headers;
2. parses one JSON object;
3. captures one canonical `receivedAt` for the delivery, reusing the first accepted receipt time during replay;
4. calls `mapGitHubWebhookObservation()` with `signatureVerified: true`;
5. appends the mapped observation through `ObservationLedger`.

One supported delivery produces one durable `proofwake_observation` record. The collector never writes a second legacy GitHub row. Existing legacy rows remain readable through the compatibility activity view and projection readers.

## Supported deliveries

The live collector uses the merged observation mapper for:

- push deliveries, including revision-less deletion pushes;
- closed and merged pull requests;
- workflow-run outcomes, run identity, and attempt lineage;
- deployment status outcomes;
- published, non-draft releases whose `target_commitish` is a full lowercase revision.

Unmerged pull requests, unsupported event families, and releases without sufficient revision authority are accepted and ignored.

## HTTP results

| Result | Status | Behaviour |
|---|---:|---|
| Invalid signature | `401` | Rejected before mapping or ledger access |
| Malformed bounded headers or JSON payload | `400` | Bounded machine-readable error |
| Unsupported or authority-insufficient event | `202` | `accepted: true`, `ignored: true` |
| New observation | `202` | `accepted: true`, `duplicate: false` |
| Exact replay | `202` | `accepted: true`, `duplicate: true` |
| Reused observation identity with changed semantics | `409` | `OBSERVATION_ID_CONFLICT` |

Mapping and ingestion failures use stable bounded messages. Payload content and operating-system or ledger error prose are excluded from HTTP responses.

## Disclosure boundary

The durable observation keeps only reviewed scalar facts, canonical repository and revision relationships, bounded provider identities, workflow run and attempt lineage, outcome state, coverage, and a digest-backed delivery evidence reference.

The following stay outside both ledger records and HTTP responses:

- raw webhook bytes;
- commit subjects, bodies, patches, paths, and refs;
- pull-request titles, bodies, comments, and patch URLs;
- workflow names, workflow paths, jobs, and logs;
- deployment environments, descriptions, refs, URLs, and credentials;
- release names, tags, prose, and URLs;
- credentials and attacker-controlled error text.

`normalizeGitHubWebhook()` remains exported for compatibility with existing legacy callers and tests. New live writes use `mapGitHubWebhookObservation()` and `ObservationLedger` exclusively.
