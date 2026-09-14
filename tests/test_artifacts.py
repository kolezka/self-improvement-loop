"""Artifact paths and writers, and the managed rules block."""

from __future__ import annotations

import json

import pytest

from sil import artifacts, config, paths
from sil.consts import RULE_END, RULE_START, RULE_TAG
from tests.curriculum_fixtures import V1_LAYOUT, make_world, sil_env

PATTERN = "verify-callsites"


def test_default_layout_paths():
    world = make_world()
    assert artifacts.artifact_rel(world, "skill", PATTERN) == f"skills/{PATTERN}/SKILL.md"
    assert artifacts.artifact_rel(world, "hook", PATTERN) == f"nudges/{PATTERN}.json"
    assert artifacts.artifact_rel(world, "agent", PATTERN) == f"agents/{PATTERN}.md"
    assert artifacts.artifact_rel(world, "rule", PATTERN) == "RULES.md"
    assert artifacts.artifact_rel(world, "none", PATTERN) == ""


def test_the_v1_dotfiles_layout_keeps_its_on_disk_contract():
    world = make_world(layout=V1_LAYOUT)
    assert artifacts.artifact_rel(world, "skill", PATTERN) == f"claude/skills/{PATTERN}/SKILL.md"
    assert artifacts.artifact_rel(world, "hook", PATTERN) == f"claude/hooks/nudges/{PATTERN}.json"
    assert artifacts.artifact_rel(world, "agent", PATTERN) == f"claude/agents/{PATTERN}.md"
    assert artifacts.artifact_rel(world, "rule", PATTERN) == "global.CLAUDE.md"
    assert config.ledger_path(world).name == "promotions.json"
    assert world.layout.ledger == "claude/skills/promotions.json"


@pytest.mark.parametrize("bad", ["../escape", "a/b", "Upper", "", "with space", "."])
def test_an_unsafe_slug_is_refused_at_the_one_choke_point(bad):
    world = make_world()
    for artifact_type in ("skill", "hook", "agent", "rule", "none"):
        with pytest.raises(ValueError):
            artifacts.artifact_rel(world, artifact_type, bad)


def test_writers_land_at_the_declared_paths(tmp_path, monkeypatch):
    sil_env(tmp_path, monkeypatch)
    for world in (make_world(), make_world(layout=V1_LAYOUT)):
        root = tmp_path / f"target-{world.layout.skills_dir.replace('/', '-')}"
        artifacts.write_artifact(world, "skill", PATTERN, "SKILL\n", root=root)
        artifacts.write_artifact(world, "agent", PATTERN, "AGENT\n", root=root)
        artifacts.write_artifact(world, "hook", PATTERN, {"pattern": PATTERN}, root=root)
        for artifact_type, expected in (("skill", "SKILL\n"), ("agent", "AGENT\n")):
            rel = artifacts.artifact_rel(world, artifact_type, PATTERN)
            assert (root / rel).read_text() == expected
        hook_rel = artifacts.artifact_rel(world, "hook", PATTERN)
        assert json.loads((root / hook_rel).read_text()) == {"pattern": PATTERN}


def test_writing_type_none_writes_nothing(tmp_path, monkeypatch):
    sil_env(tmp_path, monkeypatch)
    root = tmp_path / "target"
    assert artifacts.write_artifact(make_world(), "none", PATTERN, "x", root=root) is None
    assert not root.exists()


# --- the managed rules block -------------------------------------------------

def _rules(root, body: str):
    path = root / "RULES.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    return path


MARKED = f"# Boot contract\n\nHand written.\n\n{RULE_START}\n{RULE_END}\n\n## Tail\n"


def test_a_rule_write_refuses_a_file_with_no_marker_pair(tmp_path, monkeypatch):
    sil_env(tmp_path, monkeypatch)
    root = tmp_path / "target"
    _rules(root, "# Boot contract\n\nHand written, never volunteered.\n")
    with pytest.raises(ValueError, match="no .* marker pair"):
        artifacts.write_artifact(make_world(), "rule", PATTERN, "- do the thing", root=root)


def test_a_rule_write_refuses_a_missing_file(tmp_path, monkeypatch):
    sil_env(tmp_path, monkeypatch)
    root = tmp_path / "target"
    root.mkdir()
    with pytest.raises(ValueError, match="no .* marker pair"):
        artifacts.write_artifact(make_world(), "rule", PATTERN, "- do the thing", root=root)


def test_a_rule_write_refuses_duplicated_markers(tmp_path, monkeypatch):
    sil_env(tmp_path, monkeypatch)
    root = tmp_path / "target"
    _rules(root, f"{RULE_START}\n{RULE_END}\n\nExample:\n\n{RULE_START}\n{RULE_END}\n")
    with pytest.raises(ValueError, match="ambiguous"):
        artifacts.write_artifact(make_world(), "rule", PATTERN, "- do the thing", root=root)


def test_a_rule_write_refuses_markers_out_of_order(tmp_path, monkeypatch):
    sil_env(tmp_path, monkeypatch)
    root = tmp_path / "target"
    _rules(root, f"{RULE_END}\nsome content\n{RULE_START}\n")
    with pytest.raises(ValueError, match="malformed marker order"):
        artifacts.write_artifact(make_world(), "rule", PATTERN, "- do the thing", root=root)


def test_a_rule_replaces_by_tag_in_place_and_never_duplicates(tmp_path, monkeypatch):
    sil_env(tmp_path, monkeypatch)
    world, root = make_world(), tmp_path / "target"
    path = _rules(root, MARKED)
    artifacts.write_artifact(world, "rule", PATTERN, "- first wording", root=root)
    artifacts.write_artifact(world, "rule", PATTERN, "- second wording", root=root)
    text = path.read_text()
    tag = RULE_TAG.format(pattern=PATTERN)
    assert text.count(tag) == 1, text
    assert "- second wording" in text and "- first wording" not in text
    # Everything outside the markers is byte-identical.
    assert text.startswith("# Boot contract\n\nHand written.\n\n")
    assert text.endswith("\n\n## Tail\n")


def test_a_rule_write_leaves_other_patterns_bullets_alone(tmp_path, monkeypatch):
    sil_env(tmp_path, monkeypatch)
    world, root = make_world(), tmp_path / "target"
    path = _rules(root, MARKED)
    other = f"- somebody else's rule {RULE_TAG.format(pattern='other-pattern')}"
    untagged = "- a hand-written bullet with no tag"
    path.write_text(path.read_text().replace(
        f"{RULE_START}\n", f"{RULE_START}\n{other}\n{untagged}\n"), encoding="utf-8")

    artifacts.write_artifact(world, "rule", PATTERN, "- mine", root=root)
    text = path.read_text()
    assert other in text and untagged in text
    assert f"- mine {RULE_TAG.format(pattern=PATTERN)}" in text


def test_remove_drops_only_this_patterns_bullet_and_never_the_file(tmp_path, monkeypatch):
    sil_env(tmp_path, monkeypatch)
    world, root = make_world(), tmp_path / "target"
    path = _rules(root, MARKED)
    artifacts.write_artifact(world, "rule", "other-pattern", "- theirs", root=root)
    artifacts.write_artifact(world, "rule", PATTERN, "- mine", root=root)

    rel = artifacts.remove_artifact(world, "rule", PATTERN, root=root)
    assert rel == "RULES.md"
    text = path.read_text()
    assert path.exists()
    assert RULE_TAG.format(pattern=PATTERN) not in text
    assert "- theirs" in text
    # Removing something that is not there is a no-op, not an error.
    assert artifacts.remove_artifact(world, "rule", PATTERN, root=root) == ""


def test_reading_a_rule_returns_only_this_patterns_bullet(tmp_path, monkeypatch):
    sil_env(tmp_path, monkeypatch)
    world, root = make_world(), tmp_path / "target"
    _rules(root, MARKED)
    artifacts.write_artifact(world, "rule", "other-pattern", "- theirs", root=root)
    artifacts.write_artifact(world, "rule", PATTERN, "- mine", root=root)
    body = artifacts.read_artifact(world, "rule", PATTERN, root=root)
    assert body.startswith("- mine")
    assert "theirs" not in body


def test_removing_a_skill_drops_its_file_and_empty_directory(tmp_path, monkeypatch):
    sil_env(tmp_path, monkeypatch)
    world, root = make_world(), tmp_path / "target"
    artifacts.write_artifact(world, "skill", PATTERN, "SKILL\n", root=root)
    assert artifacts.remove_artifact(world, "skill", PATTERN, root=root) == \
        f"skills/{PATTERN}/SKILL.md"
    assert not (root / "skills" / PATTERN).exists()


# --- rules-file ownership ----------------------------------------------------

def test_the_builtin_learned_repo_gets_its_marker_pair(tmp_path, monkeypatch):
    sil_env(tmp_path, monkeypatch)
    world = make_world()
    assert artifacts.owns_rules_file(world)
    path = artifacts.ensure_rules_file(world)
    assert path == paths.default_target(world.name) / "RULES.md"
    assert RULE_START in path.read_text() and RULE_END in path.read_text()
    assert artifacts.rules_problem(world) is None


def test_a_custom_target_never_gets_a_rules_file_created(tmp_path, monkeypatch):
    sil_env(tmp_path, monkeypatch)
    target = tmp_path / "someone-elses-repo"
    target.mkdir()
    world = make_world(target=target)
    assert artifacts.owns_rules_file(world) is False
    assert artifacts.ensure_rules_file(world) is None
    assert list(target.iterdir()) == []


def test_ensure_rules_file_can_write_into_a_scratch_tree(tmp_path, monkeypatch):
    sil_env(tmp_path, monkeypatch)
    world = make_world()
    tree = tmp_path / "scratch"
    tree.mkdir()
    path = artifacts.ensure_rules_file(world, root=tree)
    assert path == tree / "RULES.md"
    assert not (paths.default_target(world.name) / "RULES.md").exists()


# --- placeholders ------------------------------------------------------------

@pytest.mark.parametrize("artifact_type", ["skill", "agent", "rule", "hook"])
def test_a_rehome_stub_is_recognised_as_a_placeholder(artifact_type):
    body = artifacts.placeholder_body(PATTERN, artifact_type, "skill")
    text = json.dumps(body) if isinstance(body, dict) else body
    assert artifacts.is_placeholder_body(artifact_type, text)


def test_a_real_artifact_that_merely_mentions_todo_is_not_a_placeholder():
    skill = ("---\nname: p\ndescription: Use when a TODO is left in the tree.\n---\n"
             "\n## TODO\n\nResolve the TODO before shipping.\n")
    assert not artifacts.is_placeholder_body("skill", skill)
    assert not artifacts.is_placeholder_body("rule", "- TODO: chase the owner")
    assert not artifacts.is_placeholder_body("hook", json.dumps(
        {"event": "PreToolUse", "gate": {"always": True}, "once_per": "session",
         "text": "a real always-fire hook"}))
    assert not artifacts.is_placeholder_body("skill", "")


def test_allowed_paths_cover_every_type_so_a_migration_is_acceptable():
    world = make_world()
    allowed = artifacts.allowed_paths(world, PATTERN)
    assert allowed == {
        f"skills/{PATTERN}/SKILL.md", f"nudges/{PATTERN}.json",
        f"agents/{PATTERN}.md", "RULES.md", "promotions.json",
    }
