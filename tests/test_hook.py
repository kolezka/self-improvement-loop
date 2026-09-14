"""Tests for sil/hook.py: the plugin's single hook entry point."""

from __future__ import annotations

import io
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

from sil import consts, hook, paths, usage

REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURES_DIR = REPO_ROOT / "tests" / "fixtures" / "hook-payloads"
FIXTURE_FILES = sorted(FIXTURES_DIR.glob("*.json"))


# --- hard constraint: stdlib only --------------------------------------

STDLIB_ONLY_MODULES = ["sil.hook", "sil.nudge", "sil.usage", "sil.paths", "sil.consts"]
STDLIB_ONLY_FILES = [REPO_ROOT / "sil" / f"{m.rsplit('.', 1)[1]}.py" for m in STDLIB_ONLY_MODULES]

THIRD_PARTY_IMPORT_RE = re.compile(r"^\s*(import|from)\s+(pydantic|yaml|fastapi)\b", re.MULTILINE)


def test_stdlib_only_modules_import_under_bare_python():
    code = "import sys; sys.path.insert(0, %r); %s" % (
        str(REPO_ROOT), "; ".join(f"import {m}" for m in STDLIB_ONLY_MODULES),
    )
    result = subprocess.run(
        [sys.executable, "-I", "-c", code],
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
        "name": "default", "repos": [], "nudges_dir": "", "rules_file": "", "rules_inject": False,
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
def test_hook_fixture_payloads_exit_zero_with_valid_output(tmp_path, fixture_path):
    payload = fixture_path.read_text(encoding="utf-8")
    env = _isolated_subprocess_env(tmp_path)
    result = subprocess.run(
        [sys.executable, str(REPO_ROOT / "sil" / "hook.py")],
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


# --- in-process helpers --------------------------------------------------

def _write_snapshot(state_dir: Path, worlds=None, worker=None, plugin_root=None) -> None:
    snap = {
        "version": 1,
        "worlds": worlds or [{
            "name": "default", "repos": [], "nudges_dir": "", "rules_file": "", "rules_inject": False,
        }],
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
    assert events[0]["detail"]["args"] == "check the diff"


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


# --- worker kick ------------------------------------------------------

def _uv_calls(calls):
    """`_git_head` also goes through `subprocess.run`, which is implemented on
    top of `Popen`, so a patched Popen sees that call too. Only a `uv ...`
    argv is the worker kick under test."""
    return [c for c in calls if c[0][0] and c[0][0][0] == "uv"]


def test_worker_kick_skipped_when_lock_file_exists(hook_env, monkeypatch, capsys):
    world = {"name": "default", "repos": [], "nudges_dir": "", "rules_file": "", "rules_inject": False}
    _write_snapshot(hook_env["state"], worlds=[world],
                     worker={"idle_minutes": 10, "curriculum_interval_minutes": 60,
                             "min_tool_uses": 6, "auto_kick": True})
    monkeypatch.setattr(hook.shutil, "which", lambda name: "/usr/bin/uv")
    paths.worker_lock_file().parent.mkdir(parents=True, exist_ok=True)
    paths.worker_lock_file().touch()

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
