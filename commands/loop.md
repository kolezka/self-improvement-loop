---
description: Show loop status, or start the web UI / trigger a worker pass
argument-hint: [web|run]
---

Arguments: `$1` is optional, one of `web`, `run`, or empty.

## No argument: status

Run and print the output verbatim, as a short summary (not the raw JSON):

```sh
"${CLAUDE_PLUGIN_ROOT}/scripts/sil" status
```

## `$1` is `web`: start the web UI

Start it detached, do not wait for it to exit:

```sh
nohup "${CLAUDE_PLUGIN_ROOT}/scripts/sil" web > /dev/null 2>&1 &
sleep 1
"${CLAUDE_PLUGIN_ROOT}/scripts/sil" logs web --lines 5
```

Report the URL printed in the `web` log (it contains a one-time token in the
fragment). Do not open a browser yourself.

## `$1` is `run`: trigger a worker pass

Trigger one worker pass detached, do not wait for it:

```sh
nohup "${CLAUDE_PLUGIN_ROOT}/scripts/sil" worker --once > /dev/null 2>&1 &
```

Report that a worker pass was triggered, not that it finished.
