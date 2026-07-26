# Native Renderprove adapter

Proofwake can verify and index a declared Renderprove receipt while screenshots, URLs, diagnostics, commands, and local paths remain outside the observation ledger.

```bash
proofwake ingest-adapter --repo owner/project
proofwake ingest-adapter --repo owner/project --output json
```

An explicit revision may be supplied as an additional assertion:

```bash
proofwake ingest-adapter --repo owner/project --revision FULL_LOWERCASE_SHA
```

The explicit revision must equal the stable current checkout revision.

## Policy

The enrolled repository policy must declare a `receipt-file` adapter whose schema is `renderprove.receipt.v1`, and a `browser-review` signal must accept that adapter.

```json
{
  "signals": [
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

Committed policy remains authoritative. A changed or conflicting policy fails through the normal repository inspection boundary before receipt ingestion.

## Revision binding

Renderprove receipt v1 contains no repository revision. Adapter v1 therefore records a local-operator binding to the enrolled checkout.

Proofwake requires:

- a full current Git revision;
- no tracked or staged checkout changes;
- no unrelated visible untracked files;
- the same revision and checkout state before and after receipt verification.

The declared receipt and its referenced artifacts may be untracked output. Ignored local inputs remain outside Git's authority, so this binding proves the clean tracked checkout selected by the operator; it does not claim that Renderprove itself attested to a commit.

Reusing one Renderprove producer identity against different receipt bytes or another revision conflicts atomically instead of silently rebinding evidence.

## Receipt verification

The adapter:

- reads receipt bytes through a regular-file, no-follow, identity-checked boundary;
- rejects path escape, final or intermediate symlink escape, replacement, and mutation;
- caps the receipt at 4 MiB;
- rejects duplicate JSON keys, non-finite numbers, excessive depth, unknown fields, inconsistent summaries, unsupported schema versions, and non-canonical timestamps;
- supports up to 25 review cases and 15 screenshot references;
- verifies each screenshot SHA-256 and PNG signature;
- caps one screenshot at 128 MiB and all unique screenshots at 512 MiB;
- writes no observation when verification fails.

A valid receipt whose browser policy status is `failed` becomes a valid failing `browser-review` observation. Adapter failure and browser-policy failure remain separate outcomes.

Renderprove v1 also permits a valid zero-case receipt whose producer status is `passed`. Proofwake indexes that receipt as `unavailable` coverage because no browser case ran. The command returns both `producerStatus` and indexed `browserStatus` so the distinction stays explicit.

## Observation mapping

The ledger stores:

- repository and exact revision;
- stable receipt/run identity;
- producer start, finish, and duration;
- indexed browser status and case totals;
- hashed project, manifest, and stable case identities;
- per-case status and navigation success;
- aggregate navigation, page-unavailable, horizontal-overflow, and diagnostic-class counts;
- receipt and screenshot SHA-256 references, sizes, media types, producer, schema, and restricted disclosure class.

For a non-empty review, the exact receipt and verified screenshot references provide complete mapped browser-review coverage. Their content remains in the caller-managed Renderprove output store. A zero-case review carries unavailable coverage.

## Privacy

The observation excludes:

- base, requested, and final URLs;
- route and viewport prose;
- page titles and text;
- diagnostic messages, stacks, methods, and locations;
- runtime command arguments, working directory, log content, and exit payload;
- receipt and screenshot filesystem paths;
- screenshot bytes.

CLI JSON output contains repository identity, revision, digest, counts, producer status, indexed browser status, and observation identity. It contains no local checkout, registry, receipt, or artifact path. Receipt-derived parse and validation failures expose stable error codes with content-minimised public messages.
