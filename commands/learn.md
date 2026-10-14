---
description: Turn a mistake caught in this session into a rule, skill, agent or nudge
argument-hint: "[what went wrong, optional]"
---

Read the procedure and follow it step by step:

```sh
cat "${CLAUDE_PLUGIN_ROOT}/skills/self-improvement-loop/learn.md"
```

The operator's note, if any: $ARGUMENTS

Nothing is written before the operator says yes to the shown diff. The one
exception is a nudge draft in a fresh `mktemp -d` directory, which the
procedure describes. That directory is removed only after register succeeds or
the operator says no; if register refuses, it is kept for the retry.
