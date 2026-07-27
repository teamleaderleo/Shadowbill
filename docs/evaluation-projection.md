# Evaluation evidence projection

## Purpose

`proofwake evaluation` rebuilds one task-specific evidence view from accepted evaluation observation receipts.

It is deliberately not a productivity score. It reports attributable marks, finding dispositions, coverage, confidence, uncertainty, and limitations for one repository and task class.

```bash
proofwake evaluation \
  --repo teamleaderleo/stensibly \
  --task-class oauth-client-lifecycle \
  --output json
```

An exact target run may be selected:

```bash
proofwake evaluation \
  --repo teamleaderleo/stensibly \
  --task-class oauth-client-lifecycle \
  --target-run run_w01_oauth_implementation_01
```

## Read boundary

The command reads one immutable JSONL ledger snapshot and performs no recovery, append, repair, migration, routing, or policy mutation.

A receipt contributes evidence only when:

- it is stored as an exact canonical `proofwake_observation` wrapper with no extra top-level or observation-identity fields;
- the wrapper ID, observation identity, timestamp, and fingerprint match the canonical observation-ledger representation;
- its accepted observation identity is unique within the selected ledger snapshot;
- the observation targets the selected repository and task class;
- the optional target-run filter matches;
- the merged evaluation-observation validator accepts the complete receipt.

Task-class and target-run scoping happens before malformed unrelated records are considered for exclusion. A broken receipt for another task class therefore does not change this task’s cursor or limitations.

Invalid or duplicate evaluation-looking records are excluded. Duplicate accepted identities have no winner: all duplicate candidates are excluded. Output reports only fixed exclusion codes and counts; it does not return rejected fact names, values, receipt bytes, wrapper extensions, or validator prose.

## Current state and receipt history

Receipts are immutable, but a mark or finding can be corrected or dispositioned by a later receipt.

For work evaluations, the current mark is the latest receipt for the same:

- rubric version;
- target run;
- evaluator run;
- facet.

For review findings, the current finding is the latest receipt for the same:

- rubric version;
- target run;
- evaluator run;
- finding ID.

Current marks and findings drive classifications, dispositions, open-finding state, confidence, uncertainty, coverage, and sufficiency. Historical receipts remain available through `markHistory` and `findingHistory`, so a correction never erases the prior evidence trail.

A later rejected or superseded finding clears a stale unresolved state. A current work mark classified `superseded` remains visible but does not count toward evidence sufficiency.

## Projection shape

JSON output includes:

- the exact repository, task class, and optional target run selection;
- a deterministic source cursor;
- selected, current, historical, and excluded receipt counts;
- exact target and evaluator run references;
- optional callsign, model-profile, and adapter-profile display metadata;
- current work marks and full mark history grouped by rubric version;
- classification, severity, first-pass, repair, confidence, uncertainty, evidence-class, independence, and coverage counts;
- current review findings and full finding history grouped by evaluator run and rubric version;
- individually retained current unresolved or repair-required findings;
- selected-receipt coverage and current-evidence coverage;
- declared coverage omissions;
- bounded limitations.

The human view reports the same current evidence, aggregate counts, coverage, open findings, exclusions, and limitations. JSON additionally retains the complete bounded receipt histories for machine inspection.

Rubric versions are never averaged together. Missing evidence is reported through coverage omissions and is not converted into a failure, zero, or negative mark.

## Evidence sufficiency

A rubric group becomes `evidence_available` only when its current non-superseded work marks cover at least two distinct target runs. Multiple receipts, facets, corrections, or evaluators for one target run remain visible but cannot satisfy the sample gate by themselves.

The top-level status is `evidence_available` when at least one rubric group meets that minimum. Other sparse or differently versioned groups remain visible with their own status and limitations.

This is only a minimum sample gate. It does not prove representativeness, model quality, reviewer quality, independence across producers, or readiness for broader work.

## Limitations

The projection can state:

- no rubric group covers two distinct non-superseded target runs;
- current evidence concentrated in one evaluator run;
- mixed rubric versions;
- current unresolved or repair-required findings;
- missing evidence and partial current coverage;
- invalid or duplicate receipts excluded;
- unknown task-selection bias.

These limitations are evidence, not authority decisions.

## Privacy and authority

Output excludes:

- prompts and responses;
- patches and raw review prose;
- logs, commands, and environment values;
- credentials;
- raw receipt bytes and wrapper extensions;
- ledger and filesystem paths;
- operating-system error text.

The projection does not assign work, route a task, promote assurance, approve or merge a candidate, deploy anything, or create a global worker, reviewer, model, pod, or developer score.

MCP, HTTP, dashboard, automated producer, and Stensibly routing surfaces remain separate reviewed slices.
