# Evaluation observations v1

## Status

This document defines the first executable ProofWake mapping for Stensibly work evaluation and review-finding disposition records.

It is a narrow extension contract over [observation v1](observation-v1.md). The common envelope remains authoritative for JSON parsing, byte and depth limits, identity, replay, time, repository/revision binding, evidence references, coverage, and content minimisation.

The specialised reference validator lives at `src/evaluation-observation.js`. The structural schema overlay lives at `schema/evaluation-observation-v1.schema.json`. The JavaScript validator is authoritative for the closed fact-name sets, exact scalar types and ranges, enum values, run-reference grammar, and cross-field relations.

## Why this uses observation v1 now

The minimum evaluation loop should work before a new server, dashboard, or write API exists.

Both receipt families are valid observation-v1 documents with:

- `data.kind: "domain-check"`;
- one exact repository-revision subject;
- one exact target run in `data.relationships.run`;
- a separate exact evaluator run fact;
- short namespaced scalar facts from a closed v1 allowlist;
- bounded evidence references;
- explicit coverage, confidence, uncertainty, and omissions.

That means current installations can append a fixture immediately:

```bash
node src/main.js emit \
  --json test/fixtures/observations/stensibly-work-evaluation-repair-v1.json \
  --output json
```

The planned opt-in MCP and HTTP write surfaces must call the same canonical ingestion path. They do not define a second ledger format.

## Durable attribution

Evaluation joins use exact run references, not callsigns.

Required common identity facts:

- `proofwake.evaluation.target-run` — exact `run_...` reference for the work being evaluated;
- `proofwake.evaluation.evaluator-run` — exact `run_...` reference for the evaluator or review execution.

`data.relationships.run` must equal `proofwake.evaluation.target-run`. An `independent` receipt must use distinct target and evaluator runs.

Optional display-only facts are:

- `proofwake.evaluation.target-callsign`;
- `proofwake.evaluation.evaluator-callsign`.

Callsigns may be reused, inherited, reformatted, or collide. They are presentation metadata and must never be used as durable actor, run, authority, responsibility, or identity-continuity keys.

## Required common facts

Both receipt families require exactly these common semantic facts:

- `proofwake.evaluation.schema-version` — integer `1`;
- `proofwake.evaluation.task-class` — bounded token;
- `proofwake.evaluation.rubric-version` — bounded token;
- `proofwake.evaluation.target-run` — exact target run reference;
- `proofwake.evaluation.evaluator-run` — exact evaluator run reference;
- `proofwake.evaluation.independence`;
- `proofwake.evaluation.evidence-class`;
- `proofwake.evaluation.confidence`;
- `proofwake.evaluation.uncertainty`.

The only optional common v1 facts are:

- `proofwake.evaluation.target-callsign` — display metadata;
- `proofwake.evaluation.evaluator-callsign` — display metadata;
- `proofwake.evaluation.model-profile` — bounded producer-declared model/profile reference when known;
- `proofwake.evaluation.adapter-profile` — bounded adapter/profile reference when known.

No other fact name is accepted. A new fact requires a new reviewed contract revision rather than silent producer-specific expansion.

## Receipt families

### `proofwake.work.evaluation.observed.v1`

One attributable evaluation mark about an exact worker/run result.

Required work-evaluation facts:

- `proofwake.evaluation.facet`;
- `proofwake.evaluation.classification`;
- `proofwake.evaluation.severity`;
- `proofwake.evaluation.accepted-first-pass`;
- `proofwake.evaluation.repair-count` — integer `0..1000`.

Initial classifications are:

- `accepted`;
- `repair-required`;
- `rejected`;
- `superseded`;
- `unresolved`;
- `retained-partial`;
- `operator-corrected`.

### `proofwake.review.finding.dispositioned.v1`

One later disposition of an exact review finding about the target run.

Required review-finding facts:

- `proofwake.review.finding-id`;
- `proofwake.review.finding-class`;
- `proofwake.review.disposition`;
- `proofwake.review.severity`;
- `proofwake.review.clearing-condition`.

Initial dispositions are:

- `unresolved`;
- `upheld-repair-required`;
- `upheld-and-repaired`;
- `accepted-residual-risk`;
- `rejected`;
- `duplicate`;
- `superseded`;
- `downstream-confirmed`.

A finding receipt does not prove the reviewer was globally good or the target worker was globally bad. It records one exact finding and its current disposition.

## Common classes

Evidence classes:

- `observed`;
- `inferred`;
- `human-annotated`.

Independence classes:

- `independent`;
- `self-report`;
- `deterministic-tool`;
- `human-annotation`;
- `conflicted`.

Confidence classes:

- `high`;
- `medium`;
- `low`;
- `unknown`.

Uncertainty classes:

- `none`;
- `bounded`;
- `material`;
- `disputed`;
- `unknown`.

Severity classes:

- `none`;
- `low`;
- `medium`;
- `high`;
- `critical`.

Evidence class states how the mark was obtained. Confidence states the producer's bounded support level. Uncertainty states whether known limitations or disagreement materially qualify the mark. Coverage and omissions remain separate: partial coverage does not automatically mean low confidence, and high confidence does not erase missing evidence.

These are rubric inputs, not authority grants.

## Closed fact boundary

The specialised validator rejects:

- unknown fact names, including privacy-sensitive names such as `proofwake.evaluation.prompt`;
- review facts on work-evaluation receipts;
- work-evaluation facts on review-finding receipts;
- callsign-only attribution when exact target/evaluator runs are absent;
- malformed run references;
- a `relationships.run` value that differs from the target-run fact;
- an `independent` receipt whose target and evaluator runs are the same;
- missing or unsupported confidence and uncertainty classes.

The schema overlay mirrors the family-specific name unions for tooling, but the JavaScript validator remains the executable semantic authority.

## Evidence boundary

The observation stores identifiers, bounded classifications, counts, booleans, and references. It does not store:

- prompts or responses;
- source patches;
- arbitrary review prose;
- command output or logs;
- credentials or environment values;
- private chain-of-thought;
- raw provider payloads.

`data.evidence` should reference a bounded source receipt or derived record. The digest applies to that declared evidence object, not to an inaccessible provider page merely because its URI is listed.

## Identity and replay

The observation identity remains `(source, id)`. A producer should make the ID stable for the semantic mark or finding disposition.

An identical replay returns the original accepted effect. Reusing the same identity with changed facts, evidence, revision, run attribution, confidence, uncertainty, or coverage is a conflict. A correction must use a fresh event identity and correlate to the earlier observation.

## Evaluation is not authority

An accepted receipt does not:

- assign work;
- transfer responsibility;
- grant a claim, lease, approval, or capability;
- promote an assurance tier;
- accept or merge a candidate;
- deploy or remediate anything;
- create a universal worker, model, reviewer, pod, or developer score.

Stensibly owns coordination and policy decisions. ProofWake records and projects evidence.

## Initial fixtures

The first two fixtures are content-minimised manual backfills from Stensibly PR #308:

- `stensibly-work-evaluation-repair-v1.json` records one implementation-correctness repair mark;
- `stensibly-review-finding-upheld-v1.json` records one transaction-boundary finding whose current disposition is `upheld-repair-required`.

Both fixtures bind the exact target and evaluator runs separately. `Forge` and `Relay` are retained only as optional display metadata. They intentionally omit model/profile, cost, latency, repair revision, and downstream outcome evidence. Those omissions remain visible instead of being treated as passing or zero.
