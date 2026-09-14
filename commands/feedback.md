---
description: Record a good or bad vote on an artifact
argument-hint: <type>:<name> good|bad [note]
---

Arguments: `$1` is `<type>:<name>` (e.g. `skill:verify-callsites`,
`hook:worktree-wrong-tree-edit`, `agent:explorer`, `rule:evidence-level`),
`$2` is `good` or `bad`, the rest of `$ARGUMENTS` after those two is an
optional note.

If `$1` is missing or not in `<type>:<name>` shape, ask the user for the
artifact reference instead of guessing one. Do not invent a ref from context.

If `$2` is missing or is not `good`/`bad`, ask which one before running
anything.

Resolve the world from the current working directory, then record the vote:

```sh
uv run --project "${CLAUDE_PLUGIN_ROOT}" sil feedback add "$1" "$2" --note "<note>"
```

`sil feedback add` resolves `--world` from `$PWD` when not given explicitly.
Report the single line the command prints back. Do not claim the vote changed
any artifact; it only feeds the next promotion planning pass.
