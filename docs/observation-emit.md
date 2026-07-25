# Local observation emission

`proofwake emit` appends one observation-v1 event to the active local Proofwake ledger.

It uses the normative contract in [observation-v1.md](observation-v1.md), the existing strict parser and validator, and the atomic `ObservationLedger` replay rules.

## Usage

From an installed package:

```bash
proofwake emit --json observation.json
cat observation.json | proofwake emit --stdin
```

During repository development:

```bash
npm run emit -- --json test/fixtures/observations/renderprove-browser-review-passed-v1.json
```

Choose exactly one input source. `--data PATH` selects an explicit ledger. Otherwise the normal Proofwake/Shadowbill compatibility rules select the active ledger.

## Acceptance behaviour

A successful command prints one JSON line:

```json
{
  "accepted": true,
  "duplicate": false,
  "source": "urn:proofwake:adapter:renderprove",
  "id": "renderprove.fixture-web-app.aaaaaaaaaaaaaaaa",
  "fingerprint": "sha256:...",
  "ingestedAt": "2026-07-25T18:00:00.000Z"
}
```

The command sets `data.ingestedAt` to the local acceptance time before validation and storage. The input must still be a valid observation-v1 document; its supplied `ingestedAt` value is treated as a schema-valid placeholder and is replaced at the boundary.

The semantic fingerprint excludes ingestion time. Therefore:

- the first accepted `(source, id)` is inserted;
- an identical replay returns `duplicate: true` and the original stored ingestion time;
- changed semantics under the same `(source, id)` fail with `OBSERVATION_ID_CONFLICT`;
- similar timestamps, subjects, facts, or evidence never create heuristic duplicates.

## Input boundary

The emitter:

- accepts a regular file or standard input;
- rejects symbolic-link file inputs where the platform exposes `O_NOFOLLOW`;
- rejects non-regular files;
- rejects input larger than 65,536 bytes before parsing;
- rejects invalid UTF-8;
- retains the observation parser's nested duplicate-key and depth checks;
- never echoes the rejected body to stderr.

Errors use a stable prefix:

```text
OBSERVATION_INVALID_UTF8: Observation input must be valid UTF-8.
```

## Compatibility

The package command `proofwake` routes through a thin wrapper that adds `emit`. Every other Proofwake command delegates to the existing CLI.

The legacy `shadowbill` binary continues to point directly to the historical CLI. Existing environment aliases, data paths, hooks, reports, MCP tools, and estimate events remain unchanged.

Observation records use the existing `proofwake_observation_<sha256(source + NUL + id)>` ledger identity, so their source-scoped identity does not collide with legacy Shadowbill event IDs.

## Privacy

Successful output contains only acceptance status, duplicate state, source identity, event ID, fingerprint, and ingestion time.

It excludes:

- the event body;
- fact values;
- evidence URIs;
- local data paths;
- prompts and responses;
- source patches and command output;
- secrets and environment values.
