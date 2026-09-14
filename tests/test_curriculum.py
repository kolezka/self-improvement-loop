"""Clustering, watermark arithmetic and the feedback-aware plan."""

from __future__ import annotations

import json
import re

import pytest

from sil import config, curriculum, paths, store
from sil.models import (
    ArtifactRef, ArtifactType, Ledger, Lesson, PromotionEntry, Scorecard,
)
from tests.curriculum_fixtures import (
    add_reflections, install_fake_feedback, make_cfg, make_world, sil_env,
)

PATTERN = "verify-callsites"


def _actions(report):
    return {a.pattern: a for a in report.actions}


def _write_ledger(world, **entries):
    ledger = Ledger()
    for pattern, entry in entries.items():
        ledger.entries[pattern] = entry
    path = config.ledger_path(world)
    path.parent.mkdir(parents=True, exist_ok=True)
    store.save_ledger(path, ledger)
    return path


@pytest.fixture
def world(tmp_path, monkeypatch):
    sil_env(tmp_path, monkeypatch)
    return make_world()


# --- clustering and aliases ---------------------------------------------------

def test_reflections_are_clustered_by_pattern(world):
    add_reflections(world, PATTERN, 3)
    add_reflections(world, "other-pattern", 1)
    groups = curriculum.cluster(curriculum.reflections(world))
    assert sorted(groups) == ["other-pattern", PATTERN]
    assert len(groups[PATTERN]) == 3
    # Oldest first, because the drafter's window is filled from the newest end.
    assert [r.created for r in groups[PATTERN]] == sorted(r.created for r in groups[PATTERN])


def test_aliases_are_resolved_after_the_world_filter(world):
    add_reflections(world, PATTERN, 2)
    add_reflections(world, "verify-call-sites", 1, start_day=20)
    store.save_aliases(world.name, {"verify-call-sites": PATTERN})
    groups = curriculum.cluster(curriculum.reflections(world))
    assert sorted(groups) == [PATTERN]
    assert len(groups[PATTERN]) == 3


# --- the watermark ------------------------------------------------------------

def test_a_fresh_pattern_promotes_at_the_threshold(world):
    add_reflections(world, PATTERN, 3)
    action = _actions(curriculum.plan(world, make_cfg(threshold=3)))[PATTERN]
    assert action.action == "promote"
    assert action.count == 3 and action.watermark == 0
    assert action.sources == sorted(action.sources)


def test_below_the_threshold_is_reported_not_dropped_silently(world):
    add_reflections(world, PATTERN, 2)
    action = _actions(curriculum.plan(world, make_cfg(threshold=3)))[PATTERN]
    assert action.action == "below-threshold"
    assert action.count == 2


def test_the_threshold_comes_from_config_not_a_constant(world):
    add_reflections(world, PATTERN, 2)
    assert _actions(curriculum.plan(world, make_cfg(threshold=3)))[PATTERN].action == \
        "below-threshold"
    assert _actions(curriculum.plan(world, make_cfg(threshold=2)))[PATTERN].action == \
        "promote"


def test_a_promoted_pattern_waits_for_threshold_new_reflections(world):
    add_reflections(world, PATTERN, 5)
    _write_ledger(world, **{PATTERN: PromotionEntry(
        pattern=PATTERN, promoted_at_count=4, status="promoted",
        artifact_type=ArtifactType.skill)})
    assert _actions(curriculum.plan(world, make_cfg(threshold=3)))[PATTERN].action == "done"

    add_reflections(world, PATTERN, 2, start_day=20)
    action = _actions(curriculum.plan(world, make_cfg(threshold=3)))[PATTERN]
    assert action.action == "promote"
    assert (action.count, action.watermark) == (7, 4)


def test_a_rejection_costs_the_same_watermark_as_a_promotion(world):
    # The V1 treadmill: rejecting moved no watermark at all, so three artifacts
    # refused at 13:00 were re-staged byte-identical by 15:05.
    add_reflections(world, PATTERN, 5)
    _write_ledger(world, **{PATTERN: PromotionEntry(
        pattern=PATTERN, promoted_at_count=0, rejected_at_count=5,
        status="rejected", artifact_type=ArtifactType.skill)})
    assert _actions(curriculum.plan(world, make_cfg(threshold=3)))[PATTERN].action == "done"

    add_reflections(world, PATTERN, 2, start_day=20)
    assert _actions(curriculum.plan(world, make_cfg(threshold=3)))[PATTERN].action == "done"

    add_reflections(world, PATTERN, 1, start_day=30)
    action = _actions(curriculum.plan(world, make_cfg(threshold=3)))[PATTERN]
    assert action.action == "promote"
    assert (action.count, action.watermark) == (8, 5)


def test_the_higher_of_the_two_watermarks_wins(world):
    add_reflections(world, PATTERN, 9)
    _write_ledger(world, **{PATTERN: PromotionEntry(
        pattern=PATTERN, promoted_at_count=3, rejected_at_count=7,
        status="rejected", artifact_type=ArtifactType.skill)})
    action = _actions(curriculum.plan(world, make_cfg(threshold=3)))[PATTERN]
    assert action.watermark == 7
    assert action.action == "done"


# --- the per-run cap ----------------------------------------------------------

def test_the_cap_is_spent_in_sorted_order_and_the_rest_is_reported(world):
    for name in ("aaa-pattern", "bbb-pattern", "ccc-pattern"):
        add_reflections(world, name, 3)
    actions = _actions(curriculum.plan(world, make_cfg(threshold=3, per_run_cap=2)))
    assert actions["aaa-pattern"].action == "promote"
    assert actions["bbb-pattern"].action == "promote"
    assert actions["ccc-pattern"].action == "over-cap"
    assert "cap of 2" in actions["ccc-pattern"].reason


def test_a_below_threshold_pattern_never_spends_cap(world):
    add_reflections(world, "aaa-pattern", 1)
    add_reflections(world, "bbb-pattern", 3)
    actions = _actions(curriculum.plan(world, make_cfg(threshold=3, per_run_cap=1)))
    assert actions["aaa-pattern"].action == "below-threshold"
    assert actions["bbb-pattern"].action == "promote"


# --- scorecards ---------------------------------------------------------------

def _scorecard_file(tmp_path, rows):
    path = tmp_path / "scorecards.json"
    path.write_text(json.dumps([r.model_dump(mode="json") for r in rows]),
                    encoding="utf-8")
    return path


def test_a_misfiring_promoted_artifact_comes_back_as_refine(world, tmp_path, monkeypatch):
    add_reflections(world, PATTERN, 4)
    _write_ledger(world, **{PATTERN: PromotionEntry(
        pattern=PATTERN, promoted_at_count=4, status="promoted",
        artifact_type=ArtifactType.skill,
        served_by=ArtifactRef(type=ArtifactType.skill, path=f"skills/{PATTERN}/SKILL.md"))})
    card = Scorecard(ref=f"skill:{PATTERN}", type="skill", name=PATTERN,
                     helpful=1, misfired=4, proposal="refine",
                     reason="4 misfires against 1 helpful vote in 30 days")
    install_fake_feedback(monkeypatch, _scorecard_file(tmp_path, [card]))

    action = _actions(curriculum.plan(world, make_cfg(threshold=3)))[PATTERN]
    assert action.action == "refine"
    assert "misfires" in action.reason


def test_an_unused_promoted_artifact_comes_back_as_a_retire_candidate(
        world, tmp_path, monkeypatch):
    add_reflections(world, PATTERN, 4)
    _write_ledger(world, **{PATTERN: PromotionEntry(
        pattern=PATTERN, promoted_at_count=4, status="promoted",
        artifact_type=ArtifactType.skill)})
    card = Scorecard(ref=f"skill:{PATTERN}", type="skill", name=PATTERN,
                     uses_30d=0, proposal="retire-candidate",
                     reason="no use in 45 days")
    install_fake_feedback(monkeypatch, _scorecard_file(tmp_path, [card]))

    action = _actions(curriculum.plan(world, make_cfg(threshold=3)))[PATTERN]
    assert action.action == "retire-candidate"
    assert "45 days" in action.reason


def test_a_retire_candidate_never_spends_cap(world, tmp_path, monkeypatch):
    add_reflections(world, "aaa-pattern", 4)
    add_reflections(world, "bbb-pattern", 3)
    _write_ledger(world, **{"aaa-pattern": PromotionEntry(
        pattern="aaa-pattern", promoted_at_count=4, status="promoted",
        artifact_type=ArtifactType.skill)})
    card = Scorecard(ref="skill:aaa-pattern", type="skill", name="aaa-pattern",
                     proposal="retire-candidate")
    install_fake_feedback(monkeypatch, _scorecard_file(tmp_path, [card]))

    actions = _actions(curriculum.plan(world, make_cfg(threshold=3, per_run_cap=1)))
    assert actions["aaa-pattern"].action == "retire-candidate"
    assert actions["bbb-pattern"].action == "promote"


def test_a_keep_scorecard_leaves_a_settled_pattern_done(world, tmp_path, monkeypatch):
    add_reflections(world, PATTERN, 4)
    _write_ledger(world, **{PATTERN: PromotionEntry(
        pattern=PATTERN, promoted_at_count=4, status="promoted",
        artifact_type=ArtifactType.skill)})
    card = Scorecard(ref=f"skill:{PATTERN}", type="skill", name=PATTERN, proposal="keep")
    install_fake_feedback(monkeypatch, _scorecard_file(tmp_path, [card]))
    assert _actions(curriculum.plan(world, make_cfg(threshold=3)))[PATTERN].action == "done"


def test_a_missing_feedback_module_yields_no_proposals(world):
    add_reflections(world, PATTERN, 4)
    _write_ledger(world, **{PATTERN: PromotionEntry(
        pattern=PATTERN, promoted_at_count=4, status="promoted",
        artifact_type=ArtifactType.skill)})
    assert curriculum.scorecards(world) == []
    assert _actions(curriculum.plan(world, make_cfg(threshold=3)))[PATTERN].action == "done"


# --- payload corpus -----------------------------------------------------------

def test_the_plugins_own_corpus_is_always_available(world):
    payloads = curriculum.load_payload_corpus(world)
    assert len(payloads) >= 20
    assert all(isinstance(p, dict) for p in payloads)


def test_a_targets_own_payloads_add_to_the_corpus(world, tmp_path, monkeypatch):
    target = config.target_root(world)
    extra = target / "tests" / "fixtures" / "hook-payloads"
    extra.mkdir(parents=True)
    (extra / "custom.json").write_text(json.dumps({"hook_event_name": "Custom"}))
    payloads = curriculum.load_payload_corpus(world)
    assert {"hook_event_name": "Custom"} in payloads


def test_an_unreadable_payload_names_the_file(world):
    target = config.target_root(world)
    extra = target / "tests" / "fixtures" / "hook-payloads"
    extra.mkdir(parents=True)
    (extra / "broken.json").write_text("{ not json")
    with pytest.raises(ValueError, match="broken.json"):
        curriculum.load_payload_corpus(world)


# --- ledger round trip --------------------------------------------------------

def test_a_ledger_read_from_a_blob_matches_one_read_from_disk(world):
    entry = PromotionEntry(pattern=PATTERN, promoted_at_count=3, status="staged",
                           artifact_type=ArtifactType.hook)
    path = _write_ledger(world, **{PATTERN: entry})
    from_blob = curriculum.parse_ledger(path.read_text())
    assert from_blob.entries[PATTERN].promoted_at_count == 3
    assert from_blob.entries[PATTERN].artifact_type == ArtifactType.hook
    assert curriculum.parse_ledger("{}").entries == {}


def test_a_corrupt_ledger_names_the_file_it_could_not_read(world):
    # Four call sites read four different ledger paths. A raw JSONDecodeError
    # names a line and a column and no file, so the operator is told a ledger is
    # broken without being told which one.
    path = config.ledger_path(world)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{ not json at all", encoding="utf-8")

    for call in (lambda: store.load_ledger(path), lambda: curriculum.load_ledger(world)):
        with pytest.raises(ValueError, match=re.escape(str(path))) as excinfo:
            call()
        assert "unreadable ledger" in str(excinfo.value)


def test_a_ledger_that_parses_but_does_not_validate_also_names_the_file(world):
    path = config.ledger_path(world)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('{"version": 1, "entries": {"p": {"pattern": 5}}}', encoding="utf-8")
    with pytest.raises(ValueError, match="unreadable ledger"):
        store.load_ledger(path)


# --- the lesson inbox ---------------------------------------------------------

def test_list_lessons_skips_a_bad_file_but_never_a_bug(world, monkeypatch):
    # Skipping an unreadable inbox file is the point; swallowing every exception
    # means a bug in this loop reads as an empty inbox and nobody ever hears
    # about it.
    store.put_lesson(Lesson(id="good", world=world.name, pattern=PATTERN,
                            text="run rg over every call site"))
    (paths.inbox_dir(world.name) / "broken.json").write_text("{ not json")

    assert [lesson.id for lesson in store.list_lessons(world.name)] == ["good"]

    def boom(*args, **kwargs):
        raise RuntimeError("a bug in the loop, not a bad file")

    monkeypatch.setattr(store.Lesson, "model_validate_json", boom)
    with pytest.raises(RuntimeError):
        store.list_lessons(world.name)
