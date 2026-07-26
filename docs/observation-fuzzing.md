# Observation boundary fuzzing

Proofwake includes a deterministic, dependency-free mutation harness for the observation command-line boundary.

```bash
node scripts/fuzz-observation-cli.mjs
node scripts/fuzz-observation-cli.mjs 80 20260726
```

The optional arguments are:

1. mutation count, from 1 through 4096;
2. unsigned 32-bit deterministic seed.

The command first submits one valid observation to prove the selected executable path works and confirms that exactly one ledger entry was accepted. It then creates an isolated ledger for every mutated input and requires each mutation to:

- exit with failure;
- return one parseable machine-mode JSON object;
- write nothing to stderr;
- return `status: "error"`;
- expose a stable `OBSERVATION_*` error code;
- create zero accepted ledger entries;
- avoid echoing the private mutation sentinel in machine output.

The corpus covers:

- duplicate keys at top-level and nested depths;
- unknown fields;
- malformed JSON and trailing content;
- excessive input bytes and nesting depth;
- relationship conflicts;
- invalid subjects, timestamps, identifiers, enum values, and token values;
- malformed evidence digests;
- duplicate facts;
- wrong container types;
- missing required fields;
- non-finite numbers.

Every mutation uses a fresh ledger. A semantically valid mutation therefore cannot hide behind an idempotency conflict from another case. The first pass walks each operator in order; additional iterations use the seeded generator. The harness fails whenever any declared operator has zero hits, including runs whose iteration count is too small to cover the corpus.

CI runs 80 mutations with seed `20260726`. The JSON summary reports `mutationOperators`, `operatorsExercised`, `selectedOperatorIndexes`, `missingOperatorIndexes`, per-operator hit counts, and the observed error-code distribution. The seed and iteration count make failures reproducible locally. The legacy `operatorCount` and `exercisedOperators` fields remain aliases for compatibility. This harness complements focused parser unit tests; it does not replace schema-specific assertions or external coverage-guided fuzzers.

When adding a mutation operator:

1. make the generated document unambiguously invalid;
2. keep the operator deterministic;
3. avoid embedding secrets or local paths in diagnostics;
4. use a fresh stable error code only when callers need to distinguish the failure;
5. add a focused regression whenever the mutation reveals an implementation defect.
