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

- it is stored as an exact canonical `proofwake_observation` wrapper with no extra fields;
- the wrapper ID, observation identity, timestamp, and fingerprint match the canonical observation-ledger representation;
- its observation identity is unique within the selected ledger snapshot;
- the observation targets the selected repository and task class;
- the optional target-run filter matches;
- the merged evaluation-observation validator accepts the complete receipt.

Invalid or duplicate evaluation-looking records are excluded. Output reports only fixed exclusion codes and counts; it does not return rejected fact names, values, receipt bytes, wrapper extensions, or validator prose.

## Projection shape

JSON output includes:

- the exact repository, task class, and optional target run selection;
- a deterministic source cursor;
- selected work-evaluation and review-finding counts;
- exact target and evaluator run references;
- optional callsign, model-profile, and adapter-profile display metadata;
- work marks grouped by rubric version;
- classification, severity, first-pass, repair, confidence, uncertainty, evidence-class, independence, and coverage counts;
- review findings grouped by evaluator run and rubric version;
- individually retained unresolved or repair-required findings;
- declared coverage omissions;
- bounded limitations.

Rubric versions are never averaged together. Missing evidence is reported through coverage omissions and is not converted into a failure, zero, or negative mark.

## Evidence sufficiency

A rubric group becomes `evidence_available` only when it contains work-evaluation evidence for at least two distinct target runs. Multiple receipts, facets, corrections, or evaluators for one target run remain visible but cannot satisfy the sample gate by themselves.

The top-level status is `evidence_available` when at least one rubric group meets that minimum. Other sparse or differently versioned groups remain visible with their own status and limitations.

This is only a minimum sample gate. It does not prove representativeness, model quality, reviewer quality, independence across producers, or readiness for broader work.

## Limitations

The projection can state:

- no rubric group covers two distinct target runs;
- evidence concentrated in one evaluator run;
- mixed rubric versions;
- unresolved or repair-required findings;
- missing evidence and partial coverage;
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
