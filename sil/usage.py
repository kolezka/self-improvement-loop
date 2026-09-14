"""Usage event log: skill/agent/hook invocations. Stdlib only, hot path."""

from __future__ import annotations

import json
import os
from pathlib import Path

from sil import nudge, paths

# Set True the first time append_event logs a failure in this process, so a
# consistently broken path (bad permissions, full disk) writes one line to
# hook.log instead of one per hook invocation for the rest of the process.
_FAILURE_LOGGED = False


def append_event(path: Path, event: dict) -> None:
    """Append one JSON line to `path`. Never raises: a failure here must not
    break a hook invocation, so it goes to the hook log instead."""
    global _FAILURE_LOGGED
    path = Path(path)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(event, default=str) + "\n"
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        try:
            os.write(fd, line.encode("utf-8"))
        finally:
            os.close(fd)
    except Exception as e:
        if _FAILURE_LOGGED:
            return
        _FAILURE_LOGGED = True
        nudge.append_line(paths.log_file("hook"), f"usage.append_event failed for {path}: {e}\n")


def read_events(path: Path, since_ts: str | None = None) -> list[dict]:
    """All events in `path`, optionally filtered to `ts > since_ts`. Tolerant
    of bad lines: a line that is not valid JSON or not an object is skipped."""
    path = Path(path)
    if not path.is_file():
        return []
    out: list[dict] = []
    try:
        with path.open(encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(obj, dict):
                    continue
                if since_ts and str(obj.get("ts", "")) <= since_ts:
                    continue
                out.append(obj)
    except OSError:
        return out
    return out


def artifact_ref(kind: str, name: str) -> str:
    return f"{kind}:{name}"
