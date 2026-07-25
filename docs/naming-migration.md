# Shadowbill-to-Proofwake naming migration

## Current state

Proofwake is the primary product and package identity. Shadowbill remains the name of the optional AI-usage estimate module and a temporary compatibility identity for existing installations.

This migration is deliberately split into reversible steps. Branding changes must not silently move data, replace credentials, or invalidate machine-readable interfaces.

## Command identity

The package exposes:

```text
proofwake   primary command
shadowbill  compatibility alias
```

Both currently execute the same CLI implementation. Human-facing output uses Proofwake first. The compatibility alias remains supported until a tagged release documents its removal horizon.

## Environment-variable precedence

Proofwake reads the new name first and then the legacy alias:

| Purpose | Primary | Compatibility alias |
| --- | --- | --- |
| Event ledger | `PROOFWAKE_DATA` | `SHADOWBILL_DATA` |
| Collector-token file | `PROOFWAKE_COLLECTOR_TOKEN_FILE` | `SHADOWBILL_COLLECTOR_TOKEN_FILE` |
| Direct collector token | `PROOFWAKE_COLLECTOR_TOKEN` | `SHADOWBILL_COLLECTOR_TOKEN` |
| Reporting timezone | `PROOFWAKE_TIMEZONE` | `SHADOWBILL_TIMEZONE` |
| GitHub webhook secret | `PROOFWAKE_GITHUB_WEBHOOK_SECRET` | `SHADOWBILL_GITHUB_WEBHOOK_SECRET` |
| Allowed HTTP hosts | `PROOFWAKE_ALLOWED_HOSTS` | `SHADOWBILL_ALLOWED_HOSTS` |
| MCP aggregate writes | `PROOFWAKE_MCP_ALLOW_WRITES` | `SHADOWBILL_MCP_ALLOW_WRITES` |

Rules:

1. An explicit CLI argument wins over environment configuration.
2. A `PROOFWAKE_*` value wins over its `SHADOWBILL_*` alias.
3. When both environment names are present, Proofwake reports that the legacy value was ignored.
4. When only a legacy name is present, it remains active and produces a bounded compatibility warning.
5. Warnings go to stderr so JSON and MCP stdout remain parseable.
6. Secret values are never included in status output or warnings.

## Storage selection

Default paths:

```text
~/.proofwake/events.jsonl
~/.proofwake/collector-token
```

Legacy paths:

```text
~/.shadowbill/events.jsonl
~/.shadowbill/collector-token
```

Without explicit configuration, Proofwake selects storage as follows:

1. If both default event ledgers exist, fail closed and require `--data` or `PROOFWAKE_DATA`.
2. If only the Proofwake ledger exists, use it.
3. If only the Shadowbill ledger exists, use it and its legacy token path in compatibility mode.
4. If neither exists, use the Proofwake defaults.

Proofwake never automatically concatenates, copies, renames, or deletes a ledger.

A custom path supplied through the legacy `SHADOWBILL_DATA` variable keeps the legacy default token path unless a token path is supplied explicitly. This preserves the old independent data/token configuration behaviour.

## Inspecting the active identity

```bash
proofwake status
proofwake status --json
```

The command reports:

- product and legacy alias;
- active data and token paths;
- the source of each selected path;
- active environment-variable names without their values;
- compatibility mode;
- default old and new paths;
- bounded warnings.

The command is read-only and does not create a ledger or token.

## Browser extension

The extension is presented as the **Proofwake Shadowbill Collector**.

Existing extension storage keys and the `ShadowbillConfig` JavaScript global remain supported. `ProofwakeConfig` is an alias over the same frozen configuration object. This avoids resetting saved collector URLs, tokens, model labels, and capture settings during the branding transition.

## Dashboard

The existing dashboard is labelled as Proofwake's optional Shadowbill estimate view. The future fleet dashboard will become the primary Proofwake home; the estimate view remains a secondary module.

## MCP

Existing `shadowbill_*` MCP tool names remain unchanged in this migration slice because MCP clients persist exact tool names. A later compatibility change may add Proofwake aliases before any legacy name is deprecated.

MCP stdout remains reserved for JSON-RPC. Compatibility notices must never be written there.

## Historical events

Stored event types, identifiers, hashes, and pricing-profile references do not change merely because the product name changed. Branding and schema version are separate concerns.

A future event-envelope migration must provide deterministic mapping and rebuild tests. It must not rewrite the current append-only ledger in place.

## Deferred explicit data migration

A future `proofwake migrate naming` command may move an installation to `~/.proofwake`, but it must satisfy all of these conditions:

- destination must not already contain an authoritative ledger or token;
- source identity and permissions must be inspected first;
- the ledger must be copied and verified before authority changes;
- collector-token bytes must never be printed;
- interrupted execution must leave one documented authoritative source;
- directory and file durability must be explicit;
- rollback instructions must be tested;
- old paths must not be deleted automatically in the first release;
- `proofwake status` must explain incomplete or dual-state migrations.

Until that command exists, users should keep the automatically selected legacy path or choose an explicit path themselves.
