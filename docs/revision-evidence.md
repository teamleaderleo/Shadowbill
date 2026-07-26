# Revision evidence and fleet projections

Proofwake rebuilds read-only evidence projections from one snapshot of the enrolled repository registry and accepted observation ledger.

```bash
proofwake inspect --repo owner/project
proofwake inspect FULL_REVISION --repo owner/project --output json
proofwake fleet
```

The reports contain no universal score. They explain declared policy, selected revisions, accepted observations, coverage gaps, failures, and recoveries.

## Revision selection

`inspect` selects revisions in this order:

1. an explicit full revision supplied positionally or with `--revision`;
2. the enrolled checkout's current revision;
3. the latest accepted observation revision when the checkout revision is unavailable.

When the local Git object exists, the report names whether the selected revision is current, an ancestor, a descendant, or diverged from the checkout revision. Missing or shallow-clone objects remain visible as `object-missing` instead of being treated as verified ancestry.

Default-branch policy requires an explicit local remote HEAD whose remote belongs to the enrolled repository identity. A branch name such as `main` or `master` creates no authority by itself. An `origin/HEAD` belonging to a fork also cannot satisfy policy for another enrolled repository. Deployed-revision, release, host, service, and deployment selectors remain visibly unavailable in projection v1 until their selection contracts exist.

## Signal states

Each declared policy signal reports one of:

- `passed` — fresh passing evidence with complete coverage;
- `failing` — the latest accepted evidence is failed or cancelled;
- `missing` — no accepted observation matches kind, source, subject, and selected revision;
- `stale` — duration-based passing evidence exceeded its declared freshness window;
- `partial` — the latest accepted evidence has partial coverage;
- `unavailable` — evidence or coverage is unavailable;
- `warning` — the latest accepted evidence carries a producer warning or unknown result;
- `selection-unavailable` — Proofwake cannot select the policy's subject confidently.

Required signals determine revision status:

- `green` — every required signal passes;
- `red` — at least one required signal currently fails;
- `yellow` — required evidence is missing, stale, partial, unavailable, warning, blocked by selection, or accompanied by repository configuration problems;
- `grey` — the repository is declared dormant or remains wholly unobserved.

Every signal includes its policy, latest observation identity, source trust, coverage, evidence references, attempt history, and reason.

## Attempts and time intervals

For each signal, Proofwake reports:

- accepted attempt count and rerun count;
- provider workflow-attempt numbers when present;
- first observation time;
- first passing time;
- time from first evidence to first passing evidence;
- terminal failures after the latest accepted pass;
- a bounded recent history.

Source-clock intervals use `observedAt`. Delivery intervals use `ingestedAt`. Equal timestamps are ordered deterministically by source and event identity.

`firstGreenAt` is the first observed time when every required signal passed simultaneously. A pass that had already been superseded by failure cannot combine with a later signal pass to invent a green interval. When bounded history prevents a complete determination, the report marks time-to-green confidence as `bounded-history`.

## Recovery

A same-revision failure followed by a current pass is reported as `same-revision-rerun`. Sequence proves that a later accepted pass superseded the earlier failure under the selected policy; it does not prove why the result changed.

A failure on an ancestor revision followed by a current pass on the selected descendant is reported as `descendant-correction` only when local Git ancestry verifies the relationship. Its causality remains `unproven`: ancestry supports the recovery relationship, while timing alone never proves which change corrected the failure.

A later failure removes the current recovery claim while retaining every earlier attempt in history. Diverged revisions, missing Git objects, and unavailable ancestry checks do not become correction recoveries. Ambiguous candidates remain visible.

## Fleet projection

`proofwake fleet` reports every enrolled repository with:

- active, dormant, unobserved, or misconfigured classification;
- selected revision and ancestry confidence;
- green, red, yellow, or grey status;
- current required failure;
- missing, stale, partial, unavailable, warning, or selector-unavailable required evidence;
- recent current recovery;
- one evidence-based attention reason.

Fleet status uses `grey` for dormant and wholly unobserved repositories. Misconfigured repositories remain yellow and cannot blank unrelated panels. Attention order groups red, yellow, and grey repositories without converting activity into value or productivity.

## Deterministic rebuild

Each command reads the registry and ledger once, then performs the complete rebuild from those immutable in-memory snapshots. Concurrent appends appear in the next command rather than producing a mixed report.

Projection version 1 exposes SHA-256 source cursors derived from:

- the normalized repository-policy fingerprint;
- the selected revision;
- sorted accepted event identities and request fingerprints;
- stable checkout relation and selector authority;
- configuration problem codes and paths.

Evaluation-only age and generation time stay outside the cursor. Reordered delivery produces the same cursor and report ordering, while a changed checkout relation or verified remote HEAD changes the cursor. Projection failures never rewrite the observation ledger.

## Current limits

Projection v1 supports exact-revision and repository subjects, verified current default-branch selection, accepted Proofwake observations, and compatible GitHub workflow/deployment events.

Later slices will add historical default-branch membership, deployed-revision and release selectors, host/service/deployment subject selection, richer provider lineage, repository rename relationships, force-push history, persistent projection caches, and native receipt adapters.
