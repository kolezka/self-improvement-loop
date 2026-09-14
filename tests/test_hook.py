"""Tests for sil/hook.py: the plugin's single hook entry point."""

from __future__ import annotations

import io
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

from sil import consts, hook, paths, usage

REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURES_DIR = REPO_ROOT / "tests" / "fixtures" / "hook-payloads"
FIXTURE_FILES = sorted(FIXTURES_DIR.glob("*.json"))


def _other_python3() -> str | None:
    """A second interpreter distinct from sys.executable, or None if the
    machine only has the one python3 (e.g. inside the project's venv)."""
    found = shutil.which("python3")
    if not found:
        return None
    try:
        if Path(found).resolve() == Path(sys.executable).resolve():
            return None
    except OSError:
        return None
    return found


_OTHER_PYTHON3 = _other_python3()

PYTHON_EXECUTABLES = [
    pytest.param(sys.executable, id="sys.executable"),
    pytest.param(
        _OTHER_PYTHON3, id="python3",
        marks=pytest.mark.skipif(_OTHER_PYTHON3 is None,
                                  reason="python3 missing or identical to sys.executable"),
    ),
]


# --- hard constraint: stdlib only --------------------------------------

STDLIB_ONLY_MODULES = ["sil.hook", "sil.nudge", "sil.usage", "sil.paths", "sil.consts"]
STDLIB_ONLY_FILES = [REPO_ROOT / "sil" / f"{m.rsplit('.', 1)[1]}.py" for m in STDLIB_ONLY_MODULES]

THIRD_PARTY_IMPORT_RE = re.compile(r"^\s*(import|from)\s+(pydantic|yaml|fastapi)\b", re.MULTILINE)


@pytest.mark.parametrize("python_exe", PYTHON_EXECUTABLES)
def test_stdlib_only_modules_import_under_bare_python(python_exe):
    code = "import sys; sys.path.insert(0, %r); %s" % (
        str(REPO_ROOT), "; ".join(f"import {m}" for m in STDLIB_ONLY_MODULES),
    )
    result = subprocess.run(
        [python_exe, "-I", "-c", code],
        capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == 0, result.stderr


def test_no_third_party_imports_in_hot_path_modules():
    for path in STDLIB_ONLY_FILES:
        source = path.read_text(encoding="utf-8")
        match = THIRD_PARTY_IMPORT_RE.search(source)
        assert match is None, f"{path} imports a third-party package: {match.group(0)!r}"


# --- fixture payloads run as a subprocess -------------------------------

def _isolated_subprocess_env(tmp_path: Path) -> dict:
    plugin_root = tmp_path / "plugin"
    (plugin_root / "nudges").mkdir(parents=True)
    state = tmp_path / "state"
    _write_snapshot(state, worlds=[{
        "name": "default", "repos": [], "nudges_dir": str(plugin_root / "nudges"),
        "rules_file": "", "rules_inject": False,
    }], worker={"idle_minutes": 10, "curriculum_interval_minutes": 60, "min_tool_uses": 6,
                "auto_kick": False})
    return {
        "PATH": "/usr/bin:/bin",
        "HOME": str(tmp_path / "home"),
        "SIL_STATE_DIR": str(state),
        "SIL_DATA_DIR": str(tmp_path / "data"),
        "SIL_CONFIG_DIR": str(tmp_path / "config"),
        "CLAUDE_PLUGIN_ROOT": str(plugin_root),
    }


@pytest.mark.parametrize("fixture_path", FIXTURE_FILES, ids=lambda p: p.name)
@pytest.mark.parametrize("python_exe", PYTHON_EXECUTABLES)
def test_hook_fixture_payloads_exit_zero_with_valid_output(tmp_path, fixture_path, python_exe):
    payload = fixture_path.read_text(encoding="utf-8")
    env = _isolated_subprocess_env(tmp_path)
    result = subprocess.run(
        [python_exe, str(REPO_ROOT / "sil" / "hook.py")],
        input=payload, capture_output=True, text=True, env=env, timeout=10,
    )
    assert result.returncode == 0, result.stderr
    out = result.stdout.strip()
    if out:
        obj = json.loads(out)
        assert set(obj.keys()) == {"hookSpecificOutput"}
        hso = obj["hookSpecificOutput"]
        assert "hookEventName" in hso
        assert isinstance(hso.get("additionalContext"), str) and hso["additionalContext"]


# --- import failure: a broken install must never crash the hook ---------

def test_hook_exits_zero_and_logs_when_a_dependency_module_fails_to_import(tmp_path):
    """`from sil import ...` runs at module scope. A broken partial install
    (or any other import-time exception) must still exit 0 and leave a
    one-line breadcrumb, never a traceback on stderr and a non-zero exit."""
    plugin_copy = tmp_path / "plugin-copy"
    shutil.copytree(REPO_ROOT / "sil", plugin_copy / "sil")
    broken_nudge = plugin_copy / "sil" / "nudge.py"
    # Appended, not prepended: nudge.py's own `from __future__ import
    # annotations` must stay the first statement or this is a SyntaxError
    # instead of the TypeError this test means to simulate.
    broken_nudge.write_text(
        broken_nudge.read_text(encoding="utf-8") + "\nraise TypeError('simulated broken install')\n",
        encoding="utf-8",
    )

    state = tmp_path / "state"
    env = {
        "PATH": "/usr/bin:/bin",
        "HOME": str(tmp_path / "home"),
        "SIL_STATE_DIR": str(state),
        "SIL_DATA_DIR": str(tmp_path / "data"),
        "SIL_CONFIG_DIR": str(tmp_path / "config"),
        "CLAUDE_PLUGIN_ROOT": str(plugin_copy),
    }
    result = subprocess.run(
        [sys.executable, str(plugin_copy / "sil" / "hook.py")],
        input=json.dumps({"session_id": "s1", "hook_event_name": "SessionStart"}),
        capture_output=True, text=True, env=env, timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == ""

    log_text = (state / "logs" / "hook.log").read_text(encoding="utf-8")
    assert "hook unavailable: import failed: TypeError" in log_text


# --- in-process helpers --------------------------------------------------

def _write_snapshot(state_dir: Path, worlds=None, worker=None, plugin_root=None) -> None:
    if worlds is None:
        default_nudges_dir = state_dir / "default-nudges"
        default_nudges_dir.mkdir(parents=True, exist_ok=True)
        worlds = [{
            "name": "default", "repos": [], "nudges_dir": str(default_nudges_dir),
            "rules_file": "", "rules_inject": False,
        }]
    snap = {
        "version": 1,
        "worlds": worlds,
        "worker": worker or {"idle_minutes": 10, "curriculum_interval_minutes": 60,
                              "min_tool_uses": 6, "auto_kick": False},
        "plugin_root": str(plugin_root or ""),
    }
    p = state_dir / consts.HOOK_SNAPSHOT
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(snap), encoding="utf-8")


def _run_hook(monkeypatch, capsys, payload: dict) -> tuple[int, str]:
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(payload)))
    rc = hook.main()
    out = capsys.readouterr().out
    return rc, out


@pytest.fixture
def hook_env(tmp_path, monkeypatch):
    state = tmp_path / "state"
    data = tmp_path / "data"
    config = tmp_path / "config"
    plugin_root = tmp_path / "plugin"
    (plugin_root / "nudges").mkdir(parents=True)
    monkeypatch.setenv("SIL_STATE_DIR", str(state))
    monkeypatch.setenv("SIL_DATA_DIR", str(data))
    monkeypatch.setenv("SIL_CONFIG_DIR", str(config))
    monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(plugin_root))
    # Default: no real "uv" found, so a worker kick never actually spawns
    # unless a test explicitly re-enables it.
    monkeypatch.setattr(hook.shutil, "which", lambda name: None)
    return {"state": state, "data": data, "config": config, "plugin_root": plugin_root}


# --- SessionStart / UserPromptSubmit: rules + lessons -------------------

def test_session_start_injects_rules_lesson_and_status(hook_env, monkeypatch, capsys):
    rules_file = hook_env["data"] / "RULES.md"
    rules_file.parent.mkdir(parents=True, exist_ok=True)
    rules_file.write_text(
        f"intro\n{consts.RULE_START}\nAlways verify call sites.\n{consts.RULE_END}\noutro\n",
        encoding="utf-8",
    )
    world = {"name": "default", "repos": [], "nudges_dir": str(hook_env["plugin_root"] / "nudges"),
             "rules_file": str(rules_file), "rules_inject": True}
    _write_snapshot(hook_env["state"], worlds=[world])

    inbox = hook_env["state"] / "inbox" / "default"
    inbox.mkdir(parents=True, exist_ok=True)
    lesson = {"id": "lesson-1", "world": "default", "pattern": "verify-callsites",
              "text": "check every call site before calling a change safe",
              "created": "2026-09-01T00:00:00.000Z"}
    (inbox / "lesson-1.json").write_text(json.dumps(lesson), encoding="utf-8")

    rc, out = _run_hook(monkeypatch, capsys, {"session_id": "sess-1", "hook_event_name": "SessionStart",
                                               "source": "startup"})
    assert rc == 0
    obj = json.loads(out)
    ctx = obj["hookSpecificOutput"]["additionalContext"]
    assert "Always verify call sites." in ctx
    assert "check every call site before calling a change safe" in ctx
    assert "self-improvement-loop is active" in ctx

    delivered = (hook_env["state"] / "sessions" / "sess-1" / "delivered").read_text(encoding="utf-8")
    assert "lesson-1" in delivered

    updated = json.loads((inbox / "lesson-1.json").read_text(encoding="utf-8"))
    assert updated["deliveries"] == 1


def test_lesson_not_redelivered_in_same_session(hook_env, monkeypatch, capsys):
    world = {"name": "default", "repos": [], "nudges_dir": str(hook_env["plugin_root"] / "nudges"),
             "rules_file": "", "rules_inject": False}
    _write_snapshot(hook_env["state"], worlds=[world])

    inbox = hook_env["state"] / "inbox" / "default"
    inbox.mkdir(parents=True, exist_ok=True)
    lesson = {"id": "lesson-1", "world": "default", "pattern": "p", "text": "unique lesson text",
              "created": "2026-09-01T00:00:00.000Z"}
    (inbox / "lesson-1.json").write_text(json.dumps(lesson), encoding="utf-8")

    _, out1 = _run_hook(monkeypatch, capsys, {"session_id": "sess-2", "hook_event_name": "SessionStart"})
    assert "unique lesson text" in out1

    _, out2 = _run_hook(monkeypatch, capsys, {
        "session_id": "sess-2", "hook_event_name": "UserPromptSubmit", "prompt": "hi",
    })
    assert "unique lesson text" not in out2


def test_lesson_archived_after_five_deliveries(hook_env):
    world_name = "default"
    inbox = paths.inbox_dir(world_name)
    inbox.mkdir(parents=True, exist_ok=True)
    lesson_path = inbox / "lesson-1.json"
    lesson_path.write_text(json.dumps({
        "id": "lesson-1", "world": world_name, "pattern": "p", "text": "t",
        "created": "2026-09-01T00:00:00.000Z", "deliveries": 4,
    }), encoding="utf-8")

    hook._bump_lesson_deliveries(world_name, lesson_path)

    assert not lesson_path.exists()
    archived = inbox / "archive" / "lesson-1.json"
    assert archived.exists()
    assert json.loads(archived.read_text(encoding="utf-8"))["deliveries"] == 5


def test_pending_lessons_skips_json_loads_for_already_delivered(hook_env, monkeypatch):
    """300 already-delivered lessons are filtered by filename alone (the
    delivered set holds ids, and the inbox convention is `<id>.json`); only
    the one undelivered file should ever reach json.loads."""
    world_name = "default"
    inbox = paths.inbox_dir(world_name)
    inbox.mkdir(parents=True, exist_ok=True)
    session_id = "sess-many"
    delivered_file = paths.session_dir(session_id) / "delivered"
    delivered_file.parent.mkdir(parents=True, exist_ok=True)

    delivered_ids = [f"old-{i}" for i in range(300)]
    delivered_file.write_text("\n".join(delivered_ids) + "\n", encoding="utf-8")
    for lid in delivered_ids:
        (inbox / f"{lid}.json").write_text(json.dumps({
            "id": lid, "world": world_name, "pattern": "p", "text": "old",
            "created": "2020-01-01T00:00:00.000Z",
        }), encoding="utf-8")
    (inbox / "new-1.json").write_text(json.dumps({
        "id": "new-1", "world": world_name, "pattern": "p", "text": "brand new lesson",
        "created": "2026-09-01T00:00:00.000Z",
    }), encoding="utf-8")

    real_loads = json.loads
    calls = {"n": 0}

    def counting_loads(*a, **kw):
        calls["n"] += 1
        return real_loads(*a, **kw)

    monkeypatch.setattr(hook.json, "loads", counting_loads)

    lessons = hook._pending_lessons(world_name, session_id, "/tmp", limit=3)

    assert calls["n"] == 1
    assert [l["id"] for l in lessons] == ["new-1"]


def test_pending_lessons_since_session_start_filters_by_mtime(hook_env):
    """UserPromptSubmit only considers lessons that arrived since the
    session started (ARCHITECTURE.md), keyed off start.json's mtime/ts."""
    world_name = "default"
    inbox = paths.inbox_dir(world_name)
    inbox.mkdir(parents=True, exist_ok=True)
    session_id = "sess-since"
    session_dir = paths.session_dir(session_id)
    session_dir.mkdir(parents=True, exist_ok=True)

    old = inbox / "old-lesson.json"
    old.write_text(json.dumps({
        "id": "old-lesson", "world": world_name, "pattern": "p", "text": "pre-existing lesson",
        "created": "2020-01-01T00:00:00.000Z",
    }), encoding="utf-8")
    old_time = time.time() - 3600
    os.utime(old, (old_time, old_time))

    (session_dir / "start.json").write_text(json.dumps({
        "ts": hook._now_iso(), "cwd": "/tmp", "world": world_name, "git_head": None,
    }), encoding="utf-8")

    new = inbox / "new-lesson.json"
    new.write_text(json.dumps({
        "id": "new-lesson", "world": world_name, "pattern": "p",
        "text": "lesson that arrived after session start",
        "created": "2026-09-01T00:00:00.000Z",
    }), encoding="utf-8")

    lessons = hook._pending_lessons(world_name, session_id, "/tmp", limit=5, since_session_start=True)
    assert [l["id"] for l in lessons] == ["new-lesson"]


# --- nudge dir resolution: a blank nudges_dir must not leak cwd ----------

def test_dispatch_nudge_blank_nudges_dir_ignores_cwd_and_fires_breadcrumb(tmp_path, monkeypatch, capsys):
    """`Path("" or "")` used to resolve to `Path(".")`, the session cwd, so
    any *.json sitting in the operator's repo became a nudge source and
    could get injected as additionalContext. A blank nudges_dir must
    contribute no directory at all, and the missing-dir breadcrumb must
    still fire when nothing else provides one."""
    state = tmp_path / "state"
    plugin_root = tmp_path / "plugin"  # no "nudges" subdir: builtin dir absent too
    monkeypatch.setenv("SIL_STATE_DIR", str(state))
    monkeypatch.setenv("SIL_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("SIL_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(plugin_root))
    monkeypatch.setattr(hook.shutil, "which", lambda name: None)

    evil_cwd = tmp_path / "operator-repo"
    evil_cwd.mkdir()
    (evil_cwd / "evil.json").write_text(json.dumps({
        "pattern": "evil", "event": "PreToolUse", "matcher": "Bash",
        "gate": {"always": True}, "once_per": "always", "text": "INJECTED",
    }), encoding="utf-8")
    monkeypatch.chdir(evil_cwd)

    world = {"name": "default", "repos": [], "nudges_dir": "", "rules_file": "", "rules_inject": False}
    _write_snapshot(state, worlds=[world])

    payload = {"session_id": "sess-evil", "hook_event_name": "PreToolUse", "tool_name": "Bash",
               "tool_input": {"command": "ls"}}
    rc, out = _run_hook(monkeypatch, capsys, payload)
    assert rc == 0
    assert out == ""

    records = [json.loads(l) for l in paths.nudge_fires_file().read_text(encoding="utf-8").splitlines()]
    assert any(r.get("kind") == "nudge_dir_missing" for r in records)
    assert not any(r.get("pattern") == "evil" for r in records)


# --- PreToolUse / PostToolUse: nudges + usage events ---------------------

def test_pre_tool_use_dispatches_world_nudge_once_per_session(hook_env, monkeypatch, capsys):
    world_nudges = hook_env["data"] / "world-nudges"
    world_nudges.mkdir(parents=True, exist_ok=True)
    (world_nudges / "commit-hint.json").write_text(json.dumps({
        "pattern": "commit-hint", "event": "PreToolUse", "matcher": "Bash",
        "gate": {"command_matches": "git commit"}, "once_per": "session",
        "text": "double check the diff before committing",
    }), encoding="utf-8")
    world = {"name": "default", "repos": [], "nudges_dir": str(world_nudges),
             "rules_file": "", "rules_inject": False}
    _write_snapshot(hook_env["state"], worlds=[world])

    payload = {"session_id": "sess-nudge", "hook_event_name": "PreToolUse", "tool_name": "Bash",
               "tool_input": {"command": "git commit -m wip"}}
    rc, out = _run_hook(monkeypatch, capsys, payload)
    assert rc == 0
    obj = json.loads(out)
    assert obj["hookSpecificOutput"]["additionalContext"] == "double check the diff before committing"

    rc2, out2 = _run_hook(monkeypatch, capsys, payload)
    assert rc2 == 0
    assert out2 == ""  # fired once per session; no decision/block payload either


def test_post_tool_use_skill_produces_usage_event(hook_env, monkeypatch, capsys):
    world = {"name": "default", "repos": [], "nudges_dir": str(hook_env["plugin_root"] / "nudges"),
             "rules_file": "", "rules_inject": False}
    _write_snapshot(hook_env["state"], worlds=[world])

    payload = {
        "session_id": "sess-skill", "hook_event_name": "PostToolUse", "tool_name": "Skill",
        "tool_input": {"skill": "verify-callsites", "args": "check the diff"},
        "tool_response": {"success": True},
    }
    _run_hook(monkeypatch, capsys, payload)

    events = usage.read_events(paths.usage_events_file())
    assert len(events) == 1
    assert events[0]["kind"] == "skill"
    assert events[0]["ref"] == "skill:verify-callsites"
    assert "args" not in events[0]["detail"]


def test_post_tool_use_agent_produces_usage_event(hook_env, monkeypatch, capsys):
    world = {"name": "default", "repos": [], "nudges_dir": str(hook_env["plugin_root"] / "nudges"),
             "rules_file": "", "rules_inject": False}
    _write_snapshot(hook_env["state"], worlds=[world])

    payload = {
        "session_id": "sess-agent", "hook_event_name": "PostToolUse", "tool_name": "Agent",
        "tool_input": {"subagent_type": "critic", "description": "Reflect", "model": "claude-opus"},
        "tool_response": {"success": True},
    }
    _run_hook(monkeypatch, capsys, payload)

    events = usage.read_events(paths.usage_events_file())
    assert len(events) == 1
    assert events[0]["kind"] == "agent"
    assert events[0]["ref"] == "agent:critic"
    assert events[0]["detail"]["description"] == "Reflect"


# --- world resolution -----------------------------------------------------

def test_world_resolved_by_longest_repos_prefix(tmp_path, hook_env, monkeypatch, capsys):
    repo_a = tmp_path / "repos" / "a"
    repo_a_sub = repo_a / "sub"
    repo_a_sub.mkdir(parents=True)
    world_general = {"name": "general", "repos": [str(repo_a)], "nudges_dir": "",
                      "rules_file": "", "rules_inject": False}
    world_specific = {"name": "specific", "repos": [str(repo_a_sub)], "nudges_dir": "",
                       "rules_file": "", "rules_inject": False}
    _write_snapshot(hook_env["state"], worlds=[world_general, world_specific])

    payload = {"session_id": "sess-world", "hook_event_name": "SessionStart", "cwd": str(repo_a_sub)}
    _run_hook(monkeypatch, capsys, payload)

    start = json.loads((hook_env["state"] / "sessions" / "sess-world" / "start.json").read_text())
    assert start["world"] == "specific"


# --- Stop: queue upsert + transcript scan --------------------------------

def test_stop_upserts_queue_entry_and_increments_stops(hook_env, monkeypatch, capsys):
    world = {"name": "default", "repos": [], "nudges_dir": str(hook_env["plugin_root"] / "nudges"),
             "rules_file": "", "rules_inject": False}
    _write_snapshot(hook_env["state"], worlds=[world])

    payload = {"session_id": "sess-stop", "hook_event_name": "Stop", "stop_hook_active": False,
               "transcript_path": str(hook_env["state"] / "does-not-exist.jsonl")}
    _run_hook(monkeypatch, capsys, payload)
    _run_hook(monkeypatch, capsys, payload)

    qpath = paths.queue_dir("pending") / "sess-stop.json"
    entry = json.loads(qpath.read_text(encoding="utf-8"))
    assert entry["stops"] == 2
    assert entry["session_id"] == "sess-stop"
    assert entry["ended"] is False


def test_stop_with_stop_hook_active_does_nothing(hook_env, monkeypatch, capsys):
    world = {"name": "default", "repos": [], "nudges_dir": str(hook_env["plugin_root"] / "nudges"),
             "rules_file": "", "rules_inject": False}
    _write_snapshot(hook_env["state"], worlds=[world])

    payload = {"session_id": "sess-active", "hook_event_name": "Stop", "stop_hook_active": True,
               "transcript_path": "/does/not/matter.jsonl"}
    rc, out = _run_hook(monkeypatch, capsys, payload)
    assert rc == 0
    assert out == ""
    qpath = paths.queue_dir("pending") / "sess-active.json"
    assert not qpath.exists()


def test_stop_transcript_scan_produces_hook_run_events_and_tool_uses(hook_env, monkeypatch, capsys):
    world = {"name": "default", "repos": [], "nudges_dir": str(hook_env["plugin_root"] / "nudges"),
             "rules_file": "", "rules_inject": False}
    _write_snapshot(hook_env["state"], worlds=[world])

    transcript = hook_env["state"] / "transcript.jsonl"
    lines = []
    for i in range(3):
        lines.append(json.dumps({
            "type": "attachment",
            "attachment": {"type": "hook_success", "hookName": f"hook-{i}", "exitCode": 0,
                           "durationMs": 5, "hookEvent": "PreToolUse"},
        }))
    lines.append(json.dumps({
        "type": "assistant",
        "message": {"role": "assistant", "content": [
            {"type": "tool_use", "name": "Bash", "input": {}},
            {"type": "text", "text": "hi"},
        ]},
    }))
    lines.append(json.dumps({
        "type": "assistant",
        "message": {"role": "assistant", "content": [{"type": "tool_use", "name": "Edit", "input": {}}]},
    }))
    transcript.write_text("\n".join(lines) + "\n", encoding="utf-8")

    payload = {"session_id": "sess-scan", "hook_event_name": "Stop", "stop_hook_active": False,
               "transcript_path": str(transcript)}
    _run_hook(monkeypatch, capsys, payload)

    events = usage.read_events(paths.usage_events_file())
    hook_run_events = [e for e in events if e["kind"] == "hook_run"]
    assert len(hook_run_events) == 3
    assert {e["ref"] for e in hook_run_events} == {"hook:hook-0", "hook:hook-1", "hook:hook-2"}

    qpath = paths.queue_dir("pending") / "sess-scan.json"
    entry = json.loads(qpath.read_text(encoding="utf-8"))
    assert entry["tool_uses"] == 2

    # Second Stop with no new transcript content: offset resumes, no duplicates.
    _run_hook(monkeypatch, capsys, payload)
    events_after = usage.read_events(paths.usage_events_file())
    assert len(events_after) == len(events)
    entry_after = json.loads(qpath.read_text(encoding="utf-8"))
    assert entry_after["tool_uses"] == 2
    assert entry_after["stops"] == 2


def test_stop_transcript_scan_skips_oversized_line_and_resumes(hook_env, monkeypatch, capsys):
    """A single transcript line over MAX_TRANSCRIPT_SCAN_BYTES must not stall
    the offset forever: it gets skipped, and later records are still seen."""
    world = {"name": "default", "repos": [], "nudges_dir": str(hook_env["plugin_root"] / "nudges"),
             "rules_file": "", "rules_inject": False}
    _write_snapshot(hook_env["state"], worlds=[world])

    transcript = hook_env["state"] / "transcript.jsonl"
    huge_line = "x" * (hook.MAX_TRANSCRIPT_SCAN_BYTES + 1024 * 1024)  # no embedded newline
    normal = json.dumps({
        "type": "attachment",
        "attachment": {"type": "hook_success", "hookName": "hook-after", "exitCode": 0,
                       "durationMs": 1, "hookEvent": "PreToolUse"},
    })
    transcript.write_text(huge_line + "\n" + normal + "\n", encoding="utf-8")

    payload = {"session_id": "sess-huge", "hook_event_name": "Stop", "stop_hook_active": False,
               "transcript_path": str(transcript)}

    _run_hook(monkeypatch, capsys, payload)  # first Stop: fills the scan cap, no newline, skips
    events_first = usage.read_events(paths.usage_events_file())
    assert not any(e["kind"] == "hook_run" for e in events_first)

    _run_hook(monkeypatch, capsys, payload)  # second Stop: resumes past the huge line
    events_second = usage.read_events(paths.usage_events_file())
    hook_run_events = [e for e in events_second if e["kind"] == "hook_run"]
    assert len(hook_run_events) == 1
    assert hook_run_events[0]["ref"] == "hook:hook-after"


def test_concurrent_stop_processes_serialize_queue_and_scan_updates(hook_env):
    """Four hook processes racing on the same session_id must not lose
    queue/offset updates: stops counts every call, but the transcript scan
    (and its hook_run events) must never double count."""
    world = {"name": "default", "repos": [], "nudges_dir": str(hook_env["plugin_root"] / "nudges"),
             "rules_file": "", "rules_inject": False}
    _write_snapshot(hook_env["state"], worlds=[world])

    transcript = hook_env["state"] / "transcript.jsonl"
    lines = []
    for i in range(3):
        lines.append(json.dumps({
            "type": "attachment",
            "attachment": {"type": "hook_success", "hookName": f"hook-{i}", "exitCode": 0,
                           "durationMs": 1, "hookEvent": "PreToolUse"},
        }))
    lines.append(json.dumps({
        "type": "assistant",
        "message": {"role": "assistant", "content": [{"type": "tool_use", "name": "Bash", "input": {}}]},
    }))
    transcript.write_text("\n".join(lines) + "\n", encoding="utf-8")

    payload = json.dumps({
        "session_id": "sess-concurrent", "hook_event_name": "Stop", "stop_hook_active": False,
        "transcript_path": str(transcript),
    })
    env = dict(os.environ)
    env.update({
        "SIL_STATE_DIR": str(hook_env["state"]),
        "SIL_DATA_DIR": str(hook_env["data"]),
        "SIL_CONFIG_DIR": str(hook_env["config"]),
        "CLAUDE_PLUGIN_ROOT": str(hook_env["plugin_root"]),
    })

    procs = [
        subprocess.Popen([sys.executable, str(REPO_ROOT / "sil" / "hook.py")],
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, env=env)
        for _ in range(4)
    ]
    for p in procs:
        p.stdin.write(payload)
        p.stdin.close()
    for p in procs:
        rc = p.wait(timeout=10)
        assert rc == 0, p.stderr.read()

    qpath = paths.queue_dir("pending") / "sess-concurrent.json"
    entry = json.loads(qpath.read_text(encoding="utf-8"))
    assert entry["stops"] == 4
    assert entry["tool_uses"] == 1

    events = usage.read_events(paths.usage_events_file())
    hook_run_events = [e for e in events if e["kind"] == "hook_run"]
    assert len(hook_run_events) == 3


# --- SubagentStop: allowlisted detail only --------------------------------

def test_subagent_stop_detail_is_allowlisted_to_subagent_type(hook_env, monkeypatch, capsys):
    world = {"name": "default", "repos": [], "nudges_dir": str(hook_env["plugin_root"] / "nudges"),
             "rules_file": "", "rules_inject": False}
    _write_snapshot(hook_env["state"], worlds=[world])

    payload = {
        "session_id": "sess-substop", "hook_event_name": "SubagentStop", "subagent_type": "critic",
        "prompt": "secret task instructions", "result": "secret result",
        "last_assistant_message": "secret message", "transcript_path": "/secret/path.jsonl",
    }
    _run_hook(monkeypatch, capsys, payload)

    events = usage.read_events(paths.usage_events_file())
    assert len(events) == 1
    assert events[0]["kind"] == "agent_stop"
    assert events[0]["detail"] == {"subagent_type": "critic"}


# --- handler failures: never log the payload ------------------------------

def test_handler_failure_logs_type_and_truncated_message_only(hook_env, monkeypatch, capsys):
    world = {"name": "default", "repos": [], "nudges_dir": str(hook_env["plugin_root"] / "nudges"),
             "rules_file": "", "rules_inject": False}
    _write_snapshot(hook_env["state"], worlds=[world])

    secret = "SECRET-" + ("x" * 200)

    def boom(payload, world, snapshot):
        raise ValueError(secret)

    monkeypatch.setitem(hook.HANDLERS, "PreToolUse", boom)

    payload = {"session_id": "sess-boom", "hook_event_name": "PreToolUse", "tool_name": "Bash",
               "tool_input": {"command": "echo hi"}}
    rc, out = _run_hook(monkeypatch, capsys, payload)
    assert rc == 0
    assert out == ""

    log_text = paths.log_file("hook").read_text(encoding="utf-8")
    assert "ValueError" in log_text
    assert secret not in log_text
    assert secret[:120] in log_text


# --- worker kick ------------------------------------------------------

def _uv_calls(calls):
    """`_git_head` also goes through `subprocess.run`, which is implemented on
    top of `Popen`, so a patched Popen sees that call too. Only a `uv ...`
    argv is the worker kick under test."""
    return [c for c in calls if c[0][0] and c[0][0][0] == "uv"]


def test_worker_kick_skipped_when_snapshot_file_missing(hook_env, monkeypatch, capsys):
    """No hook-config.json means the plugin was never `sil init`ed: must not
    spawn a worker even though `_load_snapshot()` falls back to defaults
    with auto_kick True."""
    monkeypatch.setattr(hook.shutil, "which", lambda name: "/usr/bin/uv")
    calls = []
    monkeypatch.setattr(hook.subprocess, "Popen", lambda *a, **kw: calls.append((a, kw)))

    _run_hook(monkeypatch, capsys, {"session_id": "sess-noinit", "hook_event_name": "SessionStart"})
    assert _uv_calls(calls) == []


def test_worker_kick_not_blocked_by_stale_lock_file(hook_env, monkeypatch, capsys):
    """A lock file naming a dead pid must not block the kick: sil.worker.Lock
    never unlinks the file on a clean exit, so existence alone is stale."""
    world = {"name": "default", "repos": [], "nudges_dir": "", "rules_file": "", "rules_inject": False}
    _write_snapshot(hook_env["state"], worlds=[world],
                     worker={"idle_minutes": 10, "curriculum_interval_minutes": 60,
                             "min_tool_uses": 6, "auto_kick": True},
                     plugin_root=hook_env["plugin_root"])
    monkeypatch.setattr(hook.shutil, "which", lambda name: "/usr/bin/uv")
    paths.worker_lock_file().parent.mkdir(parents=True, exist_ok=True)
    paths.worker_lock_file().write_text(str(2**22 - 1))  # not a live pid

    calls = []
    monkeypatch.setattr(hook.subprocess, "Popen", lambda *a, **kw: calls.append((a, kw)))

    _run_hook(monkeypatch, capsys, {"session_id": "sess-lock", "hook_event_name": "SessionStart"})
    assert len(_uv_calls(calls)) == 1


def test_worker_kick_blocked_by_live_lock_file(hook_env, monkeypatch, capsys):
    world = {"name": "default", "repos": [], "nudges_dir": "", "rules_file": "", "rules_inject": False}
    _write_snapshot(hook_env["state"], worlds=[world],
                     worker={"idle_minutes": 10, "curriculum_interval_minutes": 60,
                             "min_tool_uses": 6, "auto_kick": True})
    monkeypatch.setattr(hook.shutil, "which", lambda name: "/usr/bin/uv")
    paths.worker_lock_file().parent.mkdir(parents=True, exist_ok=True)
    paths.worker_lock_file().write_text(str(os.getpid()))  # this test process is alive

    calls = []
    monkeypatch.setattr(hook.subprocess, "Popen", lambda *a, **kw: calls.append((a, kw)))

    _run_hook(monkeypatch, capsys, {"session_id": "sess-lock", "hook_event_name": "SessionStart"})
    assert _uv_calls(calls) == []


def test_worker_kick_throttled_by_recent_last_kick(hook_env, monkeypatch, capsys):
    world = {"name": "default", "repos": [], "nudges_dir": "", "rules_file": "", "rules_inject": False}
    _write_snapshot(hook_env["state"], worlds=[world],
                     worker={"idle_minutes": 10, "curriculum_interval_minutes": 60,
                             "min_tool_uses": 6, "auto_kick": True})
    monkeypatch.setattr(hook.shutil, "which", lambda name: "/usr/bin/uv")
    last_kick = hook_env["state"] / "last-kick"
    last_kick.parent.mkdir(parents=True, exist_ok=True)
    last_kick.touch()

    calls = []
    monkeypatch.setattr(hook.subprocess, "Popen", lambda *a, **kw: calls.append((a, kw)))

    _run_hook(monkeypatch, capsys, {"session_id": "sess-throttle", "hook_event_name": "SessionStart"})
    assert _uv_calls(calls) == []


def test_worker_kick_skipped_when_no_pending_work_and_curriculum_current(hook_env, monkeypatch, capsys):
    world = {"name": "default", "repos": [], "nudges_dir": "", "rules_file": "", "rules_inject": False}
    _write_snapshot(hook_env["state"], worlds=[world],
                     worker={"idle_minutes": 10, "curriculum_interval_minutes": 60,
                             "min_tool_uses": 6, "auto_kick": True})
    monkeypatch.setattr(hook.shutil, "which", lambda name: "/usr/bin/uv")
    (hook_env["state"] / "last-curriculum-default").touch()  # curriculum fresh, no pending queue

    calls = []
    monkeypatch.setattr(hook.subprocess, "Popen", lambda *a, **kw: calls.append((a, kw)))
    _run_hook(monkeypatch, capsys, {"session_id": "sess-nowork", "hook_event_name": "SessionStart"})
    assert _uv_calls(calls) == []


def test_worker_kick_fires_when_pending_queue_nonempty(hook_env, monkeypatch, capsys):
    world = {"name": "default", "repos": [], "nudges_dir": "", "rules_file": "", "rules_inject": False}
    _write_snapshot(hook_env["state"], worlds=[world],
                     worker={"idle_minutes": 10, "curriculum_interval_minutes": 60,
                             "min_tool_uses": 6, "auto_kick": True},
                     plugin_root=hook_env["plugin_root"])
    monkeypatch.setattr(hook.shutil, "which", lambda name: "/usr/bin/uv")
    (hook_env["state"] / "last-curriculum-default").touch()  # curriculum fresh
    pending = hook_env["state"] / "queue" / "pending"
    pending.mkdir(parents=True, exist_ok=True)
    (pending / "sess-x.json").write_text("{}", encoding="utf-8")

    calls = []
    monkeypatch.setattr(hook.subprocess, "Popen", lambda *a, **kw: calls.append((a, kw)))
    _run_hook(monkeypatch, capsys, {"session_id": "sess-work", "hook_event_name": "SessionStart"})
    assert len(_uv_calls(calls)) == 1


def test_worker_kick_fires_when_eligible(hook_env, monkeypatch, capsys):
    world = {"name": "default", "repos": [], "nudges_dir": "", "rules_file": "", "rules_inject": False}
    _write_snapshot(hook_env["state"], worlds=[world],
                     worker={"idle_minutes": 10, "curriculum_interval_minutes": 60,
                             "min_tool_uses": 6, "auto_kick": True},
                     plugin_root=hook_env["plugin_root"])
    monkeypatch.setattr(hook.shutil, "which", lambda name: "/usr/bin/uv")

    calls = []

    class FakePopen:
        def __init__(self, *a, **kw):
            calls.append((a, kw))

    monkeypatch.setattr(hook.subprocess, "Popen", FakePopen)

    _run_hook(monkeypatch, capsys, {"session_id": "sess-kick", "hook_event_name": "SessionStart"})
    uv_calls = _uv_calls(calls)
    assert len(uv_calls) == 1
    args, kwargs = uv_calls[0]
    cmd = args[0]
    assert cmd[:3] == ["uv", "run", "--project"]
    assert cmd[-3:] == ["sil", "worker", "--once"]
    assert kwargs["start_new_session"] is True
    assert (hook_env["state"] / "last-kick").exists()
