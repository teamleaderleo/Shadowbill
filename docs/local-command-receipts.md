# Local command receipts

`proofwake run` executes one reviewed argument vector and records a bounded terminal observation for the selected repository revision.

```bash
proofwake run \
  --repo owner/project \
  --kind verify \
  -- npm test
```

Choose another working directory, timeout, ledger, or output mode explicitly:

```bash
proofwake run \
  --repo owner/project \
  --kind domain-check \
  --cwd /path/to/checkout \
  --timeout-seconds 900 \
  --data /path/to/events.jsonl \
  --output json \
  -- npm run verify
```

## Execution boundary

The command is launched with `shell: false`. The values after `--` form the exact executable and argument vector. Proofwake does not create a shell command string.

The child inherits the caller environment so ordinary developer tools continue to work. Environment names and values remain outside the observation. Proofwake adds only `PROOFWAKE_RUN_ACTIVE` to prevent recursive wrappers.

Standard output and standard error remain visible to the caller. In JSON mode both child streams are routed to stderr, leaving stdout for one machine-readable Proofwake response.

Each stream has a one MiB visibility limit. Crossing a limit terminates the direct child, escalates to `SIGKILL` after a bounded delay, records `output-limit`, and marks receipt coverage as truncated. Raw output stays outside the ledger.

## Repository and revision binding

Proofwake resolves the canonical Git root and exact `HEAD` revision from `--cwd`, which defaults to the current directory.

The working-directory argument must identify a real directory directly. Symbolic-link working directories are rejected. When canonical Git remotes exist, `--repo owner/name` must match one of them. A checkout without a canonical remote uses explicit local-operator binding.

Detached HEAD and dirty-worktree state are recorded as booleans. Proofwake still binds the receipt to the exact revision; it does not fabricate a branch relationship.

## Receipt contents

The observation contains:

- repository, exact revision, run identity, signal kind, and terminal status;
- source, start, completion, ingestion, and duration times;
- child exit code, signal, and stable failure class;
- executable, argument-vector, and working-directory SHA-256 identities;
- argument count and bounded stdout/stderr byte and line counts;
- timeout, cancellation, output-limit, dirty-worktree, detached-HEAD, and repository-binding flags;
- explicit booleans stating that arguments, environment, stdout, and stderr were excluded.

The ledger contains no raw argument values, environment values, stdout, stderr, shell history, or absolute working-directory path.

## Exit contract

A passing child returns exit code `0`. An ordinary nonzero child exit is preserved after the receipt is stored.

Proofwake reserves:

- `124` for timeout;
- `125` for output limit;
- `127` for spawn failure;
- `128 + signal` for cancellation or signal termination when the platform exposes a signal number;
- `2` for Proofwake usage, validation, repository-binding, or persistence errors.

Every child terminal path attempts receipt persistence before the CLI returns its terminal exit code.

## Replay and run IDs

Proofwake generates a random run ID by default. Supply a stable token when a caller needs retry-after-response-loss behaviour:

```bash
proofwake run \
  --run-id verify-2026-07-26-01 \
  --repo owner/project \
  --kind verify \
  -- npm test
```

When that run ID already identifies the same repository, revision, kind, argument-vector digest, and working-directory digest, Proofwake returns the stored result without executing the child again. Reusing the ID for different semantics fails with `PROOFWAKE_RUN_ID_CONFLICT`.

## Current limits

Version 1 records one terminal command observation. Declared artifact digests, external log references, process-group termination, and crash recovery between child completion and ledger acknowledgement remain later slices.
