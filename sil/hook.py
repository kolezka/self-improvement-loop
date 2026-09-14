#!/usr/bin/env python3
"""The plugin's single hook entry point. Stdlib only: runs on every event as
`python3 ${CLAUDE_PLUGIN_ROOT}/sil/hook.py`, with no virtualenv. Every branch
is wrapped so a failure is a silent exit 0; the hook must never block a
session and never call a model.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

try:
    import fcntl
except ImportError:  # pragma: no cover, non-POSIX
    fcntl = None

# Runs as a bare script, so the package parent must be on sys.path before
# `from sil import ...` resolves.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _fallback_state_dir() -> Path:
    """Reimplements paths.state_dir()'s precedence without importing paths:
    this only runs when importing sil itself has already failed."""
    raw = os.environ.get("SIL_STATE_DIR")
    if raw:
        return Path(raw).expanduser()
    xdg = os.environ.get("XDG_STATE_HOME")
    base = Path(xdg).expanduser() if xdg else Path.home() / ".local" / "state"
    return base / "self-improvement-loop"


try:
    from sil import consts, nudge, paths, usage  # noqa: E402
except BaseException as exc:
    # A partial or broken install must not crash the hook: log one line and
    # exit clean. Module scope, so this runs before main() and its own
    # try/except ever gets a chance.
    try:
        log = _fallback_state_dir() / "logs" / "hook.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        now = datetime.now(timezone.utc)
        ts = now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
        with log.open("a", encoding="utf-8") as f:
            f.write(f"{ts} hook unavailable: import failed: {type(exc).__name__}\n")
    except Exception:
        pass
    sys.exit(0)

OUTPUT_EVENTS = ("SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse")
SLOW_INVOCATION_MS = 150.0
MAX_TRANSCRIPT_SCAN_BYTES = 20 * 1024 * 1024
LESSON_ARCHIVE_AT_DELIVERIES = 5
WORKER_KICK_THROTTLE_S = 15 * 60

DEFAULT_WORKER = {
    "idle_minutes": 10,
    "curriculum_interval_minutes": 60,
    "min_tool_uses": 6,
    "auto_kick": True,
}


# --- misc small helpers ----------------------------------------------------

def _now_iso() -> str:
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def _log(msg: str) -> None:
    try:
        nudge.append_line(paths.log_file("hook"), f"{_now_iso()} {msg}\n")
    except Exception:
        pass


def _exc_summary(e: BaseException) -> str:
    """Type name plus a short, bounded piece of the message. Never the
    payload: a handler exception can carry secrets from the tool call."""
    return f"{type(e).__name__}: {str(e)[:120]}"


def _safe_component(name: str) -> str:
    cleaned = "".join(c if c.isalnum() or c in "-_." else "_" for c in name)
    return cleaned if cleaned not in ("", ".", "..") else "_"


def _atomic_write_json(path: Path, obj: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(obj, indent=2, default=str) + "\n", encoding="utf-8")
        tmp.replace(path)
    except Exception:
        try:
            if tmp.exists():
                tmp.unlink()
        except Exception:
            pass


def _git_head(cwd) -> str | None:
    try:
        out = subprocess.run(["git", "-C", str(cwd), "rev-parse", "HEAD"],
                              capture_output=True, text=True, timeout=1)
        if out.returncode == 0:
            head = out.stdout.strip()
            return head or None
    except Exception:
        pass
    return None


def _cwd_under(cwd, repo) -> bool:
    try:
        cwd_p = Path(cwd).resolve()
        repo_p = Path(repo).expanduser().resolve()
    except Exception:
        return False
    return cwd_p == repo_p or repo_p in cwd_p.parents


# --- snapshot + world resolution --------------------------------------------

def _default_world() -> dict:
    target = paths.default_target("default")
    return {
        "name": "default",
        "repos": [],
        "nudges_dir": str(target / "nudges"),
        "rules_file": str(target / "RULES.md"),
        "rules_inject": True,
    }


def _load_snapshot() -> dict:
    p = paths.state_dir() / consts.HOOK_SNAPSHOT
    try:
        obj = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass
    return {
        "version": 1,
        "worlds": [_default_world()],
        "worker": dict(DEFAULT_WORKER),
        "plugin_root": os.environ.get("CLAUDE_PLUGIN_ROOT") or str(paths.plugin_root()),
    }


def _resolve_world(snapshot: dict, cwd) -> dict:
    """Longest `repos` prefix match on cwd; the first world with an empty
    `repos` list is the catch-all."""
    worlds = snapshot.get("worlds") or []
    try:
        cwd_p = Path(cwd).resolve()
    except Exception:
        cwd_p = Path(cwd)

    best = None  # (score, world)
    fallback = None
    for w in worlds:
        if not isinstance(w, dict):
            continue
        repos = w.get("repos") or []
        if not repos and fallback is None:
            fallback = w
        for repo in repos:
            try:
                r = Path(repo).expanduser().resolve()
            except Exception:
                continue
            if cwd_p == r or r in cwd_p.parents:
                score = len(r.parts)
                if best is None or score > best[0]:
                    best = (score, w)
    if best:
        return best[1]
    if fallback:
        return fallback
    return _default_world()


# --- nudge dispatch ----------------------------------------------------------

def _dispatch_nudge(payload: dict, world: dict, session_id: str) -> str:
    event = payload.get("hook_event_name", "")
    sdir = paths.session_dir(session_id)
    world_dir = world.get("nudges_dir")
    dirs = [Path(world_dir)] if isinstance(world_dir, str) and world_dir.strip() else []
    dirs.append(paths.builtin_nudges_dir())
    if not any(d.is_dir() for d in dirs):
        nudge.write_breadcrumb(paths.nudge_fires_file(), sdir, "nudge_dir_missing", session_id, event)
    nudges = nudge.load_nudges(dirs)
    return nudge.dispatch(payload, nudges, session_dir=sdir, fire_log=paths.nudge_fires_file()) or ""


# --- inbox lessons -----------------------------------------------------------

def _format_lesson(lesson: dict) -> str:
    return f"Lesson ({lesson.get('pattern', '')}): {lesson.get('text', '')}"


def _read_delivered(path: Path) -> set[str]:
    try:
        return {line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()}
    except Exception:
        return set()


def _bump_lesson_deliveries(world_name: str, path: Path, raw: dict | None = None) -> None:
    """`raw` lets a caller that already parsed the file (like `_pending_lessons`)
    skip a second json.loads of the same bytes; a caller with only a path
    still gets the file read for it."""
    if raw is None:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return
    if not isinstance(raw, dict):
        return
    raw["deliveries"] = int(raw.get("deliveries", 0)) + 1
    _atomic_write_json(path, raw)
    if raw["deliveries"] >= LESSON_ARCHIVE_AT_DELIVERIES:
        archive_dir = paths.inbox_dir(world_name) / "archive"
        try:
            archive_dir.mkdir(parents=True, exist_ok=True)
            path.replace(archive_dir / path.name)
        except Exception:
            pass


def _session_start_mtime(session_id: str) -> float | None:
    """Cutoff for 'arrived since session start': start.json's own mtime. It
    is written once, at SessionStart, and never touched again."""
    start_path = paths.session_dir(session_id) / "start.json"
    try:
        return start_path.stat().st_mtime
    except OSError:
        return None


def _pending_lessons(world_name: str, session_id: str, cwd, limit: int,
                      since_session_start: bool = False) -> list[dict]:
    """Undelivered inbox lessons for this session, newest first, filtered to
    a repo that owns cwd (or no repo at all). Marks the chosen ones delivered
    and bumps their delivery count as a side effect.

    Candidates are filtered by filename before any json.loads: the inbox
    convention is `<lesson id>.json` (sil/store.py), and the delivered set
    already holds ids, so a file whose stem is already delivered never needs
    reading. `since_session_start` additionally requires the file's mtime to
    be at or after the session started, per ARCHITECTURE.md's "arrived since
    session start" for UserPromptSubmit.
    """
    inbox = paths.inbox_dir(world_name)
    if not inbox.is_dir():
        return []
    delivered_file = paths.session_dir(session_id) / "delivered"
    already = _read_delivered(delivered_file)

    min_mtime = _session_start_mtime(session_id) if since_session_start else None

    candidates = []
    for p in sorted(inbox.glob("*.json")):
        if p.stem in already:
            continue
        if min_mtime is not None:
            try:
                if p.stat().st_mtime < min_mtime:
                    continue
            except OSError:
                continue
        try:
            obj = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(obj, dict):
            continue
        lid = str(obj.get("id") or "")
        if not lid or lid in already:
            continue
        repo = obj.get("repo")
        if repo and not _cwd_under(cwd, repo):
            continue
        obj["_path"] = p
        candidates.append(obj)

    candidates.sort(key=lambda o: str(o.get("created", "")), reverse=True)
    chosen = candidates[:limit]

    for obj in chosen:
        try:
            delivered_file.parent.mkdir(parents=True, exist_ok=True)
            with delivered_file.open("a", encoding="utf-8") as f:
                f.write(f"{obj.get('id')}\n")
        except Exception:
            pass
        raw = {k: v for k, v in obj.items() if k != "_path"}
        _bump_lesson_deliveries(world_name, obj["_path"], raw)

    return chosen


def _rules_block(world: dict) -> str:
    if not world.get("rules_inject", True):
        return ""
    rules_file = world.get("rules_file")
    if not rules_file:
        return ""
    p = Path(rules_file)
    if not p.is_file():
        return ""
    try:
        text = p.read_text(encoding="utf-8")
    except Exception:
        return ""
    start = text.find(consts.RULE_START)
    end = text.find(consts.RULE_END)
    if start == -1 or end == -1 or end <= start:
        return ""
    block = text[start + len(consts.RULE_START):end].strip()
    return block


# --- worker kick -------------------------------------------------------------

def _worker_lock_pid() -> int | None:
    try:
        text = paths.worker_lock_file().read_text(encoding="utf-8").strip()
    except OSError:
        return None
    try:
        return int(text)
    except ValueError:
        return None


def _worker_running() -> bool:
    """sil.worker.Lock truncates its lock file on a clean exit but never
    unlinks it, so the file's mere existence says nothing. Read the pid it
    names and probe that process directly."""
    pid = _worker_lock_pid()
    if pid is None:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, owned by someone else
    except OSError:
        return False
    return True


def _curriculum_due_for_any_world(snapshot: dict, interval_minutes) -> bool:
    """True if any world's curriculum marker is missing or older than the
    interval. One kick runs the worker once for every world, so any single
    world being due is reason enough."""
    worlds = snapshot.get("worlds") or [_default_world()]
    try:
        interval_s = max(float(interval_minutes), 0.0) * 60
    except (TypeError, ValueError):
        interval_s = DEFAULT_WORKER["curriculum_interval_minutes"] * 60
    for w in worlds:
        if not isinstance(w, dict):
            continue
        name = w.get("name") or "default"
        marker = paths.state_dir() / f"last-curriculum-{name}"
        try:
            if not marker.exists():
                return True
            if time.time() - marker.stat().st_mtime >= interval_s:
                return True
        except OSError:
            return True
    return False


def _has_pending_work(snapshot: dict, worker_cfg: dict) -> bool:
    try:
        if any(paths.queue_dir("pending").iterdir()):
            return True
    except OSError:
        pass
    interval = worker_cfg.get("curriculum_interval_minutes", DEFAULT_WORKER["curriculum_interval_minutes"])
    return _curriculum_due_for_any_world(snapshot, interval)


def _maybe_kick_worker(snapshot: dict) -> None:
    if not (paths.state_dir() / consts.HOOK_SNAPSHOT).is_file():
        return  # never `sil init`ed: nothing to kick
    worker_cfg = snapshot.get("worker") or {}
    if not worker_cfg.get("auto_kick", True):
        return
    if shutil.which("uv") is None:
        return
    if _worker_running():
        return

    last_kick = paths.state_dir() / "last-kick"
    try:
        if last_kick.exists():
            age = time.time() - last_kick.stat().st_mtime
            if age < WORKER_KICK_THROTTLE_S:
                return
    except Exception:
        pass

    if not _has_pending_work(snapshot, worker_cfg):
        return

    try:
        last_kick.parent.mkdir(parents=True, exist_ok=True)
        last_kick.touch()
    except Exception:
        return

    plugin_root = os.environ.get("CLAUDE_PLUGIN_ROOT") or snapshot.get("plugin_root") or str(paths.plugin_root())
    log_path = paths.log_file("worker")
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_fh = open(log_path, "a", encoding="utf-8")
    except Exception:
        return
    try:
        subprocess.Popen(
            ["uv", "run", "--project", str(plugin_root), "sil", "worker", "--once"],
            stdin=subprocess.DEVNULL, stdout=log_fh, stderr=subprocess.STDOUT,
            start_new_session=True, cwd=str(plugin_root), env=os.environ.copy(),
        )
    except Exception:
        pass
    finally:
        try:
            log_fh.close()
        except Exception:
            pass


# --- queue -------------------------------------------------------------------

def _queue_path(session_id: str) -> Path:
    return paths.queue_dir("pending") / f"{_safe_component(session_id)}.json"


def _start_git_head(session_id: str) -> str | None:
    p = paths.session_dir(session_id) / "start.json"
    try:
        obj = json.loads(p.read_text(encoding="utf-8"))
        return obj.get("git_head") if isinstance(obj, dict) else None
    except Exception:
        return None


def _upsert_stop_queue(payload: dict, world_name: str, session_id: str) -> None:
    now = _now_iso()
    cwd = payload.get("cwd") or os.getcwd()
    qpath = _queue_path(session_id)

    existing = {}
    if qpath.is_file():
        try:
            loaded = json.loads(qpath.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                existing = loaded
        except Exception:
            pass

    git_head = existing.get("git_head") or _start_git_head(session_id) or _git_head(cwd)
    entry = {
        "session_id": session_id,
        "transcript_path": payload.get("transcript_path") or existing.get("transcript_path"),
        "cwd": str(cwd),
        "world": world_name,
        "git_head": git_head,
        "first_stop": existing.get("first_stop") or now,
        "last_stop": now,
        "stops": int(existing.get("stops", 0)) + 1,
        "ended": bool(existing.get("ended", False)),
        "tool_uses": int(existing.get("tool_uses", 0)),
        "result": existing.get("result"),
    }
    _atomic_write_json(qpath, entry)


def _bump_tool_uses(session_id: str, count: int) -> None:
    if not count:
        return
    qpath = _queue_path(session_id)
    try:
        obj = json.loads(qpath.read_text(encoding="utf-8"))
    except Exception:
        return
    if not isinstance(obj, dict):
        return
    obj["tool_uses"] = int(obj.get("tool_uses", 0)) + count
    _atomic_write_json(qpath, obj)


# --- transcript scan -----------------------------------------------------

def _assistant_content(record: dict) -> list:
    message = record.get("message")
    if isinstance(message, dict) and isinstance(message.get("content"), list):
        return message["content"]
    content = record.get("content")
    return content if isinstance(content, list) else []


def _read_offset(path: Path) -> int:
    try:
        return int(path.read_text(encoding="utf-8").strip() or "0")
    except Exception:
        return 0


def _write_offset(path: Path, value: int) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(str(value), encoding="utf-8")
        tmp.replace(path)
    except Exception:
        pass


def _scan_transcript(payload: dict, world_name: str, session_id: str) -> None:
    transcript_path = payload.get("transcript_path")
    if not transcript_path:
        return
    tp = Path(transcript_path)
    if not tp.is_file():
        return

    offset_path = paths.session_dir(session_id) / "offset"
    offset = _read_offset(offset_path)
    try:
        size = tp.stat().st_size
    except OSError:
        return
    if offset > size:
        offset = 0  # transcript rotated or truncated: rescan from the top

    try:
        with tp.open("rb") as f:
            f.seek(offset)
            data = f.read(MAX_TRANSCRIPT_SCAN_BYTES)
    except OSError:
        return

    # Only whole lines count; a partial trailing line is left for next call.
    last_nl = data.rfind(b"\n")
    if last_nl == -1 and len(data) >= MAX_TRANSCRIPT_SCAN_BYTES:
        # A single line fills the whole scan cap with no newline in sight.
        # Waiting for one would stall the offset here forever and re-read
        # this same multi-MB blob on every future Stop. Skip past what was
        # read; the oversized record is lost, everything after it is not.
        _log(f"transcript line exceeds {MAX_TRANSCRIPT_SCAN_BYTES} bytes, skipping")
        _write_offset(offset_path, offset + len(data))
        return
    usable = data[:last_nl + 1] if last_nl != -1 else b""
    new_offset = offset + len(usable)

    tool_uses = 0
    for raw_line in usable.splitlines():
        if not raw_line.strip():
            continue
        try:
            record = json.loads(raw_line.decode("utf-8", errors="ignore"))
        except Exception:
            continue
        if not isinstance(record, dict):
            continue

        rtype = record.get("type")
        if rtype == "attachment":
            attachment = record.get("attachment")
            attachment = attachment if isinstance(attachment, dict) else {}
            hook_name = attachment.get("hookName")
            if attachment.get("type") in ("hook_success", "hook_error", "hook_blocked") or hook_name:
                usage.append_event(paths.usage_events_file(), {
                    "ts": _now_iso(), "session_id": session_id, "world": world_name,
                    "kind": "hook_run",
                    "ref": usage.artifact_ref("hook", hook_name or "unknown"),
                    "detail": {
                        "exitCode": attachment.get("exitCode"),
                        "durationMs": attachment.get("durationMs"),
                        "hookEvent": attachment.get("hookEvent"),
                    },
                })
        elif rtype == "assistant":
            for block in _assistant_content(record):
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    tool_uses += 1

    _bump_tool_uses(session_id, tool_uses)
    _write_offset(offset_path, new_offset)


# --- per-event handlers -------------------------------------------------

def _handle_session_start(payload: dict, world: dict, snapshot: dict) -> str:
    session_id = str(payload.get("session_id") or "unknown")
    cwd = payload.get("cwd") or os.getcwd()
    world_name = world.get("name", "default")
    parts = []

    rules_text = _rules_block(world)
    if rules_text:
        parts.append(f"Promoted rules for world {world_name}:\n{rules_text}")

    lessons = _pending_lessons(world_name, session_id, cwd, limit=3)
    if lessons:
        parts.append("\n".join(_format_lesson(l) for l in lessons))

    parts.append(
        "self-improvement-loop is active: /reflect queues this session for "
        "background reflection, /loop shows status, /feedback <type>:<name> "
        "good|bad rates an artifact."
    )

    nudge_text = _dispatch_nudge(payload, world, session_id)
    if nudge_text:
        parts.append(nudge_text)

    _atomic_write_json(paths.session_dir(session_id) / "start.json", {
        "ts": _now_iso(), "cwd": str(cwd), "world": world_name, "git_head": _git_head(cwd),
    })
    _maybe_kick_worker(snapshot)

    return "\n\n".join(p for p in parts if p)


def _handle_user_prompt_submit(payload: dict, world: dict, snapshot: dict) -> str:
    session_id = str(payload.get("session_id") or "unknown")
    cwd = payload.get("cwd") or os.getcwd()
    world_name = world.get("name", "default")
    parts = []

    lessons = _pending_lessons(world_name, session_id, cwd, limit=2, since_session_start=True)
    if lessons:
        parts.append("\n".join(_format_lesson(l) for l in lessons))

    nudge_text = _dispatch_nudge(payload, world, session_id)
    if nudge_text:
        parts.append(nudge_text)

    return "\n\n".join(p for p in parts if p)


def _handle_pre_tool_use(payload: dict, world: dict, snapshot: dict) -> str:
    session_id = str(payload.get("session_id") or "unknown")
    return _dispatch_nudge(payload, world, session_id)


def _handle_post_tool_use(payload: dict, world: dict, snapshot: dict) -> str:
    session_id = str(payload.get("session_id") or "unknown")
    world_name = world.get("name", "default")
    tool_name = payload.get("tool_name")
    tool_input = payload.get("tool_input")
    tool_input = tool_input if isinstance(tool_input, dict) else {}

    if tool_name == "Skill":
        # No "args": it is free text and can carry secrets. The ref already
        # names the skill; that is what usage counting needs.
        usage.append_event(paths.usage_events_file(), {
            "ts": _now_iso(), "session_id": session_id, "world": world_name,
            "kind": "skill", "ref": usage.artifact_ref("skill", str(tool_input.get("skill", ""))),
            "detail": {},
        })
    elif tool_name == "Agent":
        usage.append_event(paths.usage_events_file(), {
            "ts": _now_iso(), "session_id": session_id, "world": world_name,
            "kind": "agent", "ref": usage.artifact_ref("agent", str(tool_input.get("subagent_type", ""))),
            "detail": {"model": tool_input.get("model"), "description": tool_input.get("description")},
        })

    return _dispatch_nudge(payload, world, session_id)


@contextmanager
def _session_lock(session_id: str):
    """Excludes concurrent Stop handlers for the same session across the
    queue upsert and transcript scan below. Without this, two hook processes
    racing on the same session_id both read the same tool_uses count, both
    add their own delta, and the later write clobbers the earlier one."""
    if fcntl is None:  # pragma: no cover, non-POSIX
        yield
        return
    lock_path = paths.session_dir(session_id) / "lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a") as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)


def _handle_stop(payload: dict, world: dict, snapshot: dict) -> str:
    if payload.get("stop_hook_active"):
        return ""
    session_id = str(payload.get("session_id") or "unknown")
    world_name = world.get("name", "default")
    # Stop is not in nudge.EVENTS: hook.py never delivers additionalContext
    # on it (not in OUTPUT_EVENTS), so a nudge dispatch here would claim its
    # once-per marker and log a fire for a delivery that never happens.
    with _session_lock(session_id):
        _upsert_stop_queue(payload, world_name, session_id)
        _scan_transcript(payload, world_name, session_id)
    return ""


def _handle_subagent_stop(payload: dict, world: dict, snapshot: dict) -> str:
    session_id = str(payload.get("session_id") or "unknown")
    world_name = world.get("name", "default")
    agent_type = (payload.get("agent_type") or payload.get("subagent_type")
                  or payload.get("agentType") or "unknown")

    # Allowlisted to subagent_type only: the full payload carries the
    # subagent's prompt, result, last assistant message and transcript path,
    # none of which belong in a usage log.
    usage.append_event(paths.usage_events_file(), {
        "ts": _now_iso(), "session_id": session_id, "world": world_name,
        "kind": "agent_stop", "ref": usage.artifact_ref("agent", str(agent_type)),
        "detail": {"subagent_type": str(agent_type)},
    })
    # SubagentStop is not in nudge.EVENTS either; see _handle_stop.
    return ""


def _handle_session_end(payload: dict, world: dict, snapshot: dict) -> str:
    session_id = str(payload.get("session_id") or "unknown")
    world_name = world.get("name", "default")
    now = _now_iso()
    cwd = payload.get("cwd") or os.getcwd()
    qpath = _queue_path(session_id)

    obj = None
    if qpath.is_file():
        try:
            loaded = json.loads(qpath.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                obj = loaded
        except Exception:
            obj = None
    if obj is None:
        obj = {
            "session_id": session_id, "transcript_path": payload.get("transcript_path"),
            "cwd": str(cwd), "world": world_name, "git_head": _start_git_head(session_id),
            "first_stop": now, "last_stop": now, "stops": 0, "tool_uses": 0, "result": None,
        }
    obj["ended"] = True
    _atomic_write_json(qpath, obj)
    return ""


HANDLERS = {
    "SessionStart": _handle_session_start,
    "UserPromptSubmit": _handle_user_prompt_submit,
    "PreToolUse": _handle_pre_tool_use,
    "PostToolUse": _handle_post_tool_use,
    "Stop": _handle_stop,
    "SubagentStop": _handle_subagent_stop,
    "SessionEnd": _handle_session_end,
}


def _read_payload() -> dict:
    try:
        raw = sys.stdin.read()
    except Exception:
        return {}
    if not raw or not raw.strip():
        return {}
    try:
        obj = json.loads(raw)
    except Exception:
        return {}
    return obj if isinstance(obj, dict) else {}


def main() -> int:
    started = time.monotonic()
    text = ""
    event = ""
    try:
        payload = _read_payload()
        event = str(payload.get("hook_event_name", ""))
        snapshot = _load_snapshot()
        cwd = payload.get("cwd") or os.getcwd()
        world = _resolve_world(snapshot, cwd)

        handler = HANDLERS.get(event)
        if handler is not None:
            try:
                text = handler(payload, world, snapshot) or ""
            except Exception as e:
                # Type name plus a short slice of the message only: the
                # payload (tool args, prompts) never goes in this log.
                _log(f"{event} handler failed: {_exc_summary(e)}")
                text = ""
    except Exception as e:
        _log(f"hook invocation failed: {_exc_summary(e)}")
        text = ""

    if text and event in OUTPUT_EVENTS:
        try:
            print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}}))
        except Exception:
            pass

    elapsed_ms = (time.monotonic() - started) * 1000.0
    if elapsed_ms > SLOW_INVOCATION_MS:
        _log(f"slow hook invocation: event={event} elapsed_ms={elapsed_ms:.1f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
