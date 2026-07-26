# Live local Git ingestion

## Scope

`proofwake ingest-git` records the current `HEAD` commit from one local checkout. This path is intentionally separate from GitHub webhook ingestion and historical import.

The collector first resolves Git's canonical top-level directory, even when the command is invoked from a nested working directory. It calculates bounded change counts and an optional retained added-code token estimate from the local patch. Source content is used only during collection and is not copied into observation v1.

## Canonical GitHub-backed repositories

When `origin` is an actual `github.com` remote whose path resolves to a canonical `owner/name` identity, live ingestion:

1. keeps `collectHeadCommit()` available as the legacy compatibility API;
2. maps the collected legacy-shaped event with `mapGitCommitObservation()`;
3. appends the observation through `ObservationLedger`;
4. writes exactly one durable `proofwake_observation` record.

It never appends a second `git_commit` representation for the same ingestion. A remote on another host cannot obtain GitHub repository authority merely because its path resembles `owner/name`.

The observation identity is derived from the exact repository and full revision. Therefore:

- replaying the same repository revision returns `duplicate` and does not append another row;
- reusing that identity with different mapped semantics fails with `OBSERVATION_ID_CONFLICT`;
- the same commit SHA in two repositories remains two distinct observations.

## Local-only compatibility fallback

Observation v1 currently requires the canonical GitHub `owner/name` relationship used by the merged Git activity mapper. A checkout without that authority, including a checkout with only a non-GitHub remote, cannot be represented honestly by this live observation path.

For that case, live ingestion writes one legacy `git_commit` compatibility record. The repository field is a path-private identity using the same shape as local repository enrolment:

```text
local:sha256:<canonical-root-digest>
```

The checkout directory name and canonical path are not retained. The fallback event identity is derived from this local identity plus the full revision, so invocation from the repository root or any nested directory produces the same durable effect. Commit subject and branch values are blanked before persistence.

CLI output identifies the format as `legacy-git-commit` and includes:

- insert or duplicate status;
- digest-backed local repository identity;
- full revision;
- legacy event identity;
- compatibility reason `local-only-repository-identity`.

This fallback does not widen observation v1 and does not rewrite historical rows.

## Machine output

Successful canonical ingestion returns one JSON document similar to:

```json
{
  "service": "proofwake",
  "command": "ingest-git",
  "format": "observation-v1",
  "status": "inserted",
  "repository": "owner/repo",
  "revision": "0123456789012345678901234567890123456789",
  "identity": {
    "source": "urn:proofwake:adapter:git",
    "id": "git-commit-..."
  },
  "fingerprint": "sha256:..."
}
```

Exact replay changes `status` to `duplicate`. Identity conflict returns bounded JSON with status `error` and code `OBSERVATION_ID_CONFLICT`.

## Privacy boundary

Neither observation records nor `ingest-git` machine output retain:

- commit subjects or bodies;
- patches or changed paths;
- Git commands or command output;
- checkout paths or directory names;
- remote URLs;
- embedded remote credentials.

Observation facts are limited to additions, deletions, changed-file count, and optional retained-code token count. The local-only legacy fallback uses a digest-backed root identity and blanks subject and branch fields before appending.

## Post-commit hook

`proofwake hook install --repo PATH` preserves an existing supported shell hook and adds one background invocation of `ingest-git`. Repeated installation is idempotent.

The hook uses the same storage selection rules as the CLI. Set `PROOFWAKE_DATA` when a non-default ledger is required. Canonical GitHub checkouts write observation v1; other checkouts use the bounded legacy fallback.

## Report compatibility

Estimate and repository-allocation reports consume the read-only activity compatibility view. A ledger may therefore contain historical legacy events, new Git observations, and local-only fallback events without changing report readers or double-counting an observation and matching legacy representation.
