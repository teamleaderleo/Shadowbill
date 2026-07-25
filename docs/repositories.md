# Repository enrolment and inventory

Proofwake keeps repository policy separate from observation data. Enrolment records which repositories belong to the local fleet, which evidence signals they expect, and which source approved that policy.

## Commands

Preview an enrolment without writing the registry:

```bash
proofwake enroll /path/to/project --dry-run
```

Approve and record it:

```bash
proofwake enroll /path/to/project
```

Use explicit identity when a repository has multiple canonical remotes or no portable remote identity:

```bash
proofwake enroll /path/to/project --repository owner/name
```

Move an existing repository identity to a reviewed checkout:

```bash
proofwake enroll /new/path/to/project --replace
```

Read the fleet inventory:

```bash
proofwake repositories
proofwake repositories --output json
```

The default registry is `repositories.json` beside the active observation ledger. Choose another private registry with `--registry PATH`. `--data PATH` selects the corresponding observation ledger through the existing Proofwake and Shadowbill compatibility rules.

## Policy sources

### Committed policy

A repository may commit `.proofwake.json`. This file is authoritative after explicit enrolment. Proofwake re-reads it for inventory reports so reviewed repository changes take effect without copying policy into the observation ledger.

The committed file must be a tracked, clean, regular UTF-8 JSON file inside the checkout. Untracked or locally modified policy remains a proposal instead of authoritative configuration. Symbolic links, duplicate keys, unsupported versions, unknown fields, oversized input, and invalid adapter paths fail closed.

### Approved global policy

When `.proofwake.json` is absent, `proofwake enroll` proposes a global policy from bounded checkout facts:

- a recognised language or package marker proposes required `verify` evidence;
- GitHub workflow files propose optional `github-ci` evidence;
- a Renderprove manifest proposes optional `browser-review` evidence and its receipt path;
- `vercel.json` proposes optional `deployment` evidence.

Autodetection produces a proposal. `--dry-run` writes nothing. Running `enroll` without `--dry-run` is the explicit approval that stores the normalized policy in the private global registry.

If a committed `.proofwake.json` later appears beside an approved global policy, the inventory reports a configuration conflict. Enrol again to adopt the committed policy.

## Repository identity

Identity selection follows this order:

1. committed `.proofwake.json`;
2. `--repository owner/name`;
3. canonical `origin` remote;
4. one unique canonical remote;
5. a local identity derived from checkout name and a digest of its real path.

Multiple canonical remotes without a usable `origin` require `--repository`. Remote URLs are normalized before use; credentials, query strings, fragments, transport syntax, and raw URLs stay out of the registry report.

A local identity begins with `local/`. It is useful for experiments and repositories without a remote. Moving that checkout changes its proposed local identity, so a committed or explicit portable identity is preferable for long-lived projects.

## Policy v1

The schema is [`schema/repository-v1.schema.json`](../schema/repository-v1.schema.json). A complete example is [`examples/proofwake.repository.json`](../examples/proofwake.repository.json).

```json
{
  "$schema": "https://raw.githubusercontent.com/teamleaderleo/proofwake/main/schema/repository-v1.schema.json",
  "version": 1,
  "repository": "owner/project",
  "lifecycle": "active",
  "expectedSignals": [
    {
      "kind": "verify",
      "required": true,
      "staleAfterHours": 0,
      "scope": "revision"
    }
  ],
  "adapters": {}
}
```

`staleAfterHours: 0` disables age-based expiry. Revision-scoped evidence still stops satisfying policy when the selected revision changes.

Signal scopes are:

- `revision`;
- `default-branch`;
- `release`;
- `deployment`;
- `repository`;
- `host`.

Each signal kind may appear once in v1. Adapter paths use portable project-relative segments. Absolute paths, parent traversal, backslashes, empty segments, and symbolic-link escape are rejected.

## Private registry

The registry records:

- canonical repository identity;
- real checkout root and filesystem identity;
- committed or global configuration source;
- normalized policy and SHA-256 digest;
- explicit approval time and method.

The file is written atomically with owner-only permissions where supported. Writers coordinate through a private lock directory. Registry reads reject symbolic links and verify the opened file identity before parsing. Duplicate repository identities and duplicate roots fail closed. Replacing a checkout requires `--replace`.

Checkout roots are private metadata. They remain in the local registry and never enter observation events or fleet exports unless the caller explicitly requests the local inventory response.

## Inventory states

`proofwake repositories` reports one classification per enrolled repository:

- `active` — current policy is readable and at least one relevant observation or legacy delivery event exists;
- `dormant` — policy explicitly declares the repository dormant;
- `unobserved` — policy is valid and no relevant event has arrived;
- `misconfigured` — root identity, committed policy, adapter path, or registry policy cannot be trusted.

The report also includes:

- latest known revision and activity time;
- policy source and approval provenance;
- adapter path readiness;
- accepted observation and legacy-event coverage;
- each expected signal as passing, failing, warning, unavailable, missing, or stale;
- green, red, yellow, or grey policy health;
- one evidence-based attention reason.

Every signal result retains the exact accepted observation identity that produced it. A repository can remain active while required evidence is yellow or red. Activity and evidence health answer different questions.
