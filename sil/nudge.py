"""Declarative nudge hooks and dispatch. Stdlib only: the hook fast path
imports this on every event.

Ported from V1 (dotfiles-next/kb/nudge.py + claude/hooks/nudge_dispatch.py).
The predicate vocabulary is closed on purpose: a nudge runs on every matching
event in every session, so an unrecognised predicate must not silently
evaluate true forever. `evaluate()` here is total (never raises) rather than
raising on a bad gate like V1 did; `lint_nudge` is where malformed nudges get
reported.
"""

from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import re
import signal
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

try:
    import fcntl
except ImportError:  # pragma: no cover, non-POSIX
    fcntl = None

MAX_TEXT = 400
MAX_MATCH_LEN = 4000

# Event -> accepted matchers, or None for events that take none.
EVENTS: dict[str, frozenset | None] = {
    "PreToolUse": frozenset({"Bash", "Edit", "Write", "Read", "Grep", "Glob", "Agent", "Skill"}),
    "PostToolUse": frozenset({"Bash", "Edit", "Write", "Read", "Grep", "Glob", "Agent", "Skill"}),
    "Stop": None,
    "SessionStart": None,
    "UserPromptSubmit": None,
    "SubagentStop": None,
    "SessionEnd": None,
}

# Events that fire only a handful of times per session. Everything else fires
# per tool call or per turn, which is what turns an unconditional gate on it
# into a broadcast rather than a nudge. Defined by exclusion: a new event
# added to EVENTS counts as high-frequency until listed here.
LOW_FREQUENCY_EVENTS = frozenset({"SessionStart", "SessionEnd"})

ONCE_PER = frozenset({"session", "always"})
PREDICATES = frozenset({
    "always", "tool_is", "command_matches", "file_path_matches",
    "prompt_matches", "all", "any", "not",
})

PATTERN_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

GATE_MIN_SLICE_S = 0.005
ROTATE_AT_BYTES = 10 * 1024 * 1024
ROTATE_KEEP_LINES = 5000


# --- gate deadline ------------------------------------------------------

class GateTimeout(Exception):
    """Raised when gate evaluation exceeds its wall-clock deadline."""


def _can_arm() -> bool:
    """False off the main thread or without setitimer: a no-op deadline is
    correct there, raising is not."""
    return (hasattr(signal, "setitimer") and hasattr(signal, "SIGALRM")
            and threading.current_thread() is threading.main_thread())


@contextmanager
def _deadline(seconds: float):
    if seconds <= 0 or not _can_arm():
        yield
        return

    def _fire(signum, frame):
        raise GateTimeout(f"gate evaluation exceeded {seconds}s")

    prev = signal.signal(signal.SIGALRM, _fire)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        # Cancel first, then restore: restoring first leaves a live alarm
        # that lands in the previous handler once it fires.
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, prev)


# --- gate evaluation ------------------------------------------------------

def split_trigger(trigger: str) -> tuple[str, str | None] | None:
    """`"PreToolUse:Bash"` -> `("PreToolUse", "Bash")`. None if unsupported."""
    event, _, matcher = trigger.partition(":")
    if event not in EVENTS:
        return None
    allowed = EVENTS[event]
    if not matcher:
        return event, None
    if allowed is None or matcher not in allowed:
        return None
    return event, matcher


def _command(payload: dict) -> str:
    ti = payload.get("tool_input")
    return ti.get("command", "") if isinstance(ti, dict) else ""


def _file_path(payload: dict) -> str:
    ti = payload.get("tool_input")
    return ti.get("file_path", "") if isinstance(ti, dict) else ""


def _search(pattern, text) -> bool:
    """re.search, bounded: the matched text is capped so a pathological
    pattern on a huge string cannot blow up evaluate() called outside a
    wall-clock deadline. The deadline in dispatch() is the real defense
    against catastrophic backtracking on realistically sized input."""
    if not isinstance(pattern, str):
        return False
    try:
        return bool(re.search(pattern, str(text)[:MAX_MATCH_LEN]))
    except re.error:
        return False


def evaluate(gate: dict, payload: dict) -> bool:
    """True if this gate fires for this payload. Total: a malformed gate, a
    bad regex, or any other error is False, never an exception. A gate that
    threw on the wrong event would take the whole dispatcher down for that
    tool call."""
    try:
        return _evaluate(gate, payload)
    except Exception:
        return False


def _evaluate(gate, payload: dict) -> bool:
    if not isinstance(gate, dict) or len(gate) != 1:
        return False
    (name, arg), = gate.items()
    if name == "always":
        return True
    if name == "tool_is":
        return isinstance(arg, list) and payload.get("tool_name", "") in arg
    if name == "command_matches":
        return _search(arg, _command(payload))
    if name == "file_path_matches":
        if not isinstance(arg, str):
            return False
        path = _file_path(payload)
        return bool(path) and fnmatch.fnmatch(path, arg)
    if name == "prompt_matches":
        return _search(arg, payload.get("prompt", ""))
    if name == "all":
        return isinstance(arg, list) and all(_evaluate(g, payload) for g in arg)
    if name == "any":
        return isinstance(arg, list) and any(_evaluate(g, payload) for g in arg)
    if name == "not":
        return not _evaluate(arg, payload)
    return False


def validate_gate(gate) -> list[str]:
    """Structurally validate every node, unlike evaluate()'s execution probe:
    evaluate() short-circuits through all()/any(), so a payload that fails
    clause 1 never touches clause 2's regex. A walker that recurses
    unconditionally is the only thing that sees the whole tree."""
    problems: list[str] = []
    if not isinstance(gate, dict) or len(gate) != 1:
        problems.append(f"a gate is exactly one predicate, got: {gate!r}")
        return problems
    (name, arg), = gate.items()
    if name not in PREDICATES:
        problems.append(f"unknown predicate {name!r}; allowed: {sorted(PREDICATES)}")
        return problems

    if name == "always":
        pass
    elif name == "tool_is":
        if not isinstance(arg, list):
            problems.append("tool_is takes a list of tool names")
    elif name == "command_matches":
        if not isinstance(arg, str):
            problems.append("command_matches takes a regex string")
        else:
            try:
                re.compile(arg)
            except re.error as e:
                problems.append(f"command_matches has bad regex {arg!r}: {e}")
    elif name == "file_path_matches":
        if not isinstance(arg, str):
            problems.append("file_path_matches takes a glob string")
    elif name == "prompt_matches":
        if not isinstance(arg, str):
            problems.append("prompt_matches takes a regex string")
        else:
            try:
                re.compile(arg)
            except re.error as e:
                problems.append(f"prompt_matches has bad regex {arg!r}: {e}")
    elif name in ("all", "any"):
        if not isinstance(arg, list):
            problems.append(f"{name} takes a list of predicates")
        else:
            for child in arg:
                problems.extend(validate_gate(child))
    elif name == "not":
        problems.extend(validate_gate(arg))
    return problems


def gate_truth(gate) -> bool | None:
    """Static truth of a whole gate tree: True (fires for every payload),
    False (fires for none), None (payload-dependent, the normal answer).
    Malformed input is None, never an exception."""
    if not isinstance(gate, dict) or len(gate) != 1:
        return None
    (name, arg), = gate.items()
    if name == "always":
        return True
    if name == "tool_is":
        return False if isinstance(arg, list) and not arg else None
    if name in ("command_matches", "prompt_matches"):
        # re.search("", s) matches at position 0 of every string, including
        # the "" these predicates yield on a payload with no command/prompt.
        return True if arg == "" else None
    if name == "all":
        if not isinstance(arg, list):
            return None
        truths = [gate_truth(g) for g in arg]
        if any(t is False for t in truths):
            return False
        return True if all(t is True for t in truths) else None
    if name == "any":
        if not isinstance(arg, list):
            return None
        truths = [gate_truth(g) for g in arg]
        if any(t is True for t in truths):
            return True
        return False if all(t is False for t in truths) else None
    if name == "not":
        inner = gate_truth(arg)
        return None if inner is None else (not inner)
    return None


def unbounded_broadcast_rule() -> str:
    """The one sentence lint_nudge enforces, in prose a drafter can obey
    before writing the body."""
    low = ", ".join(sorted(LOW_FREQUENCY_EVENTS))
    return ("a gate that is true for every payload is accepted only when "
            "something else bounds it: set 'once_per' to 'session', or use "
            f"one of the low-frequency events ({low}). An unconditional gate "
            "with 'once_per' set to 'always' on any other event is rejected "
            "outright")


def _lint_unbounded_broadcast(obj: dict) -> list[str]:
    """Reject an unbounded unconditional broadcast, not breadth on its own.

    Precondition (enforced by the sole caller, lint_nudge): once_per and event
    are both in vocabulary. Indefensible only when all three hold: the gate
    discriminates nothing, once_per is 'always' so not even one-per-session
    bounds it, and the event fires many times per session.
    """
    if gate_truth(obj["gate"]) is not True:
        return []
    if obj["once_per"] == "session":
        return []
    if obj["event"] in LOW_FREQUENCY_EVENTS:
        return []
    return [f"degenerate gate: it fires unconditionally, once_per is "
            f"{obj['once_per']!r}, and {obj['event']} fires many times per "
            f"session, this injects on every {obj['event']} forever and "
            f"discriminates nothing. Narrow the gate to a real predicate, or "
            f"{unbounded_broadcast_rule()}"]


def lint_nudge(obj: dict) -> list[str]:
    """Structural check for a nudge JSON document. Empty list means clean."""
    problems: list[str] = []
    if not isinstance(obj, dict):
        return ["nudge must be a JSON object"]
    for field in ("pattern", "event", "gate", "once_per", "text"):
        if field not in obj:
            problems.append(f"missing required field {field!r}")
    if problems:
        return problems

    if not isinstance(obj.get("pattern"), str):
        problems.append("field 'pattern' must be a string")
    elif not PATTERN_RE.match(obj["pattern"]):
        problems.append(f"field 'pattern' must be a slug, got {obj['pattern']!r}")
    if not isinstance(obj.get("event"), str):
        problems.append("field 'event' must be a string")
    if not isinstance(obj.get("gate"), dict):
        problems.append("field 'gate' must be a dict")
    if not isinstance(obj.get("once_per"), str):
        problems.append("field 'once_per' must be a string")
    if not isinstance(obj.get("text"), str):
        problems.append("field 'text' must be a string")
    if obj.get("matcher") is not None and not isinstance(obj.get("matcher"), str):
        problems.append("field 'matcher' must be a string or absent")
    if problems:
        return problems

    trigger = obj["event"] + (f":{obj['matcher']}" if obj.get("matcher") else "")
    trigger_ok = split_trigger(trigger) is not None
    if not trigger_ok:
        problems.append(f"unsupported event/matcher: {trigger!r}")
    once_per_ok = obj["once_per"] in ONCE_PER
    if not once_per_ok:
        problems.append(f"once_per must be one of {sorted(ONCE_PER)}")
    if not obj["text"].strip():
        problems.append("text must be a non-empty string")
    elif len(obj["text"]) > MAX_TEXT:
        problems.append(f"text is {len(obj['text'])} chars; the cap is {MAX_TEXT}")

    problems.extend(validate_gate(obj["gate"]))

    # Needs all three of gate/once_per/event, so only checked once each is
    # individually well-formed (an out-of-vocabulary once_per or event would
    # make the rule's own verdict false, not merely unproven).
    if trigger_ok and once_per_ok:
        problems.extend(_lint_unbounded_broadcast(obj))

    return problems


def load_nudges(dirs: list[Path]) -> list[dict]:
    """All nudges from `dirs`, sorted by filename within each dir, dirs in
    the order given. Invalid JSON and non-object documents are skipped."""
    out: list[dict] = []
    for d in dirs:
        d = Path(d)
        if not d.is_dir():
            continue
        for p in sorted(d.glob("*.json")):
            try:
                obj = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if isinstance(obj, dict):
                out.append(obj)
    return out


# --- fire log + markers ---------------------------------------------------

def _ts() -> str:
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def _rotate_if_needed(log: Path) -> None:
    """Trim an oversized fire log to its tail. Must be called only while the
    caller holds the lock in _append_log_line."""
    if not log.is_file() or log.stat().st_size <= ROTATE_AT_BYTES:
        return
    with log.open(encoding="utf-8", errors="ignore") as f:
        tail = f.readlines()[-ROTATE_KEEP_LINES:]
    tmp = log.with_name(f"{log.name}.{os.getpid()}.tmp")
    tmp.write_text("".join(tail), encoding="utf-8")
    os.replace(tmp, log)


def _append_log_line(log: Path, line: str) -> None:
    """Lock, rotate, append. Any failure is swallowed: losing a measurement
    must never cost a tool call. Locked on a separate lock file, never the
    data file itself, so a rotation's temp-file swap cannot race a concurrent
    appender's open() on the old inode."""
    try:
        log.parent.mkdir(parents=True, exist_ok=True)
        lock_path = log.with_name(log.name + ".lock")
        with lock_path.open("a", encoding="utf-8") as lockf:
            if fcntl is not None:
                fcntl.flock(lockf.fileno(), fcntl.LOCK_EX)
            try:
                try:
                    _rotate_if_needed(log)
                except Exception:
                    pass
                with log.open("a", encoding="utf-8") as f:
                    f.write(line)
            finally:
                if fcntl is not None:
                    fcntl.flock(lockf.fileno(), fcntl.LOCK_UN)
    except Exception:
        pass


def _slug(raw) -> str:
    """A filename-safe, collision-resistant marker component. The sanitiser
    alone is not injective (`a.b`, `a b`, `a/b` all sanitise to `a_b`), so a
    short digest of the raw string is appended to keep two different names
    from sharing one marker slot."""
    text = raw if isinstance(raw, str) else str(raw)
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", text)[:64]
    digest = hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()[:8]
    return f"{safe}-{digest}"


def _claim_marker(session_dir: Path, name: str) -> bool:
    """True the first time `name` is claimed under this session dir, False
    every later call. Fails closed: an unwritable marker path suppresses the
    claim, never lets it through."""
    try:
        markers = Path(session_dir) / "nudge-markers"
        markers.mkdir(parents=True, exist_ok=True)
        mark = markers / _slug(name)
        if mark.exists():
            return False
        mark.touch()
        return True
    except Exception:
        return False


def write_breadcrumb(fire_log: Path, session_dir: Path, kind: str, session_id: str,
                      event: str, **extra) -> None:
    """Diagnostic record distinguishing 'nothing matched' from 'dispatch could
    not run properly' (missing nudge dir, exhausted gate budget). Capped at
    one record per (session, event, kind): otherwise an anomaly that never
    clears would write on every matching call for the rest of the session."""
    if not _claim_marker(session_dir, f"breadcrumb-{kind}-{event}"):
        return
    record = {"ts": _ts(), "kind": kind, "session_id": session_id, "event": event}
    record.update(extra)
    _append_log_line(Path(fire_log), json.dumps(record) + "\n")


def dispatch(payload: dict, nudges: list[dict], *, session_dir: Path, fire_log: Path,
             budget_s: float = 0.25, gate_timeout_s: float = 0.25) -> str | None:
    """Fire at most one nudge: the first (in list order) whose event/matcher
    match, whose gate is true, and whose once_per marker is free. The marker
    is claimed, and the fire logged, only for the winner: a nudge that
    matches but loses to an earlier one keeps its slot for a later call
    instead of burning it on a delivery that never happened. Never raises."""
    try:
        session_id = str(payload.get("session_id") or "unknown")
        event = str(payload.get("hook_event_name") or "")
        session_dir = Path(session_dir)
        fire_log = Path(fire_log)

        gate_spent = 0.0
        scanned = 0
        budget_exhausted = False

        for nudge in nudges:
            scanned += 1
            if not isinstance(nudge, dict) or nudge.get("event") != event:
                continue
            matcher = nudge.get("matcher")
            if matcher and payload.get("tool_name") != matcher:
                continue

            # Charged only for nudges that actually reach a gate: an event or
            # matcher miss is free, so a directory full of unreachable nudges
            # cannot exhaust the budget for the one that is reachable.
            remaining = budget_s - gate_spent
            if remaining < GATE_MIN_SLICE_S:
                budget_exhausted = True
                break

            started = time.monotonic()
            try:
                with _deadline(min(gate_timeout_s, remaining)):
                    matched = evaluate(nudge.get("gate"), payload)
            finally:
                gate_spent += time.monotonic() - started

            if not matched:
                continue

            pattern = str(nudge.get("pattern") or "unknown")
            if nudge.get("once_per") != "always":
                # Anything other than the literal "always" is session-scoped:
                # fail closed on an unrecognised once_per, not open.
                if not _claim_marker(session_dir, f"nudge-{pattern}"):
                    continue

            _append_log_line(fire_log, json.dumps({
                "ts": _ts(), "pattern": pattern, "session_id": session_id, "event": event,
            }) + "\n")
            return str(nudge.get("text", ""))

        if budget_exhausted:
            write_breadcrumb(fire_log, session_dir, "gate_budget_exhausted",
                              session_id, event, scanned=scanned)
        return None
    except Exception:
        return None
