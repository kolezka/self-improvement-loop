"""Tests for sil/usage.py: usage event log helpers."""

from __future__ import annotations

import json

from sil import paths, usage


def test_append_event_writes_json_line(tmp_path):
    p = tmp_path / "events.jsonl"
    usage.append_event(p, {"ts": "t1", "kind": "skill", "ref": "skill:foo"})
    usage.append_event(p, {"ts": "t2", "kind": "agent", "ref": "agent:bar"})
    lines = p.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    assert json.loads(lines[0])["ref"] == "skill:foo"
    assert json.loads(lines[1])["ref"] == "agent:bar"


def test_append_event_creates_parent_dirs(tmp_path):
    p = tmp_path / "nested" / "dir" / "events.jsonl"
    usage.append_event(p, {"ts": "t1"})
    assert p.is_file()


def test_append_event_never_raises_and_logs_failure(tmp_path, monkeypatch):
    monkeypatch.setenv("SIL_STATE_DIR", str(tmp_path / "state"))
    # A path whose parent is a FILE cannot be mkdir'd into: forces a failure.
    blocker = tmp_path / "blocker"
    blocker.write_text("x")
    bad_path = blocker / "events.jsonl"

    usage.append_event(bad_path, {"ts": "t1"})  # must not raise

    log = paths.log_file("hook")
    assert log.is_file()
    assert "append_event failed" in log.read_text(encoding="utf-8")


def test_read_events_tolerant_of_bad_lines(tmp_path):
    p = tmp_path / "events.jsonl"
    p.write_text(
        '{"ts": "1", "ok": true}\n'
        "not json\n"
        "\n"
        "[1,2,3]\n"
        '{"ts": "2"}\n',
        encoding="utf-8",
    )
    events = usage.read_events(p)
    assert len(events) == 2
    assert events[0]["ts"] == "1"
    assert events[1]["ts"] == "2"


def test_read_events_missing_file_returns_empty(tmp_path):
    assert usage.read_events(tmp_path / "nope.jsonl") == []


def test_read_events_since_ts_filters(tmp_path):
    p = tmp_path / "events.jsonl"
    ts_values = ["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z"]
    p.write_text("\n".join(json.dumps({"ts": ts}) for ts in ts_values) + "\n", encoding="utf-8")
    events = usage.read_events(p, since_ts="2026-01-01T00:00:00Z")
    assert [e["ts"] for e in events] == ["2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z"]


def test_artifact_ref_format():
    assert usage.artifact_ref("skill", "verify-callsites") == "skill:verify-callsites"
    assert usage.artifact_ref("hook", "PreToolUse:Bash") == "hook:PreToolUse:Bash"
