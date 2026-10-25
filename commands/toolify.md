---
description: Turn the last working answer in this session into a reusable skill
argument-hint: "[which answer, optional]"
---

Read the procedure and follow it step by step:

```sh
sil_root="${CLAUDE_PLUGIN_ROOT}"
cat "${sil_root:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/self-improvement-loop}/skills/self-improvement-loop/toolify.md"
```

The operator's note, if any: $ARGUMENTS

Nothing is written before the operator says yes to the shown skill and ledger
row.
