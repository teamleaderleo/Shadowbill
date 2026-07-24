# Shadowbill

**A compute reckoner for unmetered AI.**

Shadowbill estimates the API-equivalent cost of subscription AI usage from observable activity. It combines a local ChatGPT browser collector, commit-diff telemetry, signed GitHub delivery events, and a local MCP interface to produce daily lower-bound, visible, and working estimates.

It records aggregate token counts and delivery metadata. Conversation text and source patches stay out of the ledger.

## What it measures

- Completed ChatGPT assistant turns
- Visible conversation-context and response token estimates
- Model and reasoning settings supplied by the user
- Tokens added in local Git commits
- GitHub pushes, merged pull requests, workflow outcomes, and deployments
- Daily API-equivalent cost ranges
- Estimated cost per commit, merged PR, successful CI run, deployment, and retained code token

## Current estimation profiles

For GPT-5.6 Sol, the bundled catalog uses the published API rates effective July 25, 2026:

- Input: $5.00 per million tokens
- Cached input: $0.50 per million tokens
- Cache writes: $6.25 per million tokens
- Output: $30.00 per million tokens
- Requests above 272,000 input tokens: 2× input and 1.5× output pricing

The default working profile classifies visible input as 70% cache reads, 10% cache writes, and 20% uncached input. It multiplies visible output by 2.5 to represent hidden reasoning and discarded/tool output. These assumptions are explicit, local, and replaceable.

## Run it

Requires Node.js 22 or newer.

```bash
npm install
npm run serve
```

The collector listens on `http://127.0.0.1:7337` and writes to `~/.shadowbill/events.jsonl`.

Load the unpacked extension from [`extension/`](extension/), then install commit collection in any local repository:

```bash
node src/cli.js hook install /path/to/repository
```

Generate today's report:

```bash
node src/cli.js report
```

Or machine-readable output:

```bash
node src/cli.js report --json
```

Set an explicit reporting timezone when the collector runs on a server or inside a container:

```bash
SHADOWBILL_TIMEZONE=America/Los_Angeles npm run serve
node src/cli.js report --timezone America/Los_Angeles
```

## MCP server

Shadowbill exposes the local ledger over MCP stdio:

```bash
npm run mcp
```

The default server offers one read-only tool:

- `shadowbill_daily_report` — returns cost, token, commit, PR, CI, and deployment metrics for a calendar day

Aggregate chat-event writes require an explicit opt-in:

```bash
SHADOWBILL_MCP_ALLOW_WRITES=1 npm run mcp
# or
node src/cli.js mcp --allow-writes
```

That mode adds `shadowbill_record_chat_turn`. Its schema contains token counts, timing, model metadata, and a conversation key that is hashed before storage. The tool has no prompt or response text fields.

A typical local MCP host entry looks like:

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

The stdio process reserves stdout for MCP protocol traffic. Operational failures go to stderr.

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

The collector verifies `X-Hub-Signature-256` before parsing or storing a delivery. GitHub delivery IDs provide idempotency for redeliveries. Unsupported event types receive an accepted-and-ignored response.

The HTTP server binds to loopback. A hosted setup should place a TLS reverse proxy in front of it and forward only the webhook route.

## Example

```text
Shadowbill — 2026-07-25

Chat turns                 84
Conversations              11
Visible input tokens       2,480,000
Visible output tokens      318,000
Commits                    9
Pushes                     14
Merged pull requests       6
Successful workflow runs   11
Successful deployments     8
Repositories               4
Added code tokens          34,700

Delivered-code floor       $1.0410
Visible cached floor       $10.7800
Visible uncached estimate  $21.9400
Working estimate           $28.7480
Working cost / commit      $3.1942
Working cost / merged PR   $4.7913
Working cost / CI success  $2.6135
Working cost / deployment  $3.5935
```

## Privacy boundary

The browser adapter calculates token estimates before sending an event. Stored chat events contain a conversation hash, timestamp, model label, reasoning label, and aggregate counts. Raw prompts and responses are excluded.

Local Git events contain commit metadata, diff statistics, and an estimated token count for added lines. Added source text is discarded after tokenization.

GitHub events contain repository names, SHAs, refs, numeric counts, statuses, timestamps, environments, and delivery IDs. Source patches, PR descriptions, comments, logs, and deployment URLs are excluded.

MCP read access returns daily aggregates. MCP write access is opt-in and accepts aggregate chat metadata only.

## Accuracy

Shadowbill reports API-equivalent estimates. Consumer ChatGPT does not expose cache hits, hidden reasoning tokens, internal tool traffic, context compaction, or routing decisions. The profiles make those unknowns visible instead of disguising them as exact telemetry.

## Near-term work

- Better model-specific tokenizers
- Rolling calibration from visible output to retained code
- Browser completion detection for long streaming responses
- Collector authentication for browser-originated events
- Local dashboard and weekly trends
- ChatGPT App-facing MCP transport and UI

## Development

```bash
npm test
```

Pricing lives in [`config/pricing.json`](config/pricing.json), separate from estimation logic.
