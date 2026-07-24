# Shadowbill

**A compute reckoner for unmetered AI.**

Shadowbill estimates the API-equivalent cost of subscription AI usage from observable local activity. It combines aggregate ChatGPT browser telemetry, local Git commit diffs, signed GitHub delivery events, and explicit pricing assumptions into daily, rolling, and repository-level reports.

Conversation text and source patches stay out of the ledger.

## What it measures

- Completed ChatGPT assistant turns and revision-safe visible token estimates
- Model and reasoning labels supplied by the browser collector
- Tokens retained in local Git commits
- GitHub pushes, merged pull requests, workflow outcomes, and deployments
- Daily and 1–365 day API-equivalent cost estimates
- Cost per commit, merged PR, successful CI run, deployment, and retained code token
- Heuristic repository allocation with explicit unallocated cost and coverage

## Estimation model

For GPT-5.6 Sol, the bundled catalog currently uses:

- Input: USD $5.00 per million tokens
- Cached input: USD $0.50 per million tokens
- Cache writes: USD $6.25 per million tokens
- Output: USD $30.00 per million tokens
- Requests above 272,000 input tokens: 2× input and 1.5× output pricing

The default working profile classifies visible input as 70% cache reads, 10% cache writes, and 20% uncached input. It multiplies visible output by 2.5 to represent hidden reasoning and discarded or tool-generated output.

Those values are versioned assumptions, not claims about inaccessible ChatGPT internals. Pricing lives in [`config/pricing.json`](config/pricing.json), separate from the estimator.

## Start the collector

Requires Node.js 22 or newer.

```bash
npm install
npm run serve
```

The collector listens on `http://127.0.0.1:7337` and writes to `~/.shadowbill/events.jsonl`. On first launch, it creates a browser collector token at `~/.shadowbill/collector-token` with owner-only permissions where supported.

Load the unpacked extension from [`extension/`](extension/), open its popup, and paste the collector token.

Install local commit collection in any repository:

```bash
node src/cli.js hook install /path/to/repository
```

The hook preserves an existing shell `post-commit` hook and records metadata plus a token estimate for added lines. Added source text is discarded after tokenization.

## Reports

Today's human-readable report:

```bash
node src/cli.js report
```

A rolling report:

```bash
node src/cli.js report --days 30
```

Repository allocation:

```bash
node src/cli.js report --days 30 --by-repository
```

Machine-readable output:

```bash
node src/cli.js report --days 30 --json
node src/cli.js report --days 30 --by-repository --json
```

Set a reporting timezone explicitly when running on a server or inside a container:

```bash
SHADOWBILL_TIMEZONE=America/Los_Angeles npm run serve
node src/cli.js report --timezone America/Los_Angeles
```

Repository allocation uses the versioned basis `same-day-added-code-tokens`: each day's working estimate is divided according to same-day retained code tokens. Days without retained-code evidence remain visibly unallocated. This is a correlated heuristic, not causal attribution. See [`docs/repository-allocation.md`](docs/repository-allocation.md).

## Local dashboard

With the collector running, open:

```text
http://127.0.0.1:7337/dashboard
```

The dependency-free dashboard includes:

- 7, 30, 90, 365, and custom-day ranges
- Working cost, visible tokens, chat turns, retained code, and delivery outcomes
- Daily cost and chat-volume visualization
- Daily ledger detail
- Repository allocation, unallocated cost, coverage, and per-repository outcome metrics

Assets and report calls stay on the collector origin. The page uses a strict Content Security Policy and makes no third-party requests.

## Read-only diagnostics

Inspect the local installation without modifying it:

```bash
node src/cli.js doctor
node src/cli.js doctor --json
```

`doctor` checks ledger readability, lock state, recovery metadata, file permissions, collector-token configuration, pricing, timezone, and one-day report generation. Warnings return exit code `0`; errors return `1`.

It never creates a token, repairs a ledger, removes a lock, changes permissions, or returns secret and content-bearing fields. See [`docs/doctor.md`](docs/doctor.md).

## Browser collector authentication

Browser-originated event writes require bearer authentication. Read the generated token with:

```bash
cat ~/.shadowbill/collector-token
```

Choose a custom token file:

```bash
node src/cli.js serve --collector-token-file /private/path/shadowbill-token
```

Or provide a direct environment value containing at least 32 characters:

```bash
SHADOWBILL_COLLECTOR_TOKEN='replace-with-a-long-random-value' npm run serve
```

The event endpoint accepts aggregate chat events only and copies an allowlist of fields before persistence. Undeclared values such as prompt text are discarded.

## HTTP boundary

The collector binds to loopback and validates the HTTP `Host` authority before routing. Default allowed hosts are `127.0.0.1`, `localhost`, and `[::1]`.

Reverse-proxy deployments must opt in to their public authority:

```bash
node src/cli.js serve --allowed-hosts shadowbill.internal:8443
# or
SHADOWBILL_ALLOWED_HOSTS='shadowbill.internal:8443' npm run serve
```

Cross-origin headers are emitted only for the authenticated browser routes:

- `GET /v1/auth/check`
- `POST /v1/events`

Health, reports, dashboard assets, webhooks, and unknown routes remain same-origin. See [`docs/http-security.md`](docs/http-security.md).

## Report API

The same-origin loopback API exposes:

```text
GET /v1/report?date=2026-07-25
GET /v1/report?date=2026-07-25&days=30
GET /v1/report?date=2026-07-25&days=30&group=repository
```

Dates are interpreted in the requested `timezone` query parameter or the collector's configured timezone.

## MCP server

Shadowbill exposes the local ledger through a zero-dependency MCP stdio server compatible with protocol revision `2025-11-25`:

```bash
npm run mcp
```

Read-only tools:

- `shadowbill_daily_report` — one calendar day
- `shadowbill_range_report` — a rolling 1–365 day report
- `shadowbill_repository_report` — repository allocation, coverage, unallocated cost, and delivery outcomes

Aggregate chat writes require explicit opt-in:

```bash
node src/cli.js mcp --allow-writes
# or
SHADOWBILL_MCP_ALLOW_WRITES=1 npm run mcp
```

That mode adds `shadowbill_record_chat_turn`. The tool accepts counts, timing, model metadata, and a stable conversation key that is hashed before storage. Its schema rejects undeclared fields, including prompt and response text.

Example host configuration:

```json
{
  "mcpServers": {
    "shadowbill": {
      "command": "node",
      "args": [
        "/absolute/path/to/Shadowbill/src/cli.js",
        "mcp",
        "--timezone",
        "America/Los_Angeles"
      ],
      "env": {
        "SHADOWBILL_DATA": "/absolute/path/to/events.jsonl"
      }
    }
  }
}
```

The stdio process reserves stdout for newline-delimited MCP JSON-RPC messages.

## GitHub webhooks

Start the collector with a webhook secret:

```bash
SHADOWBILL_GITHUB_WEBHOOK_SECRET='replace-me' npm run serve
```

Configure a GitHub App or repository webhook with:

- Payload URL: `https://your-host.example/v1/github/webhooks`
- Content type: `application/json`
- Secret: the same value supplied to Shadowbill
- Events: pushes, pull requests, workflow runs, and deployment statuses

The collector verifies `X-Hub-Signature-256` before parsing or storing a delivery. GitHub delivery IDs provide idempotency. Source patches, PR descriptions, comments, logs, and deployment URLs are excluded.

A hosted setup should place a TLS reverse proxy in front of the loopback listener and forward only the webhook route.

## Durable local ledger

The JSONL store serializes local writes, coordinates concurrent Shadowbill processes with a filesystem lock, validates complete records after interrupted writes, and records recovered trailing bytes in a separate sidecar rather than silently discarding them.

The main ledger, lock-owner metadata, recovery sidecar, and generated collector token use owner-only permissions where the platform exposes POSIX mode bits.

## Privacy boundary

Stored chat events contain hashes, timestamps, model and reasoning labels, aggregate token counts, durations, and tool counts. Raw prompts and responses are excluded.

Local Git events contain commit metadata, diff statistics, and estimated added-code tokens. Added source text is discarded after tokenization.

GitHub events contain repository names, SHAs, refs, numeric counts, statuses, timestamps, environments, and delivery IDs. Content-bearing webhook fields are excluded.

MCP report tools return aggregates. MCP write access is opt-in, hashes conversation identifiers, and rejects undeclared fields.

## Accuracy

Shadowbill reports API-equivalent estimates. Consumer ChatGPT does not expose cache hits, hidden reasoning tokens, internal tool traffic, context compaction, or routing decisions. The profiles keep those unknowns explicit instead of presenting inferred cost as exact provider telemetry.

Repository allocation adds another disclosed assumption: temporal correlation with retained code. It should be used for trend analysis and workload comparison, not billing or causal claims.

## Focused guides

- [`docs/doctor.md`](docs/doctor.md)
- [`docs/http-security.md`](docs/http-security.md)
- [`docs/range-reports.md`](docs/range-reports.md)
- [`docs/repository-allocation.md`](docs/repository-allocation.md)

## Roadmap

- Better model-specific tokenizers and calibration fixtures
- Rolling calibration from visible output to retained code
- More explicit chat-to-repository association signals
- ChatGPT App-facing MCP transport and interface
- Import and export tools for portable local ledgers

## Development

```bash
npm test
```

The project uses zero runtime dependencies.
