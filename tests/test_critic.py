"""Tests for sil.critic. Never calls a real model: chat is always a fake
callable injected into reflect_session."""

from __future__ import annotations

import json

from sil import critic, store
from sil.models import Config, LlmConfig, QueueEntry, World

from test_transcript import set_sil_dirs, write_sample_transcript


def _entry(tmp_path, session_id="sess-1", world="default") -> QueueEntry:
    transcript_path = write_sample_transcript(tmp_path, session_id=session_id)
    return QueueEntry(
        session_id=session_id,
        transcript_path=transcript_path,
        cwd=tmp_path,
        world=world,
        git_head="abc123",
        first_stop="2026-09-14T10:00:00Z",
        last_stop="2026-09-14T10:05:00Z",
        stops=1,
        ended=True,
        tool_uses=3,
    )


def _good_answer(pattern="verify-callsites") -> str:
    return json.dumps(
        {
            "record": True,
            "pattern": pattern,
            "what_worked": "Ran the full test suite before editing.",
            "what_failed": "Missed one call site on the first pass.",
            "lesson": "Grep every call site before renaming a shared symbol.",
            "verification": "Ran: pytest -q -> exit 0, 12 passed",
            "not_verified": ["performance impact not measured"],
            "lesson_short": "Grep all call sites before renaming a shared symbol.",
            "confidence": 0.8,
            "artifacts_used": ["skill:debugging"],
            "artifacts_helpful": ["skill:debugging"],
            "artifacts_misfired": [],
            "rules_relevant": [],
        }
    )


# --- parse_answer ----------------------------------------------------------------

def test_parse_answer_tolerates_code_fence():
    text = "```json\n" + _good_answer() + "\n```"
    answer = critic.parse_answer(text)
    assert answer["record"] is True
    assert answer["pattern"] == "verify-callsites"


def test_parse_answer_rejects_non_slug_pattern():
    text = json.dumps({"record": True, "pattern": "Not A Slug!", "lesson": "x"})
    answer = critic.parse_answer(text)
    assert answer["record"] is False
    assert answer["pattern"] is None
    assert answer["reason"]


def test_parse_answer_rejects_non_json():
    answer = critic.parse_answer("not json at all")
    assert answer["record"] is False
    assert answer["pattern"] is None


def test_parse_answer_not_verified_never_iterates_a_non_list():
    # not_verified is a bare string, not a list: must not be split into characters.
    text = json.dumps({"record": False, "pattern": None, "not_verified": "single reason"})
    answer = critic.parse_answer(text)
    assert answer["not_verified"] == []


# --- reflect_session: recorded path -----------------------------------------------

def test_reflect_session_writes_reflection_feedback_and_lesson(tmp_path, monkeypatch):
    set_sil_dirs(monkeypatch, tmp_path)
    entry = _entry(tmp_path / "session")
    cfg = Config(worlds=[World(name="default")])
    world = cfg.worlds[0]
    llm = LlmConfig(models={"critic": "test-model"})

    def fake_chat(role, messages, *, world, cfg_llm, json_mode=False, max_tokens=4000):
        assert role == "critic"
        assert json_mode is True
        return _good_answer()

    result = critic.reflect_session(entry, cfg=cfg, world=world, llm=llm, chat=fake_chat)

    assert result["recorded"] is True
    assert result["pattern"] == "verify-callsites"
    path = __import__("pathlib").Path(result["path"])
    assert path.exists()

    text = path.read_text(encoding="utf-8")
    assert text.startswith("---\n")
    assert "\nPattern: verify-callsites\n" in text
    for heading in store.SECTIONS:
        assert heading in text

    from sil import paths

    fb_lines = [json.loads(l) for l in paths.critic_feedback_file().read_text(encoding="utf-8").splitlines()]
    verdicts = {(l["ref"], l["verdict"]) for l in fb_lines}
    assert ("skill:debugging", "used") in verdicts
    assert ("skill:debugging", "helpful") in verdicts

    lessons = store.list_lessons("default")
    assert len(lessons) == 1
    assert lessons[0].id == result["reflection_id"]
    assert lessons[0].text == "Grep all call sites before renaming a shared symbol."


def test_reflect_session_appends_misfired_feedback_with_reason(tmp_path, monkeypatch):
    set_sil_dirs(monkeypatch, tmp_path)
    entry = _entry(tmp_path / "session")
    cfg = Config(worlds=[World(name="default")])
    world = cfg.worlds[0]
    llm = LlmConfig(models={"critic": "test-model"})

    answer = json.loads(_good_answer())
    answer["artifacts_misfired"] = [{"ref": "hook:noisy-thing", "reason": "fired on an unrelated file"}]

    def fake_chat(role, messages, *, world, cfg_llm, json_mode=False, max_tokens=4000):
        return json.dumps(answer)

    critic.reflect_session(entry, cfg=cfg, world=world, llm=llm, chat=fake_chat)

    from sil import paths

    fb_lines = [json.loads(l) for l in paths.critic_feedback_file().read_text(encoding="utf-8").splitlines()]
    misfired = next(l for l in fb_lines if l["verdict"] == "misfired")
    assert misfired["ref"] == "hook:noisy-thing"
    assert misfired["reason"] == "fired on an unrelated file"


# --- reflect_session: record False path -------------------------------------------

def test_reflect_session_record_false_writes_nothing(tmp_path, monkeypatch):
    set_sil_dirs(monkeypatch, tmp_path)
    entry = _entry(tmp_path / "session")
    cfg = Config(worlds=[World(name="default")])
    world = cfg.worlds[0]
    llm = LlmConfig(models={"critic": "test-model"})

    def fake_chat(role, messages, *, world, cfg_llm, json_mode=False, max_tokens=4000):
        return json.dumps({"record": False, "pattern": None})

    result = critic.reflect_session(entry, cfg=cfg, world=world, llm=llm, chat=fake_chat)

    assert result["recorded"] is False
    assert result["reflection_id"] is None
    assert result["path"] is None

    from sil import paths

    assert not paths.reflections_dir("default").exists() or list(paths.reflections_dir("default").glob("*.md")) == []
    assert not paths.critic_feedback_file().exists()
    assert store.list_lessons("default") == []


def test_reflect_session_low_confidence_records_reflection_but_not_lesson(tmp_path, monkeypatch):
    set_sil_dirs(monkeypatch, tmp_path)
    entry = _entry(tmp_path / "session")
    cfg = Config(worlds=[World(name="default")])
    world = cfg.worlds[0]
    llm = LlmConfig(models={"critic": "test-model"})

    answer = json.loads(_good_answer())
    answer["confidence"] = 0.1

    def fake_chat(role, messages, *, world, cfg_llm, json_mode=False, max_tokens=4000):
        return json.dumps(answer)

    result = critic.reflect_session(entry, cfg=cfg, world=world, llm=llm, chat=fake_chat)

    assert result["recorded"] is True
    assert store.list_lessons("default") == []  # confidence below 0.5: no inbox lesson


# --- installed_artifacts -----------------------------------------------------------

def test_installed_artifacts_reads_promoted_ledger_entries(tmp_path, monkeypatch):
    set_sil_dirs(monkeypatch, tmp_path)
    from sil import config as config_mod
    from sil.models import ArtifactType, Ledger, PromotionEntry

    world = World(name="default")
    cfg = Config(worlds=[world])
    ledger = Ledger(
        entries={
            "good-skill": PromotionEntry(pattern="good-skill", status="promoted", artifact_type=ArtifactType.skill),
            "staged-thing": PromotionEntry(pattern="staged-thing", status="staged", artifact_type=ArtifactType.skill),
        }
    )
    store.save_ledger(config_mod.ledger_path(world), ledger)

    refs = critic.installed_artifacts(world, cfg)
    assert "skill:good-skill" in refs
    assert "skill:staged-thing" not in refs
