# Read-only diagnostics

Run Shadowbill's local health check with:

```bash
node src/cli.js doctor
```

For machine-readable output:

```bash
node src/cli.js doctor --json
```

The command uses the same configuration options as the collector and report commands:

```bash
node src/cli.js doctor \
  --data ~/.shadowbill/events.jsonl \
  --collector-token-file ~/.shadowbill/collector-token \
  --pricing ./config/pricing.json \
  --model gpt-5.6-sol \
  --timezone America/Los_Angeles
```

`doctor` is fully read-only. It does not create a collector token, repair or truncate the ledger, remove a lock directory, append recovery records, or modify file permissions.

## Checks

The report covers:

- ledger existence, byte size, JSONL readability, event count, and latest valid event timestamp
- owner-only ledger permissions where the operating system exposes POSIX mode bits
- lock-directory presence, age, stale-lock threshold, and owner-metadata presence
- lock-owner metadata permissions without returning its token or process identifier
- recovery-sidecar readability, record count, latest recovery timestamp, size, and permissions
- collector-token source, file existence, size, timestamp, and permissions without reading or returning the token
- pricing-catalog readability and selected-model fields
- IANA report timezone validity
- a one-day report build using the selected pricing model and timezone

## Status and exit codes

The human and JSON reports distinguish three levels:

- `pass` — the check completed without action needed
- `warn` — the installation can operate, but attention may be useful
- `error` — the installation or selected configuration cannot be validated safely

Warnings return exit code `0`. Any error returns exit code `1`, which makes the command suitable for local scripts and support bundles.

## Privacy boundary

Diagnostics return aggregate counts, timestamps, file paths, byte sizes, permission modes, and configuration names. They never return ledger events, collector tokens, lock tokens, recovery bytes, prompts, responses, Git patches, or source code.
