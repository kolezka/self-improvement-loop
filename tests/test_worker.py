"""Tests for sil.worker. Never calls a real model: reflect_session's chat
is always a fake injected through run_once."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from sil import config as config_mod
from sil import paths, store, worker
from sil.models import Config, LlmConfig, QueueEntry, World, WorkerConfig

from test_transcript import set_sil_dirs, write_sample_transcript


def _prepare_env(monkeypatch, tmp_path) -> None:
    set_sil_dirs(monkeypatch, tmp_path)
    config_mod.save_llm(LlmConfig(models={"critic": "test-model"}))


def _write_pending(tmp_path, session_id, *, ended, transcript_ok=True, tool_uses=5, world="default") -> QueueEntry:
    if transcript_ok:
        tp = write_sample_transcript(tmp_path / session_id, session_id=session_id)
    else:
        tp = tmp_path / session_id / "missing.jsonl"
    entry = QueueEntry(
        session_id=session_id,
        transcript_path=tp,
        cwd=tmp_path / session_id,
        world=world,
        git_head="abc123",
        first_stop="2026-09-14T10:00:00Z",
        last_stop="2026-09-14T10:05:00Z",
        stops=1,
        ended=ended,
        tool_uses=tool_uses,
    )
    dest = paths.queue_dir("pending") / f"{session_id}.json"
    store.atomic_write(dest, entry.model_dump_json(indent=2) + "\n")
    return entry


def _good_chat(role, messages, *, world, cfg_llm, json_mode=False, max_tokens=4000):
    return json.dumps(
        {
            "record": True,
            "pattern": "some-lesson",
            "what_worked": "ok",
            "what_failed": "n/a",
            "lesson": "do the thing",
            "verification": "ran it",
            "not_verified": [],
            "lesson_short": None,
            "confidence": 0.9,
            "artifacts_used": [],
            "artifacts_helpful": [],
            "artifacts_misfired": [],
            "rules_relevant": [],
        }
    )


def _cfg():
    return Config(worlds=[World(name="default")], worker=WorkerConfig(idle_minutes=10, min_tool_uses=1))


# --- run_once: eligible entry --------------------------------------------------

def test_run_once_processes_eligible_entry_to_done(tmp_path, monkeypatch):
    _prepare_env(monkeypatch, tmp_path)
    _write_pending(tmp_path, "sess-good", ended=True)

    summary = worker.run_once(_cfg(), reflect=True, curriculum=False, chat=_good_chat)

    assert summary["reflected"] == ["sess-good"]
    assert summary["failed"] == []
    assert worker.load_entry("pending", "sess-good") is None
    done = worker.load_entry("done", "sess-good")
    assert done is not None
    assert done.result and done.result.startswith("recorded:")


# --- run_once: not idle, not ended --------------------------------------------

def test_run_once_leaves_non_idle_non_ended_entry_pending(tmp_path, monkeypatch):
    _prepare_env(monkeypatch, tmp_path)
    _write_pending(tmp_path, "sess-fresh", ended=False)

    summary = worker.run_once(_cfg(), reflect=True, curriculum=False, chat=_good_chat)

    assert summary["skipped"] == ["sess-fresh"]
    assert summary["reflected"] == []
    assert worker.load_entry("pending", "sess-fresh") is not None


# --- run_once: missing transcript -----------------------------------------------

def test_run_once_moves_missing_transcript_entry_to_failed(tmp_path, monkeypatch):
    _prepare_env(monkeypatch, tmp_path)
    _write_pending(tmp_path, "sess-no-transcript", ended=True, transcript_ok=False)

    summary = worker.run_once(_cfg(), reflect=True, curriculum=False, chat=_good_chat)

    assert summary["failed"] == ["sess-no-transcript"]
    assert worker.load_entry("pending", "sess-no-transcript") is None
    failed = worker.load_entry("failed", "sess-no-transcript")
    assert failed is not None
    assert "transcript missing" in failed.result


# --- run_once: lock held --------------------------------------------------------

def test_run_once_is_noop_when_lock_is_held(tmp_path, monkeypatch):
    _prepare_env(monkeypatch, tmp_path)
    _write_pending(tmp_path, "sess-locked", ended=True)

    with worker.Lock():
        summary = worker.run_once(_cfg(), reflect=True, curriculum=False, chat=_good_chat)

    assert summary == {"skipped": "locked"}
    assert worker.load_entry("pending", "sess-locked") is not None  # untouched


# --- run_once: survives a chat exception ----------------------------------------

def test_run_once_survives_chat_exception_and_continues(tmp_path, monkeypatch):
    _prepare_env(monkeypatch, tmp_path)
    _write_pending(tmp_path, "sess-bad", ended=True)
    _write_pending(tmp_path, "sess-good", ended=True)

    def flaky_chat(role, messages, *, world, cfg_llm, json_mode=False, max_tokens=4000):
        content = json.dumps(messages)
        if "sess-bad" in content:
            raise RuntimeError("boom")
        return _good_chat(role, messages, world=world, cfg_llm=cfg_llm, json_mode=json_mode, max_tokens=max_tokens)

    summary = worker.run_once(_cfg(), reflect=True, curriculum=False, chat=flaky_chat)

    assert "sess-bad" in summary["failed"]
    assert "sess-good" in summary["reflected"]
    failed = worker.load_entry("failed", "sess-bad")
    assert failed is not None
    assert "boom" in failed.result
    assert worker.load_entry("done", "sess-good") is not None


# --- eligible() ------------------------------------------------------------------

def test_eligible_true_for_ended_entry_with_enough_tool_uses(tmp_path, monkeypatch):
    _prepare_env(monkeypatch, tmp_path)
    entry = _write_pending(tmp_path, "sess-e", ended=True, tool_uses=3)
    ok, reason = worker.eligible(entry, _cfg(), datetime.now(timezone.utc))
    assert ok is True
    assert reason == "eligible"


def test_eligible_false_below_min_tool_uses(tmp_path, monkeypatch):
    _prepare_env(monkeypatch, tmp_path)
    entry = _write_pending(tmp_path, "sess-e2", ended=True, tool_uses=0)
    cfg = Config(worlds=[World(name="default")], worker=WorkerConfig(min_tool_uses=99))
    ok, reason = worker.eligible(entry, cfg, datetime.now(timezone.utc))
    assert ok is False
    assert reason == "below min_tool_uses"


def test_eligible_true_when_transcript_idle_long_enough(tmp_path, monkeypatch):
    _prepare_env(monkeypatch, tmp_path)
    entry = _write_pending(tmp_path, "sess-e3", ended=False, tool_uses=3)
    cfg = Config(worlds=[World(name="default")], worker=WorkerConfig(idle_minutes=10, min_tool_uses=1))
    future = datetime.now(timezone.utc) + timedelta(minutes=20)
    ok, reason = worker.eligible(entry, cfg, future)
    assert ok is True


# --- Lock stale reclaim ------------------------------------------------------------

def test_lock_reclaims_when_recorded_pid_is_dead(tmp_path, monkeypatch):
    _prepare_env(monkeypatch, tmp_path)
    lock_path = paths.worker_lock_file()
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path.write_text("999999999", encoding="utf-8")  # a pid that cannot exist

    with worker.Lock() as lock:
        assert lock is not None
