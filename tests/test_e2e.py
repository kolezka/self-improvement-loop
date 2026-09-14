"""End to end: hooks -> queue -> worker/critic -> reflection -> inbox -> next
session, then reflections -> curriculum -> staged branch -> review -> accept ->
relink, all through the real modules with a fake model transport and the real
hook script run as a subprocess (the way Claude Code runs it)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
HOOK = REPO / "sil" / "hook.py"
PATTERN = "verify-callsites"


@pytest.fixture
def env(tmp_path, monkeypatch):
    dirs = {
        "SIL_CONFIG_DIR": tmp_path / "config",
        "SIL_STATE_DIR": tmp_path / "state",
        "SIL_DATA_DIR": tmp_path / "data",
        "CLAUDE_CONFIG_DIR": tmp_path / "claude",
        "CLAUDE_PLUGIN_ROOT": REPO,
    }
    for k, v in dirs.items():
        monkeypatch.setenv(k, str(v))
    monkeypatch.setenv("LITELLM_API_KEY", "sentinel-key-never-sent")
    from sil.cli import main

    assert main(["init", "--model", "fake/model"]) == 0
    # The SessionStart hook would spawn a real detached worker (no fake chat)
    # and race the in-process one; tests drive the worker explicitly.
    from sil.config import load_config, save_config, write_hook_snapshot

    cfg = load_config()
    cfg.worker.auto_kick = False
    save_config(cfg)
    write_hook_snapshot(cfg)
    return dirs


def run_hook(payload: dict) -> dict | None:
    proc = subprocess.run(
        [sys.executable, str(HOOK)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env=os.environ.copy(),
        timeout=20,
    )
    assert proc.returncode == 0, proc.stderr
    assert proc.stderr == ""
    return json.loads(proc.stdout) if proc.stdout.strip() else None


def write_transcript(path: Path, session_id: str, cwd: Path) -> None:
    def rec(kind: str, content):
        return {"type": kind, "sessionId": session_id, "cwd": str(cwd),
                "timestamp": "2026-09-14T10:00:00.000Z", "message": {"role": kind, "content": content}}

    lines = [
        rec("user", "Please make the change safe: check every consumer of the symbol"),
    ]
    for i in range(7):
        lines.append(rec("assistant", [{"type": "tool_use", "id": f"t{i}", "name": "Bash",
                                        "input": {"command": f"rg -n symbol_{i} src/"}}]))
        lines.append(rec("user", [{"type": "tool_result", "tool_use_id": f"t{i}", "content": "src/a.py:1"}]))
    lines.append(rec("assistant", [{"type": "tool_use", "id": "s1", "name": "Skill",
                                    "input": {"skill": "verify-callsites", "args": ""}}]))
    lines.append(rec("assistant", [{"type": "tool_use", "id": "a1", "name": "Agent",
                                    "input": {"subagent_type": "explorer", "model": "haiku", "description": "find"}}]))
    lines.append(rec("assistant", [{"type": "text", "text": "Done. Every call site now has the guard."}]))
    for name in ("PreToolUse:Bash", "PostToolUse:Bash", "SessionStart:startup"):
        lines.append({"type": "attachment", "sessionId": session_id,
                      "attachment": {"type": "hook_success", "hookName": name, "hookEvent": name.split(":")[0],
                                     "exitCode": "0", "durationMs": "12"}})
    lines.append({"type": "ai-title", "title": "noise"})
    path.write_text("\n".join(json.dumps(l) for l in lines) + "\n", encoding="utf-8")


def reflection_body(n: int) -> str:
    return (
        "Last updated: 2026-09-14\n\n"
        f"Pattern: {PATTERN}\n\n"
        "## What worked\n"
        f"Enumerating every consumer of the symbol with ripgrep before editing (occurrence {n}).\n"
        "## What failed & why\n"
        "One consumer lacked the guard and the obvious callsite hid it.\n"
        "## Reusable lesson\n"
        "Before calling a change safe, enumerate every callsite of the changed symbol with ripgrep "
        "and confirm each consumer carries the guard.\n"
        "## Verification\n"
        "Ran: rg -n symbol src/ -> exit 0, 7 callsites listed\n"
        "## Not verified\n"
        "none, checked scope: src/\n"
    )


SKILL_TEXT = f"""---
name: {PATTERN}
description: Use when a symbol changes and the change must be called safe. Enumerate every callsite and consumer before concluding.
---

Before calling a change safe, enumerate every callsite of the changed symbol with
ripgrep and confirm each consumer carries the guard. One consumer without the
guard is the whole bug, so do not generalise from the obvious callsite.
"""


def fake_chat(role, messages, *, world, cfg_llm=None, json_mode=False, max_tokens=4000):
    if role == "critic":
        return json.dumps({
            "record": True,
            "pattern": PATTERN,
            "what_worked": "Enumerated every consumer of the symbol with ripgrep.",
            "what_failed": "One consumer lacked the guard.",
            "lesson": "Before calling a change safe, enumerate every callsite of the changed symbol.",
            "verification": "rg -n symbol src/ -> exit 0",
            "not_verified": ["the test suite was not run"],
            "lesson_short": "Enumerate every callsite of a changed symbol before calling it safe.",
            "confidence": 0.8,
            "artifacts_used": ["skill:verify-callsites", "agent:explorer"],
            "artifacts_helpful": ["skill:verify-callsites"],
            "artifacts_misfired": [],
            "rules_relevant": [],
        })
    if role == "drafter":
        return json.dumps({
            "artifact": SKILL_TEXT,
            "trigger_event": "none",
            "gate": None,
            "needs_own_context": False,
            "context_evidence": None,
            "capability_evidence": "enumerate every callsite of the changed symbol with ripgrep and confirm each consumer carries the guard",
        })
    if role == "judge":
        return json.dumps({"verdict": "yes", "reason": "grounded and operational"})
    raise AssertionError(f"unexpected role {role}")


def test_session_to_lesson_to_next_session(env, tmp_path):
    from sil import store, worker
    from sil.config import load_config

    cwd = tmp_path / "proj"
    cwd.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=cwd, check=True)
    sid = "e2e-session-1"
    transcript = tmp_path / f"{sid}.jsonl"
    write_transcript(transcript, sid, cwd)

    base = {"session_id": sid, "cwd": str(cwd), "transcript_path": str(transcript)}
    out = run_hook({**base, "hook_event_name": "SessionStart", "source": "startup"})
    assert out and "self-improvement-loop is active" in out["hookSpecificOutput"]["additionalContext"]

    run_hook({**base, "hook_event_name": "PostToolUse", "tool_name": "Skill",
              "tool_input": {"skill": "verify-callsites"}, "tool_response": {}})
    run_hook({**base, "hook_event_name": "PostToolUse", "tool_name": "Agent",
              "tool_input": {"subagent_type": "explorer", "model": "haiku"}, "tool_response": {}})
    run_hook({**base, "hook_event_name": "Stop", "stop_hook_active": False})
    run_hook({**base, "hook_event_name": "SessionEnd"})

    pending = worker.queue_list("pending")
    assert [e.session_id for e in pending] == [sid]
    assert pending[0].ended and pending[0].tool_uses >= 6

    events = [json.loads(l) for l in (env["SIL_STATE_DIR"] / "usage" / "events.jsonl").read_text().splitlines()]
    refs = {e["ref"] for e in events}
    assert {"skill:verify-callsites", "agent:explorer", "hook:PreToolUse:Bash"} <= refs

    cfg = load_config()
    summary = worker.run_once(cfg, curriculum=False, chat=fake_chat)
    assert summary["reflected"] and not summary["failed"], summary

    refl = store.list_reflections("default")
    assert len(refl) == 1 and refl[0].pattern == PATTERN
    assert refl[0].artifacts_helpful == ["skill:verify-callsites"]
    text = refl[0].path.read_text()
    assert "sentinel-key-never-sent" not in text
    for heading in store.SECTIONS:
        assert heading in text

    lessons = store.list_lessons("default")
    assert len(lessons) == 1 and "Enumerate every callsite" in lessons[0].text

    out = run_hook({"session_id": "e2e-session-2", "cwd": str(cwd), "transcript_path": str(tmp_path / "x.jsonl"),
                    "hook_event_name": "SessionStart", "source": "startup"})
    ctx = out["hookSpecificOutput"]["additionalContext"]
    assert "Enumerate every callsite" in ctx
    assert "decision" not in out and "permissionDecision" not in json.dumps(out)


def test_reflections_to_staged_branch_to_accept_and_relink(env, tmp_path):
    from sil import feedback, review, run, store
    from sil.config import load_config, target_root, world_named

    for n in range(3):
        store.write_reflection("default", {"id": f"2026-09-1{n}-{PATTERN}-{n:04x}", "session_id": f"s{n}"},
                               reflection_body(n))
    cfg = load_config()
    world = world_named(cfg, "default")
    target = target_root(world)

    dry = run.run(world, cfg, apply=False, chat=fake_chat)
    assert dry.dry_run and PATTERN in dry.staged, dry
    assert not (target / "skills" / PATTERN).exists()

    report = run.run(world, cfg, apply=True, chat=fake_chat)
    assert report.staged == [PATTERN], report
    head_before = subprocess.run(["git", "-C", str(target), "rev-parse", "HEAD"], capture_output=True, text=True).stdout
    assert not (target / "skills" / PATTERN).exists(), "staging must not touch the live main checkout"

    queue = review.queue(world, cfg)
    assert [q.pattern for q in queue] == [PATTERN]
    detail = review.detail(world, cfg, PATTERN)
    diff = review.diff(world, cfg, PATTERN)
    assert detail.reviewed_state == diff.reviewed_state and len(diff.reviewed_state) == 64
    assert detail.accept_blocked is None, detail.accept_blocked
    assert f"name: {PATTERN}" in detail.body

    with pytest.raises(review.ReviewError):
        review.accept(world, cfg, PATTERN, "0" * 64)

    result = review.accept(world, cfg, PATTERN, detail.reviewed_state)
    assert result.get("merged") or result.get("status") == "promoted", result
    head_after = subprocess.run(["git", "-C", str(target), "rev-parse", "HEAD"], capture_output=True, text=True).stdout
    assert head_after != head_before
    assert (target / "skills" / PATTERN / "SKILL.md").exists()
    ledger = store.load_ledger(target / "promotions.json")
    assert ledger.entries[PATTERN].status == "promoted"
    link = env["CLAUDE_CONFIG_DIR"] / "skills" / PATTERN
    assert link.is_symlink() and (link / "SKILL.md").exists()
    assert review.queue(world, cfg) == []

    rows = review.inventory(world, cfg)
    assert [r.pattern for r in rows] == [PATTERN] and rows[0].status == "promoted"

    feedback.rebuild(world, cfg)
    cards = {c.ref: c for c in feedback.load(world)}
    assert f"skill:{PATTERN}" in cards and cards[f"skill:{PATTERN}"].proposal == "new"

    again = run.run(world, cfg, apply=True, chat=fake_chat)
    assert again.staged == [] and PATTERN not in again.gated_out, again


def test_web_api_serves_real_backend(env, tmp_path):
    from fastapi.testclient import TestClient

    from sil import store
    from sil.web.server import create_app

    store.write_reflection("default", {"id": f"2026-09-14-{PATTERN}-beef"}, reflection_body(0))
    app = create_app(token="t0k3n")
    app.state.port = 8766
    client = TestClient(app, base_url="http://127.0.0.1:8766")
    headers = {"X-SIL-Local": "1", "X-SIL-Token": "t0k3n"}

    assert client.get("/api/health/report", headers=headers).status_code == 200
    r = client.get("/api/reflections/list", params={"world": "default"}, headers=headers)
    assert r.status_code == 200 and r.json()[0]["pattern"] == PATTERN
    r = client.get("/api/curriculum/plan", params={"world": "default"}, headers=headers)
    assert r.status_code == 200 and r.json()["threshold"] == 3
    r = client.get("/api/review/queue", params={"world": "default"}, headers=headers)
    assert r.status_code == 200 and r.json() == []
    r = client.get("/api/router/inventory", params={"world": "default"}, headers=headers)
    assert r.status_code == 200
    assert client.get("/api/reflections/list", params={"world": "default"}).status_code in (401, 403)
    assert client.get("/").status_code == 200
