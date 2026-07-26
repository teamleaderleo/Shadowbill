# Observation boundary testing

## Purpose

Proofwake observation v1 is a strict, content-minimised interchange boundary. Numeric and Unicode handling must remain deterministic across direct validation, JSON parsing, stream decoding, and the installed `proofwake emit` command.

The focused boundary matrix lives in `test/observation-boundary-matrix.test.js`.

## Numeric contract

The matrix locks the exact accepted limits for every numeric observation-v1 field:

- adapter mapping version: `0..65535`;
- workflow attempt: `0..1000000`;
- observation duration: `0..31536000000` milliseconds;
- evidence size: `0..1000000000000` bytes;
- numeric facts: JavaScript safe integers from `-9007199254740991` through `9007199254740991`.

For each bounded field, tests accept both endpoints and reject:

- the value immediately below the lower bound;
- the value immediately above the upper bound;
- fractional values;
- unsafe integer values where applicable;
- non-finite values produced by extreme JSON exponents.

Raw JSON literals are tested separately so parsing cannot round or overflow a value into an accepted semantic observation.

## Unicode contract

Observation input is UTF-8. File and stream readers use fatal UTF-8 decoding before JSON parsing.

The matrix rejects representative malformed byte classes:

- isolated continuation bytes;
- overlong encodings;
- truncated multibyte sequences;
- UTF-8 encodings of surrogate code points;
- code points above the Unicode maximum.

The installed CLI must return bounded `OBSERVATION_INVALID_UTF8` JSON, disclose none of the rejected input, and create no ledger effect.

Valid Unicode scalar values remain available in fields whose observation-v1 grammar permits them. The matrix verifies both literal UTF-8 and an escaped surrogate pair representing the same scalar value. It also verifies that duplicate JSON keys are detected after Unicode escapes are decoded, so `id` and `\u0069d` cannot bypass duplicate-key rejection.

## Boundaries

This testing slice does not:

- add Unicode normalisation or confusable-character folding;
- widen ASCII identity, subject, fact-name, or token grammars;
- change observation-v1 field limits;
- change live Git or GitHub ingestion;
- change ledger, report, server, dashboard, or MCP behaviour.

Those decisions remain separate schema or product changes. This matrix protects the implemented v1 boundary as it exists today.
