# Shadowbill

**A compute reckoner for unmetered AI.**

Shadowbill estimates the API-equivalent cost of subscription AI usage from observable activity. The first release combines a local ChatGPT browser collector with commit-diff telemetry and produces daily lower-bound, visible, and working estimates.

It records aggregate token counts and repository events. Conversation text stays in the browser.

## What it measures

- Completed ChatGPT assistant turns
- Visible conversation-context and response token estimates
- Model and reasoning settings supplied by the user
- Tokens added in local Git commits
- Daily API-equivalent cost ranges
- Estimated cost per commit and retained code token

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

## Example

```text
Shadowbill — 2026-07-25

Chat turns                 84
Conversations              11
Visible input tokens       2,480,000
Visible output tokens      318,000
Commits                    9
Repositories               4
Added code tokens          34,700

Delivered-code floor       $1.0410
Visible cached floor       $10.7800
Visible uncached estimate  $21.9400
Working estimate           $28.7480
Working cost / commit      $3.1942
```

## Privacy boundary

The browser adapter calculates token estimates before sending an event. Stored chat events contain a conversation hash, timestamp, model label, reasoning label, and aggregate counts. Raw prompts and responses are excluded.

Git events contain commit metadata, diff statistics, and an estimated token count for added lines. Added source text is discarded after tokenization.

## Accuracy

Shadowbill reports API-equivalent estimates. Consumer ChatGPT does not expose cache hits, hidden reasoning tokens, internal tool traffic, context compaction, or routing decisions. The profiles make those unknowns visible instead of disguising them as exact telemetry.

## Near-term work

- GitHub App webhook adapter for pushes, pull requests, CI, and deployments
- MCP event adapter
- Better model-specific tokenizers
- Rolling calibration from visible output to retained code
- Local dashboard and weekly trends

## Development

```bash
npm test
```

Pricing lives in [`config/pricing.json`](config/pricing.json), separate from estimation logic.
