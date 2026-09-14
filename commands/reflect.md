---
description: Queue a background reflection on the work just completed
---

Queue a reflection on this session. Do not run it in the foreground and do not
wait for it to finish.

1. Prefer the session id. Launch this in the background (use `run_in_background`
   on the Bash tool if available, otherwise `nohup ... &`):

   ```sh
   nohup "${CLAUDE_PLUGIN_ROOT}/scripts/sil" reflect \
     --session "$CLAUDE_SESSION_ID" --now > /dev/null 2>&1 &
   ```

2. If `$CLAUDE_SESSION_ID` is not set in this environment, fall back to the
   working directory instead. This marks the newest pending queue entry for
   this cwd as ended and kicks the worker:

   ```sh
   nohup "${CLAUDE_PLUGIN_ROOT}/scripts/sil" reflect \
     --cwd "$PWD" --now > /dev/null 2>&1 &
   ```

3. Do not poll the background process and do not read its output.

Report back in one line that a reflection was queued. Never say a reflection
was written, recorded, or completed. Only the worker can write one, and it
runs after this command returns.
