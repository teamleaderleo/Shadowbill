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

Fleet, repository, and revision tools read one repository-registry snapshot and one event-ledger snapshot. Evaluation evidence reads one event-ledger snapshot and deliberately has no registry dependency. Every response is rebuilt from immutable inputs with the same projection functions used by the installed CLI, then passed through a content-minimising MCP disclosure boundary.

### `proofwake_fleet_status`

Takes an empty argument object and returns the current fleet projection, including projection version, source cursor, repository classifications and statuses, selected revisions, required signal summaries, latest accepted evidence, recoveries, configuration problems, and evidence-backed attention reasons.

### `proofwake_repository_status`

Required argument:

- `repository`: bounded enrolled repository identity or label

Returns the same selected-revision state as:

```bash
proofwake inspect --repo owner/name --output json
proofwake inspect --repo enrolled-label --output json
```

### `proofwake_revision_evidence`

Required arguments:

- `repository`: bounded enrolled repository identity or label
- `revision`: full lowercase 40-character SHA-1

Returns the same explicit-revision state as:

```bash
proofwake inspect FULL_SHA --repo owner/name --output json
proofwake inspect FULL_SHA --repo enrolled-label --output json
```

### `proofwake_evaluation_evidence`

Required arguments:

- `repository`: exact bounded `owner/name` repository identity
- `taskClass`: bounded evaluation task token

Optional argument:

- `targetRun`: exact `run_...` target-run reference

Returns the disclosed form of the same deterministic task-specific evidence view as:

```bash
proofwake evaluation --repo owner/name --task-class TOKEN --output json
proofwake evaluation --repo owner/name --task-class TOKEN --target-run run_... --output json
```

The tool reads exactly one immutable ledger snapshot and does not read the repository registry. It preserves the merged projection's current marks and findings, immutable mark and finding histories, rubric separation, conservative distinct-target sufficiency, open findings, coverage, exclusions, limitations, and deterministic source cursor.

Invalid arguments fail before any ledger or registry read. Unknown fields are rejected. The tool remains read-only even when the compatibility Shadowbill write tool is explicitly enabled.

Unknown fields and malformed selectors, revisions, task classes, or target-run references produce bounded tool errors with stable machine-readable codes. Projection selection, version, cursor, repository identity, revision, status, signals, evidence digests and metadata, trust, coverage, attempts, reruns, recovery, current evaluation evidence, histories, and attention state remain unchanged.

The disclosure boundary omits adapter receipt paths, error paths, content-derived configuration prose, checkout paths, source content, executed commands and output, logs, receipt bytes, wrapper extensions, prompts, responses, tokens, secrets, and environment values. Reviewed Proofwake adapter/provider URNs, public query-free HTTPS evidence links, and public GitHub API sources remain visible. Other observation sources become SHA-256-backed Proofwake source identifiers. Local, credential-bearing, query-bearing, arbitrary-URN, or otherwise unreviewed evidence references become digest-backed Proofwake evidence URNs.

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
