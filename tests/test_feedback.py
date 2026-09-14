"""Tests for sil.feedback: scorecard aggregation and the four proposals."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from sil import config as config_mod
from sil import feedback, paths
from sil.models import ArtifactType, Config, HumanFeedback, Ledger, PromotionEntry, World

from test_transcript import set_sil_dirs

NOW = datetime(2026, 9, 14, 12, 0, 0, tzinfo=timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _append_jsonl(path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(obj) + "\n")


def _build_world_and_ledger(tmp_path, monkeypatch):
    set_sil_dirs(monkeypatch, tmp_path)
    world = World(name="default")
    cfg = Config(worlds=[world])
    ledger = Ledger(
        entries={
            "new-thing": PromotionEntry(
                pattern="new-thing", status="promoted", artifact_type=ArtifactType.skill, last_updated=_iso(NOW - timedelta(days=2))
            ),
            "steady-thing": PromotionEntry(
                pattern="steady-thing", status="promoted", artifact_type=ArtifactType.skill, last_updated=_iso(NOW - timedelta(days=40))
            ),
            "flaky-thing": PromotionEntry(
                pattern="flaky-thing", status="promoted", artifact_type=ArtifactType.hook, last_updated=_iso(NOW - timedelta(days=40))
            ),
            "dead-thing": PromotionEntry(
                pattern="dead-thing", status="promoted", artifact_type=ArtifactType.agent, last_updated=_iso(NOW - timedelta(days=90))
            ),
            "staged-thing": PromotionEntry(
                pattern="staged-thing", status="staged", artifact_type=ArtifactType.skill, last_updated=_iso(NOW - timedelta(days=1))
            ),
        }
    )
    from sil import store

    store.save_ledger(config_mod.ledger_path(world), ledger)
    return world, cfg


def _seed_signals(tmp_path):
    # steady-thing: 2 uses inside the 30d window, 1 use outside it
    _append_jsonl(
        paths.usage_events_file(),
        {"ts": _iso(NOW - timedelta(days=5)), "session_id": "s1", "world": "default", "kind": "skill", "ref": "skill:steady-thing"},
    )
    _append_jsonl(
        paths.usage_events_file(),
        {"ts": _iso(NOW - timedelta(days=6)), "session_id": "s2", "world": "default", "kind": "skill", "ref": "skill:steady-thing"},
    )
    _append_jsonl(
        paths.usage_events_file(),
        {"ts": _iso(NOW - timedelta(days=40)), "session_id": "s3", "world": "default", "kind": "skill", "ref": "skill:steady-thing"},
    )
    # flaky-thing: 1 fire inside the window
    _append_jsonl(paths.nudge_fires_file(), {"ts": _iso(NOW - timedelta(days=3)), "pattern": "flaky-thing", "session": "s4", "event": "PreToolUse"})
    # flaky-thing: 2 critic misfired verdicts
    _append_jsonl(
        paths.critic_feedback_file(),
        {"ref": "hook:flaky-thing", "verdict": "misfired", "reflection_id": "r1", "ts": _iso(NOW - timedelta(days=2)), "world": "default"},
    )
    _append_jsonl(
        paths.critic_feedback_file(),
        {"ref": "hook:flaky-thing", "verdict": "misfired", "reflection_id": "r2", "ts": _iso(NOW - timedelta(days=1)), "world": "default"},
    )
    # steady-thing: 1 human good vote
    _append_jsonl(
        paths.human_feedback_file(),
        {"ts": _iso(NOW - timedelta(days=1)), "world": "default", "ref": "skill:steady-thing", "vote": "good", "note": "", "session_id": None},
    )


def test_scorecards_new_proposal_for_recently_promoted(tmp_path, monkeypatch):
    world, cfg = _build_world_and_ledger(tmp_path, monkeypatch)
    _seed_signals(tmp_path)
    cards = {c.ref: c for c in feedback.scorecards(world, cfg, now=NOW)}
    assert cards["skill:new-thing"].proposal == "new"


def test_scorecards_keep_proposal_when_used_and_not_misfiring(tmp_path, monkeypatch):
    world, cfg = _build_world_and_ledger(tmp_path, monkeypatch)
    _seed_signals(tmp_path)
    cards = {c.ref: c for c in feedback.scorecards(world, cfg, now=NOW)}
    card = cards["skill:steady-thing"]
    assert card.proposal == "keep"
    assert card.uses_30d == 2  # only the 2 events inside the window
    assert card.human_good == 1
    assert card.last_used == _iso(NOW - timedelta(days=1))  # the human vote is the most recent signal


def test_scorecards_refine_proposal_when_misfires_dominate(tmp_path, monkeypatch):
    world, cfg = _build_world_and_ledger(tmp_path, monkeypatch)
    _seed_signals(tmp_path)
    cards = {c.ref: c for c in feedback.scorecards(world, cfg, now=NOW)}
    card = cards["hook:flaky-thing"]
    assert card.proposal == "refine"
    assert card.fires_30d == 1
    assert card.misfired == 2


def test_scorecards_retire_candidate_when_never_used(tmp_path, monkeypatch):
    world, cfg = _build_world_and_ledger(tmp_path, monkeypatch)
    _seed_signals(tmp_path)
    cards = {c.ref: c for c in feedback.scorecards(world, cfg, now=NOW)}
    card = cards["agent:dead-thing"]
    assert card.proposal == "retire-candidate"
    assert card.uses_30d == 0
    assert card.fires_30d == 0
    assert card.last_used is None


def test_scorecards_excludes_non_promoted_ledger_entries_with_no_events(tmp_path, monkeypatch):
    world, cfg = _build_world_and_ledger(tmp_path, monkeypatch)
    _seed_signals(tmp_path)
    cards = {c.ref: c for c in feedback.scorecards(world, cfg, now=NOW)}
    assert "skill:staged-thing" not in cards


def test_rebuild_and_load_roundtrip(tmp_path, monkeypatch):
    world, cfg = _build_world_and_ledger(tmp_path, monkeypatch)
    _seed_signals(tmp_path)
    feedback.rebuild(world, cfg)
    loaded = {c.ref: c for c in feedback.load(world)}
    assert "agent:dead-thing" in loaded
    assert loaded["agent:dead-thing"].proposal == "retire-candidate"


def test_record_human_appends_jsonl(tmp_path, monkeypatch):
    set_sil_dirs(monkeypatch, tmp_path)
    fb = HumanFeedback(world="default", ref="skill:steady-thing", vote="bad", note="did not help")
    path = feedback.record_human(fb)
    lines = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines()]
    assert len(lines) == 1
    assert lines[0]["ref"] == "skill:steady-thing"
    assert lines[0]["vote"] == "bad"
