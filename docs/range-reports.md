# Rolling reports

Shadowbill can summarize up to 365 calendar days ending on a selected date.

```bash
# Last seven calendar days, ending today
node src/cli.js report --days 7

# Thirty days ending March 31 in Los Angeles
node src/cli.js report \
  --date 2026-03-31 \
  --days 30 \
  --timezone America/Los_Angeles

# Machine-readable output
node src/cli.js report --days 30 --json
```

The HTTP collector exposes the same contract:

```text
GET /v1/report?date=2026-03-31&days=30&timezone=America%2FLos_Angeles
```

A range report includes:

- total and average chat turns
- visible input and output tokens
- capture revisions and superseded captures
- working API-equivalent cost
- active-day and calendar-day averages
- commits, merged pull requests, successful CI runs, and deployments
- cost per delivered outcome
- peak chat-volume and estimated-cost days
- one daily report for each calendar date

Outcome IDs are deduplicated across the full range. This prevents a workflow or deployment whose lifecycle crosses midnight from counting twice.

Calendar iteration uses date labels instead of 24-hour timestamp arithmetic, so month boundaries and daylight-saving changes preserve the requested local dates.
