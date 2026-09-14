"""Artifact lint: the cheap deterministic gate before the model judge."""

from __future__ import annotations

import pytest

from sil import lint
from tests.curriculum_fixtures import install_fake_nudge

SOURCES = (
    "Run `rg` over every call site of the changed symbol and read the graphify "
    "inventory before calling the change safe. The promotions ledger records only "
    "a watermark."
)

GOOD_SKILL = (
    "---\nname: verify-callsites\n"
    "description: Use when a change touches a shared symbol and you are about to "
    "call it safe.\n---\n\n"
    "## Enumerate every call site\n\n"
    "Run `rg` over the changed symbol and read the graphify inventory before "
    "calling the change safe; the promotions ledger will not tell you.\n"
)


def test_a_well_formed_skill_is_clean():
    assert lint.lint("skill", GOOD_SKILL, "verify-callsites", SOURCES) == []


def test_frontmatter_must_exist():
    problems = lint.lint_skill("## No frontmatter here\n" + "x" * 200, "verify-callsites")
    assert problems == ["missing or malformed frontmatter (--- ... --- at top of file)"]


def test_the_frontmatter_name_must_equal_the_pattern():
    text = GOOD_SKILL.replace("name: verify-callsites", "name: something-else")
    problems = lint.lint_skill(text, "verify-callsites")
    assert any("must equal the pattern" in p for p in problems), problems


def test_a_description_that_is_not_a_trigger_is_refused():
    text = GOOD_SKILL.replace(
        "description: Use when a change touches a shared symbol and you are about "
        "to call it safe.", "description: Some notes about call sites.")
    problems = lint.lint_skill(text, "verify-callsites")
    assert any("must read as a trigger" in p for p in problems), problems


def test_the_description_cap_bounds_an_unbounded_refine():
    # The failure this exists for: one V1 description grew one appended trigger
    # per refine cycle until it was a single ~300-word sentence, which fires less
    # often rather than more.
    long_desc = "Use when " + ", or when ".join(["the thing happens"] * 60)
    assert len(long_desc) > lint.MAX_DESCRIPTION
    problems = lint.lint_description_cap(long_desc)
    assert any(str(lint.MAX_DESCRIPTION) in p for p in problems), problems


def test_the_description_cap_counts_sentences_but_not_abbreviations():
    assert lint.lint_description_cap(
        "Use when a call site changes, e.g. a shared enum. Check every consumer.") == []
    problems = lint.lint_description_cap("Use when A. Then B. Then C. Then D.")
    assert any("sentences" in p for p in problems), problems


def test_an_unreplaced_template_placeholder_is_refused():
    text = GOOD_SKILL.replace(
        "description: Use when a change touches a shared symbol and you are about "
        "to call it safe.",
        "description: Use when <the situation that should trigger this skill>")
    problems = lint.lint_skill(text, "verify-callsites")
    assert any("unreplaced template placeholder" in p for p in problems), problems


def test_a_code_like_angle_bracket_is_not_a_placeholder():
    text = GOOD_SKILL.rstrip() + "\n\nRun `git log -- <file>` and read Vec<String>.\n"
    assert not any("placeholder" in p for p in lint.lint_skill(text, "verify-callsites"))


def test_echoed_drafting_scaffolding_is_refused():
    text = GOOD_SKILL.rstrip() + "\n\nLessons to generalise:\n\nsomething\n"
    problems = lint.lint_skill(text, "verify-callsites")
    assert any("scaffolding echoed" in p for p in problems), problems


def test_a_secret_is_never_promoted():
    text = GOOD_SKILL.rstrip() + "\n\napi_key: AKIAIOSFODNN7EXAMPLE\n"
    problems = lint.lint_skill(text, "verify-callsites")
    assert any("secret" in p for p in problems), problems


def test_grounding_rejects_a_vacuous_body():
    # The one failure class the model judge does not catch: measured, it credited
    # the SOURCES' specificity to the artifact.
    vacuous = (
        "---\nname: verify-callsites\n"
        "description: Use when you are about to be careless.\n---\n\n"
        "## Be careful\n\nAlways be careful and verify things properly before you "
        "claim anything. Think about whether your result could be wrong.\n"
    )
    problems = lint.lint("skill", vacuous, "verify-callsites", SOURCES)
    assert any("not grounded in its sources" in p for p in problems), problems


def test_grounding_accepts_a_body_that_reuses_its_sources_vocabulary():
    assert lint.lint_grounding(GOOD_SKILL, SOURCES) == []


def test_a_rule_is_exactly_one_bullet_under_the_cap():
    assert lint.lint_rule("- Run `rg` over every call site before calling it safe.") == []
    assert lint.lint_rule("Run rg.")[0].startswith("a rule must start")
    two = "- first bullet\n- second bullet"
    assert "2 line(s)" in lint.lint_rule(two)[0]
    over = "- " + "x" * lint.MAX_RULE_CHARS
    assert any(str(lint.MAX_RULE_CHARS) in p for p in lint.lint_rule(over))


def test_hook_lint_is_delegated_to_the_nudge_dispatcher(monkeypatch):
    seen = {}

    def fake_lint(obj):
        seen["obj"] = obj
        return ["gate fires unconditionally"]

    install_fake_nudge(monkeypatch, lint_nudge=fake_lint)
    payload = {"pattern": "p", "event": "PreToolUse", "gate": {"always": True},
               "once_per": "session", "text": "rg the graphify promotions inventory"}
    problems = lint.lint("hook", payload, "p", SOURCES)
    assert seen["obj"] is payload
    assert "gate fires unconditionally" in problems


def test_a_hook_payload_that_is_not_an_object_is_refused(monkeypatch):
    install_fake_nudge(monkeypatch)
    assert lint.lint("hook", "not json", "p", SOURCES) == ["hook artifact must be a JSON object"]


@pytest.mark.parametrize("artifact_type", ["skill", "agent", "rule"])
def test_a_dict_forced_onto_a_text_type_is_refused_not_crashed(artifact_type):
    # Reachable at runtime: a served_by suppression forces the ledger's type onto
    # whatever the drafter returned, so a hook body can meet a skill's lint path.
    problems = lint.lint(artifact_type, {"gate": {"always": True}}, "p", SOURCES)
    assert problems == [f"{artifact_type} artifact must be text, not dict"]


def test_type_none_is_always_clean():
    assert lint.lint("none", "", "p", SOURCES) == []


def test_an_unknown_type_is_named_rather_than_passed():
    assert lint.lint("widget", "x", "p", SOURCES) == ["unknown artifact type 'widget'"]
