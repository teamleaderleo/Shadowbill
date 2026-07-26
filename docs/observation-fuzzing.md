# Observation boundary fuzzing

Proofwake includes a deterministic, dependency-free mutation harness for the observation command-line boundary.

```bash
node scripts/fuzz-observation-cli.mjs
node scripts/fuzz-observation-cli.mjs 512 20260726
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

- top-level and nested duplicate keys;
- unknown fields;
- trailing content and invalid escapes;
- excessive nesting and input bytes;
- subject/revision conflicts;
- invalid enum and token values;
- duplicate fact names;
- malformed evidence digests;
- coverage shape violations;
- oversized identifiers;
- invalid timestamps and types;
- non-finite numeric input;
- missing required fields.

Every mutation uses a fresh ledger. A semantically valid mutation therefore cannot hide behind an idempotency conflict from another case. The first pass walks each operator in order; additional iterations use the seeded generator. CI asserts that every declared operator ran at least once.

CI runs a fixed seed and records operator hits plus the observed error-code distribution. The seed and iteration count make failures reproducible locally. This harness complements focused parser unit tests; it does not replace schema-specific assertions or external coverage-guided fuzzers.

When adding a mutation operator:

1. make the generated document unambiguously invalid;
2. keep the operator deterministic;
3. avoid embedding secrets or local paths in diagnostics;
4. use a fresh stable error code only when callers need to distinguish the failure;
5. add a focused regression whenever the mutation reveals an implementation defect.
