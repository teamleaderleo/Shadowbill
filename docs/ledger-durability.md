# Ledger durability

Shadowbill stores events in an append-only JSONL ledger. Browser collection, Git hooks, MCP hosts, and CLI commands may all write to the same file from separate processes.

## Cross-process writes

Each append acquires an atomic lock directory beside the ledger:

```text
events.jsonl.lock/
```

The writer re-reads event IDs while holding that lock. Concurrent deliveries with the same ID remain idempotent, while distinct events are appended in order without interleaving.

A live lock waits for up to 10 seconds. Lock directories older than five minutes are treated as abandoned after a crashed writer and removed before retrying.

Each event is appended through an owner-only file handle and synced before the lock is released. On POSIX systems the ledger and recovery sidecar use mode `0600`.

## Crash-truncated tails

A valid final JSON record without a newline is preserved and separated before the next append.

An invalid unterminated final line is treated as a crash-truncated tail. Before appending a new event, Shadowbill:

1. archives the truncated bytes as base64 in `events.jsonl.recovery.jsonl`
2. truncates the ledger back to its last valid newline
3. appends the new event normally

Reports can still read valid events that precede a truncated tail. Invalid JSON in the middle of the ledger remains a hard error with its line number; Shadowbill never skips interior corruption.

The recovery sidecar contains aggregate event fragments only and receives the same owner-only file permissions as the ledger.
