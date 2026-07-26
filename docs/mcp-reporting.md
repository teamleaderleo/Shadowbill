# MCP reporting tools

Start the local stdio server with:

```bash
npm run mcp
```

The server exposes Proofwake evidence projections and the existing Shadowbill estimate reports. All projection and report tools are read-only. The aggregate chat write tool remains opt-in.

By default, Proofwake reads `repositories.json` beside the selected event ledger. Select another approved registry explicitly with:

```bash
node src/main.js mcp --registry /path/to/repositories.json
```

## Proofwake projection tools

Every Proofwake tool call reads one repository-registry snapshot and one event-ledger snapshot. The response is rebuilt from those immutable inputs with the same projection functions used by `proofwake fleet` and `proofwake inspect`, then passed through a content-minimising MCP disclosure boundary.

### `proofwake_fleet_status`

Takes an empty argument object and returns the current fleet projection, including projection version, source cursor, repository classifications and statuses, selected revisions, required signal summaries, latest accepted evidence, recoveries, configuration problems, and evidence-backed attention reasons.

### `proofwake_repository_status`

Required argument:

- `repository`: canonical lowercase `owner/name` identity

Returns the same selected-revision state as:

```bash
proofwake inspect --repo owner/name --output json
```

### `proofwake_revision_evidence`

Required arguments:

- `repository`: canonical lowercase `owner/name` identity
- `revision`: full lowercase 40-character SHA-1

Returns the same explicit-revision state as:

```bash
proofwake inspect FULL_SHA --repo owner/name --output json
```

Unknown fields and malformed identities or revisions produce bounded tool errors with stable machine-readable codes. Projection selection, version, cursor, repository identity, revision, status, signals, evidence digests and metadata, trust, coverage, attempts, reruns, recovery, and attention state remain unchanged. The disclosure boundary omits adapter receipt paths, error paths, content-derived configuration prose, checkout paths, source content, executed commands and output, logs, receipt bytes, prompts, responses, tokens, secrets, and environment values. HTTPS and URN evidence references remain intact; references using local or other URI schemes become digest-backed Proofwake URNs.

## Shadowbill compatibility tools

### `shadowbill_daily_report`

Returns one calendar day's aggregate usage, cost, commit, pull-request, workflow, and deployment metrics.

Optional arguments:

- `date`: calendar date in `YYYY-MM-DD` format
- `timezone`: IANA timezone such as `America/Los_Angeles`

Both values default to the server's current local date and configured timezone.

### `shadowbill_range_report`

Returns a rolling calendar-day report using the same range accounting as the CLI and HTTP API.

Optional arguments:

- `endDate`: inclusive end date in `YYYY-MM-DD` format
- `days`: integer from 1 through 365; defaults to 7
- `timezone`: IANA timezone such as `America/Los_Angeles`

### `shadowbill_repository_report`

Returns the existing heuristic repository allocation report for a rolling calendar-day range. It accepts the same optional `endDate`, `days`, and `timezone` arguments as `shadowbill_range_report`.

## Write access

`shadowbill_record_chat_turn` appears only when the server starts with explicit write access:

```bash
node src/main.js mcp --allow-writes
```

Adding Proofwake read tools does not enable writes. The write tool accepts aggregate counts and identifiers only. Conversation identifiers are hashed before persistence, and undeclared fields are rejected.
