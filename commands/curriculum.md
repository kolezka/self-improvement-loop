---
description: Preview or run curriculum promotion for the current world
argument-hint: [apply]
---

Arguments: `$1` is optional. Empty means a dry-run preview; `apply` runs it.

## No argument: dry-run preview

Run this, it makes no model calls and writes nothing:

```sh
sil_root="${CLAUDE_PLUGIN_ROOT}"
"${sil_root:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/self-improvement-loop}/scripts/sil" curriculum plan
```

Report each pattern's count, watermark and action (promote, refine, over-cap,
below-threshold, retire-candidate, done). Do not claim anything was staged.

## `$1` is `apply`: run it

This drafts, gates and stages branches. It never merges or pushes. Run it
detached, do not wait for it:

```sh
sil_root="${CLAUDE_PLUGIN_ROOT}"
nohup "${sil_root:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/self-improvement-loop}/scripts/sil" curriculum run --apply \
  > /dev/null 2>&1 &
```

Report that a curriculum run was triggered, not its result. Point to
`/loop` or `sil review list` to check on staged branches once it finishes.
