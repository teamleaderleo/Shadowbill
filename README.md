# Proofwake

**The evidence trail behind every revision.**

Proofwake is a local evidence index for software projects. It collects content-minimised observations from local commands, Git, GitHub, CI, browser reviews, deployments, domain-specific tools, and optional AI-usage estimates, then organises them by repository and revision.

The project aims to answer:

- What changed recently?
- Which revisions have convincing evidence?
- What is failing, stale, silent, or only partially observed?
- What recovered after failure?
- Which repository needs attention next, and which source observation supports that conclusion?

Proofwake observes and indexes. It does not schedule CI, operate runners, deploy software, assign work, approve mutations, ingest arbitrary logs, or rank developers by raw activity.

## Project status

The repository was originally named **Shadowbill** and currently contains a working AI-usage reckoner, Git and GitHub observation collectors, a durable local ledger, reports, a dashboard, diagnostics, and a read-only MCP server.

Proofwake is now the primary product and command identity. Compatibility remains for:

- the `shadowbill` binary alias;
- `SHADOWBILL_*` environment variables;
- existing `~/.shadowbill` ledgers and collector-token files;
- historical event schemas and MCP tool names;
- legacy browser-extension storage keys.

Clean installations use `~/.proofwake`. An existing `~/.shadowbill/events.jsonl` remains active until an explicit migration is performed. If both implicit ledgers exist, Proofwake refuses to choose or merge them. Run `proofwake status` to inspect the active identity and paths.

## Read this first

- [Product direction](docs/product-direction.md) — what Proofwake is for, who it serves, and what it deliberately avoids
- [Architecture](docs/architecture.md) — event, evidence, privacy, trust, projection, and integration boundaries
- [Roadmap](docs/roadmap.md) — the implementation sequence from the current Shadowbill codebase
- [Ecosystem decisions](docs/ecosystem.md) — what existing standards and products already provide, and why Proofwake remains independent
- [Naming migration](docs/naming-migration.md) — current aliases, precedence, storage selection, and migration safety

## Intended composition

```text
SmolRunner runs it.
Renderprove sees and verifies it.
Domain tools measure it.
Proofwake remembers the evidence trail.
Stensibly coordinates what happens next.
```

Proofwake should also import and export existing standards where they fit, including CloudEvents, CDEvents, OpenTelemetry semantic conventions, SLSA/in-toto provenance, and selected OpenLineage concepts.

## Current implemented module: Shadowbill estimates

The current implementation estimates the API-equivalent cost of subscription AI usage from observable local activity. It combines aggregate ChatGPT browser telemetry, local Git commit diffs, signed GitHub delivery events, and explicit pricing assumptions into daily, rolling, and repository-level reports.

Conversation text and source patches stay out of the ledger.

Current measurements include:

- completed ChatGPT assistant turns and visible token estimates;
- model and reasoning labels supplied by the browser collector;
- tokens retained in local Git commits;
- GitHub pushes, merged pull requests, workflow outcomes, and deployments;
- daily and rolling API-equivalent cost estimates;
- cost per commit, merged PR, successful CI run, deployment, and retained code token;
- heuristic repository allocation with explicit unallocated cost and coverage.

These are versioned estimates, not claims about inaccessible provider internals or provider cost. The module remains optional as Proofwake develops its broader revision-evidence model.

## Install and inspect identity

Requires Node.js 22 or newer.

```bash
npm install
node src/cli.js status
node src/cli.js status --json
```

The package exposes both `proofwake` and the compatibility alias `shadowbill` when installed as a command.

Storage selection is read-only and deterministic:

1. `--data` wins;
2. `PROOFWAKE_DATA` wins over `SHADOWBILL_DATA`;
3. an existing `~/.proofwake/events.jsonl` is selected;
4. otherwise an existing `~/.shadowbill/events.jsonl` is selected with a compatibility warning;
5. otherwise a clean installation uses `~/.proofwake/events.jsonl`.

Proofwake never silently combines the new and legacy ledgers.

## Start the current collector

```bash
npm run serve
```

The collector listens on `http://127.0.0.1:7337`. A clean installation writes to `~/.proofwake/events.jsonl` and creates `~/.proofwake/collector-token` with owner-only permissions where supported. Existing Shadowbill installations keep using their legacy paths until explicitly migrated.

Load the unpacked extension from [`extension/`](extension/), open its popup, and paste the collector token.

Install local commit collection in any repository:

```bash
node src/cli.js hook install /path/to/repository
```

The hook preserves an existing shell `post-commit` hook and records metadata plus a token estimate for added lines. Added source text is discarded after tokenisation.

## Reports

```bash
node src/cli.js report
node src/cli.js report --days 30
node src/cli.js report --days 30 --by-repository
node src/cli.js report --days 30 --json
```

Set a reporting timezone explicitly when running on a server or inside a container:

```bash
PROOFWAKE_TIMEZONE=America/Los_Angeles npm run serve
node src/cli.js report --timezone America/Los_Angeles
```

`SHADOWBILL_TIMEZONE` remains a compatibility alias. Proofwake variables win when both names are present, and warnings are written to stderr so JSON stdout remains parseable.

Repository allocation currently uses the versioned basis `same-day-added-code-tokens`. Days without retained-code evidence remain visibly unallocated. This is a correlated heuristic rather than causal attribution. See [repository allocation](docs/repository-allocation.md).

## Local dashboard

With the collector running, open:

```text
http://127.0.0.1:7337/dashboard
```

The current dashboard is the optional Shadowbill estimate view inside Proofwake. It includes rolling ranges, cost and activity summaries, daily detail, repository allocation, coverage, and delivery outcomes. Its next major change is a fleet-first view built around repository inventory, revision evidence, source freshness, failure, recovery, and missing expected signals.

Assets and report calls stay on the collector origin. The page uses a strict Content Security Policy and makes no third-party requests.

## Diagnostics

Inspect the local installation without modifying it:

```bash
node src/cli.js doctor
node src/cli.js doctor --json
```

`doctor` checks ledger readability, lock state, recovery metadata, file permissions, collector-token configuration, pricing, timezone, and report generation. It does not create tokens, repair ledgers, remove locks, change permissions, or return secret and content-bearing fields.

See [doctor](docs/doctor.md).

## Browser collector authentication

Browser-originated event writes require bearer authentication. Use `proofwake status` to find the active token path, then read that file locally.

Choose a custom token file:

```bash
node src/cli.js serve --collector-token-file /private/path/proofwake-token
```

Or provide a direct value containing at least 32 characters:

```bash
PROOFWAKE_COLLECTOR_TOKEN='replace-with-a-long-random-value' npm run serve
```

`SHADOWBILL_COLLECTOR_TOKEN` and `SHADOWBILL_COLLECTOR_TOKEN_FILE` remain compatibility aliases.

The event endpoint accepts aggregate chat events only and copies an allowlist of fields before persistence. Undeclared values such as prompt text are discarded.

## HTTP boundary

The collector binds to loopback and validates the HTTP `Host` authority before routing. Reverse-proxy deployments must explicitly allow their public authority.

Cross-origin headers are emitted only for the authenticated browser routes. Health, reports, dashboard assets, webhooks, and unknown routes remain same-origin.

See [HTTP security](docs/http-security.md).

## MCP server

The current implementation exposes the local ledger through a zero-dependency MCP stdio server:

```bash
npm run mcp
```

The existing `shadowbill_*` MCP tools remain compatibility interfaces. The report tools are read-only. Aggregate chat writes require explicit opt-in and reject undeclared fields, including prompt and response text.

Proofwake’s planned MCP surface will remain read-only by default and add fleet, repository, revision-evidence, failure, and recovery reports.

## GitHub webhooks

Start the collector with a webhook secret:

```bash
PROOFWAKE_GITHUB_WEBHOOK_SECRET='replace-me' npm run serve
```

`SHADOWBILL_GITHUB_WEBHOOK_SECRET` remains a compatibility alias.

Configure a GitHub App or repository webhook for pushes, pull requests, workflow runs, and deployment statuses. The collector verifies `X-Hub-Signature-256` before parsing or storing a delivery. GitHub delivery IDs provide idempotency. Source patches, PR descriptions, comments, logs, and deployment URLs are excluded.

A hosted setup should place a TLS reverse proxy in front of the loopback listener and forward only the webhook route.

## Durable local ledger

The JSONL store serialises local writes, coordinates concurrent processes with a filesystem lock, validates complete records after interrupted writes, and records recovered trailing bytes in a separate sidecar rather than silently discarding them.

The main ledger, lock-owner metadata, recovery sidecar, and generated collector token use owner-only permissions where the platform exposes POSIX mode bits.

This append-oriented ledger is the starting point for Proofwake’s observation store. Derived repository and revision projections should remain rebuildable.

## Privacy boundary

Current stored events contain metadata, hashes, timestamps, labels, counts, durations, statuses, and tool counts.

Excluded by default:

- prompts and responses;
- source patches and added source text;
- arbitrary command output and logs;
- secrets and environment dumps;
- PR descriptions and comments;
- raw provider payloads.

Future adapters must publish exact schemas, maximum sizes, trust classes, disclosure classes, redaction behaviour, and degraded-mode behaviour.

## Accuracy and language

Proofwake records observations and evidence. A passing receipt proves only what one declared tool observed under its declared conditions.

The Shadowbill module reports API-equivalent estimates. Consumer ChatGPT does not expose cache hits, hidden reasoning tokens, internal tool traffic, context compaction, or routing decisions. Profiles keep those unknowns explicit.

Prefer “observed passing,” “evidence present,” and “source coverage incomplete” over universal correctness claims.

## Development

```bash
npm test
```

The current project uses zero runtime dependencies.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
