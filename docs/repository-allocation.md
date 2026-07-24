# Repository-level cost allocation

Shadowbill can group a rolling report by repository:

```bash
node src/cli.js report --days 30 --by-repository
```

For JSON:

```bash
node src/cli.js report --days 30 --by-repository --json
```

The loopback API exposes the same report:

```text
GET /v1/report?date=2026-07-25&days=30&group=repository
```

## Allocation method

The initial allocation basis is versioned as:

```text
same-day-added-code-tokens
```

For each calendar day in the selected timezone, Shadowbill:

1. calculates the day's existing working API-equivalent estimate;
2. totals `addedCodeTokens` from local `git_commit` events by repository;
3. divides that day's working estimate in proportion to those retained-code tokens;
4. leaves the entire day's estimate unallocated when no retained code was recorded.

The report preserves:

- total working estimate;
- allocated working estimate;
- unallocated working estimate;
- allocation coverage;
- allocation and unallocated day counts;
- per-repository retained code, commits, pushes, merged pull requests, successful CI runs, and successful deployments;
- allocated cost per commit, merged pull request, CI success, deployment, and retained code token.

## Interpretation boundary

This is a transparent heuristic allocation, not causal attribution. A same-day commit may include human work, work from several chats, or work produced earlier. A chat may also contribute to research, review, planning, or discarded code that never appears in a commit.

Unallocated cost is intentionally visible. Shadowbill does not spread days without retained-code evidence across repositories merely to make the totals look complete.
