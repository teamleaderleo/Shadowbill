# MCP reporting tools

Start the local stdio server with:

```bash
npm run mcp
```

The default server exposes two read-only tools.

## `shadowbill_daily_report`

Returns one calendar day's aggregate usage, cost, commit, pull-request, workflow, and deployment metrics.

Optional arguments:

- `date`: calendar date in `YYYY-MM-DD` format
- `timezone`: IANA timezone such as `America/Los_Angeles`

Both values default to the server's current local date and configured timezone.

## `shadowbill_range_report`

Returns a rolling calendar-day report using the same range accounting as the CLI and HTTP API.

Optional arguments:

- `endDate`: inclusive end date in `YYYY-MM-DD` format
- `days`: integer from 1 through 365; defaults to 7
- `timezone`: IANA timezone such as `America/Los_Angeles`

The result includes aggregate costs and delivery outcomes plus the daily series used for peak-day and trend analysis.

## Write access

`shadowbill_record_chat_turn` appears only when the server starts with explicit write access:

```bash
node src/cli.js mcp --allow-writes
```

The write tool accepts aggregate counts and identifiers only. Conversation identifiers are hashed before persistence, and undeclared fields are rejected.
