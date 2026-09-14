"""The curriculum run: gates, staging, and what it is not allowed to touch."""

from __future__ import annotations

import json

import pytest

from sil import artifacts, config, curriculum, gitutil, paths, prompts, router, run, store
from sil.consts import RULE_END
from sil.models import ArtifactRef, ArtifactType, Ledger, PromotionEntry
from tests.curriculum_fixtures import (
    FakeChat, add_reflections, commit_file, hook_draft, init_target,
    install_fake_nudge, make_cfg, make_world, rule_body, sil_env, skill_body,
    skill_draft,
)

PATTERN = "verify-callsites"
QUOTE = "run `rg` over every call site of the changed symbol"


@pytest.fixture
def env(tmp_path, monkeypatch):
    sil_env(tmp_path, monkeypatch)
    install_fake_nudge(monkeypatch)
    return tmp_path


def _world_with(pattern=PATTERN, count=3, **kwargs):
    world = make_world(**kwargs)
    add_reflections(world, pattern, count)
    return world


def _branch(world, pattern=PATTERN):
    return run.branch_name(world.name, pattern)


def _write_ledger(world, **entries):
    ledger = Ledger()
    ledger.entries.update(entries)
    path = config.ledger_path(world)
    path.parent.mkdir(parents=True, exist_ok=True)
    store.save_ledger(path, ledger)
    return path


# --- dry run ------------------------------------------------------------------

def test_a_dry_run_mutates_nothing_and_calls_no_provider(env):
    world = _world_with()
    add_reflections(world, "thin-pattern", 1, start_day=20)
    chat = FakeChat(draft=skill_draft(PATTERN, QUOTE))

    report = run.run(world, make_cfg(), apply=False, chat=chat)

    assert report.dry_run is True
    assert report.staged == [PATTERN]
    assert report.dropped == {"thin-pattern": 1}
    assert chat.calls == []
    # Not even the built-in target repo is created.
    assert not config.target_root(world).exists()


# --- the happy path -----------------------------------------------------------

def test_apply_stages_one_commit_carrying_the_artifact_and_only_its_own_ledger_row(env):
    world = _world_with()
    repo = init_target(world)
    chat = FakeChat(draft=skill_draft(PATTERN, QUOTE))

    report = run.run(world, make_cfg(), apply=True, chat=chat)

    assert report.staged == [PATTERN], report.gated_out
    assert report.merged == []
    branch = _branch(world)
    commits = gitutil.git(repo, "log", "--format=%H", f"main..{branch}").splitlines()
    assert len(commits) == 1, commits
    touched = gitutil.commit_paths(repo, "main", branch)
    assert touched == [f"promotions.json", f"skills/{PATTERN}/SKILL.md"]

    found, raw = gitutil.show(repo, branch, "promotions.json")
    assert found
    ledger = curriculum.parse_ledger(raw)
    assert list(ledger.entries) == [PATTERN]
    entry = ledger.entries[PATTERN]
    assert entry.status == "staged"
    assert entry.promoted_at_count == 3
    assert entry.artifact_type == ArtifactType.skill
    assert entry.served_by.path == f"skills/{PATTERN}/SKILL.md"


def test_each_staged_branch_carries_only_its_own_ledger_row(env):
    # Branches are reviewed independently, so one may never claim another's
    # promotion. Accepting the second would otherwise record the first as
    # promoted without anyone approving it, and the loop then reads that
    # watermark and never proposes it again.
    world = make_world()
    add_reflections(world, "aaa-pattern", 3)
    add_reflections(world, "bbb-pattern", 3, start_day=20)
    repo = init_target(world)

    def chat(role, messages, **kwargs):
        if role == "judge":
            return json.dumps({"verdict": "yes", "reason": "quoted"})
        prompt = messages[-1]["content"]
        pattern = "aaa-pattern" if "aaa-pattern" in prompt else "bbb-pattern"
        return json.dumps(skill_draft(pattern, QUOTE))

    report = run.run(world, make_cfg(), apply=True, chat=chat)
    assert sorted(report.staged) == ["aaa-pattern", "bbb-pattern"], report.gated_out

    for pattern in ("aaa-pattern", "bbb-pattern"):
        found, raw = gitutil.show(repo, _branch(world, pattern), "promotions.json")
        assert found
        assert list(curriculum.parse_ledger(raw).entries) == [pattern]


def test_staging_never_moves_the_live_head_or_dirties_the_tree(env):
    world = _world_with()
    repo = init_target(world)
    before_head = gitutil.head(repo)
    before_branch = gitutil.current_branch(repo)

    report = run.run(world, make_cfg(), apply=True,
                     chat=FakeChat(draft=skill_draft(PATTERN, QUOTE)))

    assert report.staged == [PATTERN], report.gated_out
    assert gitutil.head(repo) == before_head
    assert gitutil.current_branch(repo) == before_branch
    assert gitutil.git(repo, "status", "--porcelain") == ""
    # The ledger exists only on the branch, never as untracked residue on main:
    # a later run reading that residue would skip the pattern forever.
    assert not (repo / "promotions.json").exists()
    assert not (repo / "skills" / PATTERN).exists()


def test_a_routed_hook_is_written_as_json_at_the_nudges_path(env):
    world = _world_with()
    repo = init_target(world)

    report = run.run(world, make_cfg(), apply=True,
                     chat=FakeChat(draft=hook_draft(PATTERN)))

    assert report.staged == [PATTERN], report.gated_out
    branch = _branch(world)
    found, raw = gitutil.show(repo, branch, f"nudges/{PATTERN}.json")
    assert found
    assert json.loads(raw)["gate"] == {"command_matches": "git (commit|push)"}


def test_a_rule_is_written_into_the_managed_block_of_a_created_rules_file(env):
    world = _world_with()
    repo = init_target(world)
    draft = {"trigger_event": "none", "gate": None, "needs_own_context": False,
             "context_evidence": None, "capability_evidence": None,
             "declined": False, "artifact": rule_body()}

    report = run.run(world, make_cfg(), apply=True, chat=FakeChat(draft=draft))

    assert report.staged == [PATTERN], report.gated_out
    found, raw = gitutil.show(repo, _branch(world), "RULES.md")
    assert found
    assert f"<!--rule:{PATTERN}-->" in raw
    # The live tree is untouched: the rules file was created inside the worktree.
    assert not (repo / "RULES.md").exists()


def test_a_rule_bullet_carrying_a_block_marker_never_reaches_a_branch(env):
    # The bullet is written into the shared managed block verbatim. One carrying
    # the block's own markers duplicates the pair, and from then on every rule
    # write is refused as ambiguous and retire raises: the file is wedged with no
    # way back through the loop. Gated at the lint, before any worktree exists.
    world = _world_with()
    repo = init_target(world)
    draft = {"trigger_event": "none", "gate": None, "needs_own_context": False,
             "context_evidence": None, "capability_evidence": None,
             "declined": False,
             "artifact": f"{rule_body().rstrip()} {RULE_END}"}

    report = run.run(world, make_cfg(), apply=True, chat=FakeChat(draft=draft))

    assert report.staged == []
    assert "managed-block marker" in report.gated_out[PATTERN], report.gated_out
    assert not gitutil.ref_exists(repo, f"refs/heads/{_branch(world)}")
    assert not (repo / "RULES.md").exists()


def test_a_custom_target_without_a_marker_pair_refuses_the_rule_write(env, tmp_path):
    target = tmp_path / "someone-elses-repo"
    world = make_world(target=target)
    add_reflections(world, PATTERN, 3)
    init_target(world)
    draft = {"trigger_event": "none", "gate": None, "needs_own_context": False,
             "context_evidence": None, "capability_evidence": None,
             "declined": False, "artifact": rule_body()}

    report = run.run(world, make_cfg(), apply=True, chat=FakeChat(draft=draft))

    assert report.staged == []
    assert "rule target not writable" in report.gated_out[PATTERN]


# --- gates --------------------------------------------------------------------

def test_a_failing_judge_gates_only_that_pattern(env):
    world = make_world()
    add_reflections(world, "aaa-pattern", 3)
    add_reflections(world, "bbb-pattern", 3, start_day=20)
    repo = init_target(world)

    def chat(role, messages, **kwargs):
        prompt = messages[-1]["content"]
        if role == "judge":
            bad = "aaa-pattern" in prompt
            return json.dumps({"verdict": "no" if bad else "yes",
                               "reason": "rule 2: vague" if bad else "quoted"})
        pattern = "aaa-pattern" if "aaa-pattern" in prompt else "bbb-pattern"
        return json.dumps(skill_draft(pattern, QUOTE))

    report = run.run(world, make_cfg(), apply=True, chat=chat)

    assert report.staged == ["bbb-pattern"], report.gated_out
    assert "judge:" in report.gated_out["aaa-pattern"]
    assert gitutil.ref_exists(repo, f"refs/heads/{_branch(world, 'aaa-pattern')}") is False
    assert gitutil.ref_exists(repo, f"refs/heads/{_branch(world, 'bbb-pattern')}")


def test_a_provider_failure_gates_one_pattern_and_the_run_continues(env):
    world = make_world()
    add_reflections(world, "aaa-pattern", 3)
    add_reflections(world, "bbb-pattern", 3, start_day=20)
    init_target(world)

    def chat(role, messages, **kwargs):
        prompt = messages[-1]["content"]
        if "aaa-pattern" in prompt:
            raise TimeoutError("the endpoint never answered")
        if role == "judge":
            return json.dumps({"verdict": "yes", "reason": "quoted"})
        return json.dumps(skill_draft("bbb-pattern", QUOTE))

    report = run.run(world, make_cfg(), apply=True, chat=chat)

    assert report.staged == ["bbb-pattern"], report.gated_out
    assert report.gated_out["aaa-pattern"].startswith("draft failed:")


def test_a_failing_lint_gates_the_pattern_and_names_the_route(env):
    world = _world_with()
    init_target(world)
    vacuous = {"trigger_event": "none", "gate": None, "needs_own_context": False,
               "context_evidence": None, "capability_evidence": QUOTE,
               "declined": False,
               "artifact": (f"---\nname: {PATTERN}\ndescription: Use when careless."
                            "\n---\n\n## Be careful\n\n" + "Always be careful. " * 10)}

    report = run.run(world, make_cfg(), apply=True, chat=FakeChat(draft=vacuous))

    assert report.staged == []
    assert report.gated_out[PATTERN].startswith("artifact-lint:")
    assert "router:" in report.gated_out[PATTERN]


def test_an_unreadable_drafter_reply_is_reported_as_a_transport_problem(env):
    world = _world_with()
    init_target(world)

    def chat(role, messages, **kwargs):
        return "I'm sorry, I can't help with that."

    report = run.run(world, make_cfg(), apply=True, chat=chat)
    assert "unreadable drafter reply" in report.gated_out[PATTERN]


def test_a_dirty_artifact_directory_blocks_the_run(env):
    world = _world_with()
    repo = init_target(world)
    commit_file(repo, f"skills/other/SKILL.md", "hand written\n")
    (repo / "skills" / "other" / "SKILL.md").write_text("edited, uncommitted\n")

    report = run.run(world, make_cfg(), apply=True,
                     chat=FakeChat(draft=skill_draft(PATTERN, QUOTE)))

    assert report.staged == []
    assert "repo integrity" in report.gated_out[PATTERN]


def test_an_unrelated_dirty_file_does_not_block_the_run(env):
    world = _world_with()
    repo = init_target(world)
    commit_file(repo, "README.md", "hello\n")
    (repo / "README.md").write_text("edited, uncommitted\n")

    report = run.run(world, make_cfg(), apply=True,
                     chat=FakeChat(draft=skill_draft(PATTERN, QUOTE)))

    assert report.staged == [PATTERN], report.gated_out
    # And the unrelated edit survives.
    assert (repo / "README.md").read_text() == "edited, uncommitted\n"


def test_over_cap_patterns_are_reported_not_silently_dropped(env):
    world = make_world()
    for name in ("aaa-pattern", "bbb-pattern"):
        add_reflections(world, name, 3, start_day=1 if name.startswith("a") else 20)
    init_target(world)

    def chat(role, messages, **kwargs):
        if role == "judge":
            return json.dumps({"verdict": "yes", "reason": "quoted"})
        return json.dumps(skill_draft("aaa-pattern", QUOTE))

    report = run.run(world, make_cfg(per_run_cap=1), apply=True, chat=chat)
    assert report.staged == ["aaa-pattern"]
    assert "cap" in report.gated_out["bbb-pattern"]


# --- auto merge ---------------------------------------------------------------

def test_a_cloud_world_can_opt_into_auto_merge(env):
    world = _world_with(llm="cloud")
    repo = init_target(world)
    before = gitutil.head(repo)

    report = run.run(world, make_cfg(auto_merge=True), apply=True,
                     chat=FakeChat(draft=skill_draft(PATTERN, QUOTE)))

    assert report.merged == [PATTERN], report.gated_out
    assert gitutil.head(repo) != before
    assert (repo / "skills" / PATTERN / "SKILL.md").exists()
    found, raw = gitutil.show(repo, "main", "promotions.json")
    assert curriculum.parse_ledger(raw).entries[PATTERN].status == "promoted"


def test_a_local_world_never_auto_merges_even_when_config_asks(env):
    # The on-machine judge accepted 3 of 4 adversarial-but-lint-clean drafts,
    # including one that fabricated its supporting source quote.
    world = _world_with(llm="local")
    repo = init_target(world)
    before = gitutil.head(repo)

    report = run.run(world, make_cfg(auto_merge=True), apply=True,
                     chat=FakeChat(draft=skill_draft(PATTERN, QUOTE)))

    assert report.merged == []
    assert report.staged == [PATTERN], report.gated_out
    assert gitutil.head(repo) == before
    found, raw = gitutil.show(repo, _branch(world), "promotions.json")
    assert curriculum.parse_ledger(raw).entries[PATTERN].status == "staged"


# --- served_by suppression ----------------------------------------------------

def test_an_already_served_pattern_is_not_re_routed(env, monkeypatch):
    world = _world_with()
    repo = init_target(world)
    _write_ledger(world, **{PATTERN: PromotionEntry(
        pattern=PATTERN, promoted_at_count=0, status="promoted",
        artifact_type=ArtifactType.rule,
        served_by=ArtifactRef(type=ArtifactType.rule, path="RULES.md"))})
    commit_file(repo, "promotions.json", config.ledger_path(world).read_text(),
                "chore: ledger")

    def boom(*args, **kwargs):
        raise AssertionError("route() was consulted for an already-served pattern")

    monkeypatch.setattr(run.router, "route", boom)
    chat = FakeChat(draft={"artifact": rule_body()})

    report = run.run(world, make_cfg(), apply=True, chat=chat)

    assert report.staged == [PATTERN], report.gated_out
    assert chat.roles == ["drafter", "judge"]
    assert "Its type is already decided" in chat.prompts_for("drafter")[0]
    found, raw = gitutil.show(repo, _branch(world), "RULES.md")
    assert found and f"<!--rule:{PATTERN}-->" in raw


def test_a_placeholder_is_never_offered_to_the_drafter_as_an_existing_draft(env):
    world = _world_with()
    repo = init_target(world)
    stub = artifacts.placeholder_body(PATTERN, "skill", "rule")
    commit_file(repo, f"skills/{PATTERN}/SKILL.md", stub, "chore: stub")
    _write_ledger(world, **{PATTERN: PromotionEntry(
        pattern=PATTERN, promoted_at_count=0, status="staged",
        artifact_type=ArtifactType.skill,
        served_by=ArtifactRef(type=ArtifactType.skill,
                              path=f"skills/{PATTERN}/SKILL.md"))})
    commit_file(repo, "promotions.json", config.ledger_path(world).read_text(),
                "chore: ledger")

    chat = FakeChat(draft={"artifact": skill_body(PATTERN, QUOTE)})
    report = run.run(world, make_cfg(), apply=True, chat=chat)

    assert report.staged == [PATTERN], report.gated_out
    prompt = chat.prompts_for("drafter")[0]
    assert "Write a" in prompt and "Refine the existing" not in prompt
    assert "awaiting a real draft" not in prompt


# --- redraft after a route change --------------------------------------------

def test_a_route_change_redrafts_once_in_the_selected_shape(env):
    world = _world_with()
    repo = init_target(world)
    # The drafter claims a skill on evidence that is not in the sources, so the
    # router downgrades it to a rule and the body has to be rewritten.
    first = {"trigger_event": "none", "gate": None, "needs_own_context": False,
             "context_evidence": None,
             "capability_evidence": "the agent really wanted this",
             "declined": False, "artifact": "---\nname: x\n---\nbody"}
    chat = FakeChat(drafts=[first, {"artifact": rule_body()}])

    report = run.run(world, make_cfg(), apply=True, chat=chat)

    assert report.staged == [PATTERN], report.gated_out
    assert chat.roles == ["drafter", "drafter", "judge"]
    found, raw = gitutil.show(repo, _branch(world), "RULES.md")
    assert found and f"<!--rule:{PATTERN}-->" in raw


def test_the_drafter_prompt_states_the_routers_quote_bar():
    # The prompt and the router are two halves of one contract. A prompt asking
    # for "an exact substring" while the router requires five words downgrades an
    # honest drafter to `rule` on every run, and nothing in the report says why.
    prompt = prompts.draft_messages(PATTERN, ["a lesson"], None, None)[-1]["content"]
    assert f"{router.MIN_QUOTE_WORDS} words" in prompt
    assert f"{router.MIN_QUOTE_CHARS} characters" in prompt


def test_a_declined_pattern_stages_nothing(env):
    world = _world_with()
    init_target(world)
    declined = {"trigger_event": "none", "gate": None, "needs_own_context": False,
                "context_evidence": None, "capability_evidence": None,
                "declined": True, "artifact": ""}
    report = run.run(world, make_cfg(), apply=True, chat=FakeChat(draft=declined))
    assert report.staged == []
    assert "drafter declined" in report.gated_out[PATTERN]


# --- target handling ----------------------------------------------------------

def test_the_builtin_learned_repo_is_initialised_on_demand(env):
    world = _world_with()
    assert not config.target_root(world).exists()
    report = run.run(world, make_cfg(), apply=True,
                     chat=FakeChat(draft=skill_draft(PATTERN, QUOTE)))
    assert report.staged == [PATTERN], report.gated_out
    assert gitutil.is_repo(config.target_root(world))


def test_a_custom_target_that_is_not_a_repo_is_an_error_not_an_init(env, tmp_path):
    target = tmp_path / "not-a-repo"
    target.mkdir()
    world = make_world(target=target)
    add_reflections(world, PATTERN, 3)
    report = run.run(world, make_cfg(), apply=True,
                     chat=FakeChat(draft=skill_draft(PATTERN, QUOTE)))
    assert report.error and "not a git repository" in report.error
    assert not gitutil.is_repo(target)


def test_a_second_run_on_the_same_evidence_replaces_the_branch_not_the_history(env):
    world = _world_with()
    repo = init_target(world)
    chat = FakeChat(draft=skill_draft(PATTERN, QUOTE))
    run.run(world, make_cfg(), apply=True, chat=chat)
    first = gitutil.git(repo, "rev-parse", _branch(world))

    add_reflections(world, PATTERN, 3, start_day=20)
    run.run(world, make_cfg(), apply=True, chat=chat)
    second = gitutil.git(repo, "rev-parse", _branch(world))

    assert second != first
    commits = gitutil.git(repo, "log", "--format=%H", f"main..{_branch(world)}").splitlines()
    assert len(commits) == 1, "an ordinary redraft resets its branch onto the base"
