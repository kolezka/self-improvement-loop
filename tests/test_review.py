"""Review, accept, reject, rehome, retire: the human-in-the-loop half."""

from __future__ import annotations

import contextlib
import json

import pytest

from sil import artifacts, config, curriculum, gitutil, paths, review, run, store
from sil.models import ArtifactType, Ledger, PromotionEntry
from tests.curriculum_fixtures import (
    FakeChat, add_reflections, init_target, install_fake_nudge, make_cfg,
    make_world, sil_env, skill_draft,
)

PATTERN = "verify-callsites"
SIBLING = "aaa-rejected-sibling"
QUOTE = "run `rg` over every call site of the changed symbol"


@pytest.fixture
def env(tmp_path, monkeypatch):
    sil_env(tmp_path, monkeypatch)
    install_fake_nudge(monkeypatch)
    return tmp_path


def _stage(world, cfg=None, pattern=PATTERN):
    """Put one staged branch in the target repo through the real run path."""
    return run.run(world, cfg or make_cfg(), apply=True,
                   chat=FakeChat(draft=skill_draft(pattern, QUOTE)))


def _seed(world, *, sibling: bool = False):
    """A target repo with reflections, optionally carrying a rejected sibling row."""
    add_reflections(world, PATTERN, 3)
    repo = init_target(world)
    if sibling:
        ledger = Ledger()
        ledger.entries[SIBLING] = PromotionEntry(
            pattern=SIBLING, promoted_at_count=0, rejected_at_count=7,
            status="rejected", artifact_type=ArtifactType.hook)
        store.save_ledger(config.ledger_path(world), ledger)
        gitutil.git(repo, "add", "--", "promotions.json")
        gitutil.git(repo, "commit", "-q", "-m", "chore: record a refusal")
    return repo


# --- read side ----------------------------------------------------------------

def test_the_queue_lists_staged_branches(env):
    world = make_world()
    repo = _seed(world)
    assert review.queue(world, make_cfg()) == []

    _stage(world)
    rows = review.queue(world, make_cfg())
    assert [r.pattern for r in rows] == [PATTERN]
    row = rows[0]
    assert row.branch == f"curriculum/default/{PATTERN}"
    assert row.artifact_type == ArtifactType.skill
    assert row.artifact_path == f"skills/{PATTERN}/SKILL.md"
    assert row.count == 3


def test_a_merged_branch_leaves_the_queue(env):
    world = make_world()
    repo = _seed(world)
    _stage(world)
    detail = review.detail(world, make_cfg(), PATTERN)
    review.accept(world, make_cfg(), PATTERN, detail.reviewed_state)
    assert review.queue(world, make_cfg()) == []


def test_detail_and_diff_agree_on_the_reviewed_state(env):
    world = make_world()
    _seed(world)
    _stage(world)

    detail = review.detail(world, make_cfg(), PATTERN)
    diff = review.diff(world, make_cfg(), PATTERN)

    assert detail.reviewed_state
    assert len(detail.reviewed_state) == 64
    assert detail.reviewed_state == diff.reviewed_state
    assert detail.body.startswith("---\nname: " + PATTERN)
    assert len(detail.sources) == 3
    assert detail.accept_blocked is None
    assert f"skills/{PATTERN}/SKILL.md" in diff.diff


def test_the_inventory_joins_the_ledger_with_live_counts(env):
    world = make_world()
    _seed(world)
    _stage(world)
    detail = review.detail(world, make_cfg(), PATTERN)
    review.accept(world, make_cfg(), PATTERN, detail.reviewed_state)

    rows = review.inventory(world, make_cfg())
    assert [r.pattern for r in rows] == [PATTERN]
    assert rows[0].status == "promoted"
    assert rows[0].reflections == 3
    assert rows[0].served_by == f"skills/{PATTERN}/SKILL.md"


# --- accept -------------------------------------------------------------------

def test_accept_refuses_a_digest_that_no_longer_describes_the_branch(env):
    world = make_world()
    repo = _seed(world)
    _stage(world)
    stale = review.detail(world, make_cfg(), PATTERN).reviewed_state

    branch = run.branch_name(world.name, PATTERN)
    with gitutil.scratch_worktree(repo, branch, "main") as tree:
        gitutil.git(tree, "commit", "-q", "--allow-empty", "-m", "chore: advance")

    with pytest.raises(review.ReviewError, match="reviewed state changed"):
        review.accept(world, make_cfg(), PATTERN, stale)
    # Refused before anything was written: the branch is still pending.
    assert [r.pattern for r in review.queue(world, make_cfg())] == [PATTERN]


def test_accept_refuses_an_empty_digest(env):
    world = make_world()
    _seed(world)
    _stage(world)
    with pytest.raises(review.ReviewError, match="reviewed state changed"):
        review.accept(world, make_cfg(), PATTERN, "")


def test_accept_fast_forwards_and_promotes_only_its_own_row(env):
    world = make_world()
    repo = _seed(world, sibling=True)
    _stage(world)
    before = gitutil.head(repo)

    detail = review.detail(world, make_cfg(), PATTERN)
    out = review.accept(world, make_cfg(), PATTERN, detail.reviewed_state)

    assert out["merged"] == f"curriculum/default/{PATTERN}"
    assert out["artifact_type"] == "skill"
    assert gitutil.current_branch(repo) == "main"
    assert (repo / "skills" / PATTERN / "SKILL.md").exists()
    # A fast-forward, so the accepted commit is a descendant of what was there.
    assert gitutil.git(repo, "merge-base", "--is-ancestor", before, "main", check=False) == ""

    ledger = store.load_ledger(config.ledger_path(world))
    assert ledger.entries[PATTERN].status == "promoted"
    assert ledger.entries[PATTERN].commit
    # The sibling a human refused keeps its watermark and its status.
    assert ledger.entries[SIBLING].status == "rejected"
    assert ledger.entries[SIBLING].rejected_at_count == 7


def test_accept_deletes_the_branch(env):
    world = make_world()
    repo = _seed(world)
    _stage(world)
    branch = run.branch_name(world.name, PATTERN)
    detail = review.detail(world, make_cfg(), PATTERN)
    out = review.accept(world, make_cfg(), PATTERN, detail.reviewed_state)
    assert out["branch_deleted"] is True
    assert not gitutil.ref_exists(repo, f"refs/heads/{branch}")


def test_accept_links_the_skill_into_the_claude_config(env):
    world = make_world()
    repo = _seed(world)
    _stage(world)
    detail = review.detail(world, make_cfg(), PATTERN)
    out = review.accept(world, make_cfg(), PATTERN, detail.reviewed_state)

    link = paths.claude_config_dir() / "skills" / PATTERN
    assert link.is_symlink()
    assert link.resolve() == (repo / "skills" / PATTERN).resolve()
    assert out["linked"] == str(link)
    assert "link_error" not in out


def test_relink_refuses_to_replace_a_real_directory(env):
    world = make_world()
    repo = _seed(world)
    real = paths.claude_config_dir() / "skills" / PATTERN
    real.mkdir(parents=True)
    (real / "SKILL.md").write_text("hand written, never committed\n")

    with pytest.raises(review.ReviewError, match="refusing to replace"):
        review.relink(world, PATTERN, "skill")
    assert (real / "SKILL.md").read_text() == "hand written, never committed\n"


def test_a_link_failure_does_not_undo_an_accepted_merge(env):
    world = make_world()
    repo = _seed(world)
    _stage(world)
    real = paths.claude_config_dir() / "skills" / PATTERN
    real.mkdir(parents=True)
    (real / "SKILL.md").write_text("hand written\n")

    detail = review.detail(world, make_cfg(), PATTERN)
    out = review.accept(world, make_cfg(), PATTERN, detail.reviewed_state)

    assert out["merged"]
    assert "refusing to replace" in out["link_error"]
    assert store.load_ledger(config.ledger_path(world)).entries[PATTERN].status == "promoted"


def test_a_hook_and_a_rule_are_linked_nowhere(env):
    world = make_world()
    _seed(world)
    assert review.relink(world, PATTERN, "hook") is None
    assert review.relink(world, PATTERN, "rule") is None
    assert not (paths.claude_config_dir() / "skills").exists()


def test_accept_refuses_a_branch_carrying_foreign_files(env):
    world = make_world()
    repo = _seed(world)
    _stage(world)
    branch = run.branch_name(world.name, PATTERN)
    with gitutil.scratch_worktree(repo, branch, "main") as tree:
        (tree / "install.sh").write_text("#!/bin/sh\necho unrelated work\n")
        gitutil.git(tree, "add", "--", "install.sh")
        gitutil.git(tree, "commit", "-q", "-m", "chore(install): unrelated")

    detail = review.detail(world, make_cfg(), PATTERN)
    assert "install.sh" in detail.accept_blocked
    with pytest.raises(review.ReviewError, match="install.sh"):
        review.accept(world, make_cfg(), PATTERN, detail.reviewed_state)


def test_accept_refuses_when_the_live_repo_is_on_another_branch(env):
    world = make_world()
    repo = _seed(world)
    _stage(world)
    gitutil.git(repo, "checkout", "-q", "-b", "side")
    detail = review.detail(world, make_cfg(), PATTERN)
    with pytest.raises(review.ReviewError, match="not main"):
        review.accept(world, make_cfg(), PATTERN, detail.reviewed_state)


def test_accepting_a_second_pattern_resolves_the_ledger_add_add_conflict(env):
    world = make_world()
    repo = _seed(world)
    add_reflections(world, "bbb-pattern", 3, start_day=20)
    _stage(world)
    run.run(world, make_cfg(), apply=True,
            chat=FakeChat(draft=skill_draft("bbb-pattern", QUOTE)))

    for pattern in (PATTERN, "bbb-pattern"):
        detail = review.detail(world, make_cfg(), pattern)
        review.accept(world, make_cfg(), pattern, detail.reviewed_state)

    ledger = store.load_ledger(config.ledger_path(world))
    assert sorted(ledger.entries) == ["bbb-pattern", PATTERN]
    assert all(e.status == "promoted" for e in ledger.entries.values())


# --- reject -------------------------------------------------------------------

def test_reject_records_the_watermark_and_deletes_the_branch(env):
    world = make_world()
    repo = _seed(world)
    _stage(world)
    branch = run.branch_name(world.name, PATTERN)

    out = review.reject(world, make_cfg(), PATTERN)

    assert out["rejected_at_count"] == 3
    assert not gitutil.ref_exists(repo, f"refs/heads/{branch}")
    entry = store.load_ledger(config.ledger_path(world)).entries[PATTERN]
    assert entry.status == "rejected"
    assert entry.rejected_at_count == 3
    # Nothing of the refused artifact reached the default branch.
    assert not (repo / "skills" / PATTERN).exists()
    # And no forced route survives to re-impose the shape a human refused.
    assert entry.served_by is None


def test_a_rejected_pattern_is_not_promotable_until_the_threshold_is_paid(env):
    world = make_world()
    _seed(world)
    _stage(world)
    review.reject(world, make_cfg(), PATTERN)

    def action_for():
        report = curriculum.plan(world, make_cfg(threshold=3))
        return {a.pattern: a for a in report.actions}[PATTERN]

    assert action_for().action == "done"
    add_reflections(world, PATTERN, 2, start_day=20)
    assert action_for().action == "done"
    add_reflections(world, PATTERN, 1, start_day=25)
    assert action_for().action == "promote"


def test_rejecting_a_refine_moves_the_watermark_and_keeps_the_live_artifact(env):
    # The other half of reject: the pattern already has a row on the default
    # branch, so only the watermark may move. Overwriting its type or served_by
    # with the branch's would make the ledger describe a file this refusal threw
    # away, and un-setting its status would report an accepted artifact as
    # pending forever.
    world = make_world()
    repo = _accepted(world)
    add_reflections(world, PATTERN, 3, start_day=20)
    _stage(world)

    out = review.reject(world, make_cfg(), PATTERN)

    assert out["rejected_at_count"] == 6
    entry = store.load_ledger(config.ledger_path(world)).entries[PATTERN]
    assert entry.rejected_at_count == 6
    assert entry.promoted_at_count == 3
    assert entry.status == "promoted", "rejecting a refine does not un-promote"
    assert entry.artifact_type == ArtifactType.skill
    assert entry.served_by.path == f"skills/{PATTERN}/SKILL.md"
    assert (repo / "skills" / PATTERN / "SKILL.md").exists()

    report = curriculum.plan(world, make_cfg(threshold=3))
    assert {a.pattern: a for a in report.actions}[PATTERN].action == "done"


def test_a_branch_may_never_record_a_siblings_promotion(env):
    # A branch written before the one-row rule carries its siblings' rows too.
    # Letting those through records artifacts a human refused, and the loop then
    # reads them as already promoted: the pattern is burned.
    world = make_world()
    repo = _seed(world, sibling=True)
    _stage(world)
    branch = run.branch_name(world.name, PATTERN)
    with gitutil.scratch_worktree(repo, branch, "main") as tree:
        ledger = store.load_ledger(tree / "promotions.json")
        ledger.entries[SIBLING] = ledger.entries[SIBLING].model_copy(
            update={"status": "promoted", "promoted_at_count": 9})
        store.save_ledger(tree / "promotions.json", ledger)
        gitutil.git(tree, "add", "--", "promotions.json")
        gitutil.git(tree, "commit", "-q", "-m", "chore: a branch claiming a sibling")

    detail = review.detail(world, make_cfg(), PATTERN)
    review.accept(world, make_cfg(), PATTERN, detail.reviewed_state)

    entries = store.load_ledger(config.ledger_path(world)).entries
    assert entries[PATTERN].status == "promoted"
    assert entries[SIBLING].status == "rejected"
    assert entries[SIBLING].promoted_at_count == 0
    assert entries[SIBLING].rejected_at_count == 7


def test_rejecting_leaves_the_live_tree_clean(env):
    world = make_world()
    repo = _seed(world)
    _stage(world)
    review.reject(world, make_cfg(), PATTERN)
    assert gitutil.git(repo, "status", "--porcelain") == ""
    assert gitutil.current_branch(repo) == "main"
    # The scratch ref used to carry the commit is gone.
    assert "sil-scratch" not in gitutil.git(repo, "branch", "--list", "sil-scratch/*")


# --- rehome and retire --------------------------------------------------------

def _accepted(world):
    _seed(world)
    _stage(world)
    detail = review.detail(world, make_cfg(), PATTERN)
    review.accept(world, make_cfg(), PATTERN, detail.reviewed_state)
    return config.target_root(world)


def test_rehome_stages_a_stub_that_accept_refuses(env):
    world = make_world()
    repo = _accepted(world)

    out = review.rehome(world, make_cfg(), PATTERN, "hook")

    assert out["branch"] == f"curriculum/default/{PATTERN}"
    assert out["path"] == f"nudges/{PATTERN}.json"
    detail = review.detail(world, make_cfg(), PATTERN)
    assert detail.artifact_type == ArtifactType.hook
    assert artifacts.is_placeholder_body("hook", detail.body)
    assert "placeholder" in detail.accept_blocked
    with pytest.raises(review.ReviewError, match="placeholder"):
        review.accept(world, make_cfg(), PATTERN, detail.reviewed_state)
    # Stages only: the default branch still carries the old artifact.
    assert (repo / "skills" / PATTERN / "SKILL.md").exists()
    assert gitutil.current_branch(repo) == "main"


def test_rehome_moves_the_artifact_on_its_branch(env):
    world = make_world()
    repo = _accepted(world)
    review.rehome(world, make_cfg(), PATTERN, "hook")
    branch = run.branch_name(world.name, PATTERN)

    assert gitutil.show(repo, branch, f"skills/{PATTERN}/SKILL.md")[0] is False
    assert gitutil.show(repo, branch, f"nudges/{PATTERN}.json")[0] is True
    entry = curriculum.parse_ledger(
        gitutil.show(repo, branch, "promotions.json")[1]).entries[PATTERN]
    assert entry.served_by.type == ArtifactType.hook
    assert entry.promoted_at_count == 3, "a re-home preserves the evidence level"


def test_rehome_refuses_the_type_that_already_serves_the_pattern(env):
    world = make_world()
    _accepted(world)
    with pytest.raises(review.ReviewError, match="already served"):
        review.rehome(world, make_cfg(), PATTERN, "skill")


def test_rehome_refuses_a_pattern_that_is_not_in_the_ledger(env):
    world = make_world()
    _seed(world)
    with pytest.raises(review.ReviewError, match="not in the ledger"):
        review.rehome(world, make_cfg(), "unknown-pattern", "hook")


def test_retire_removes_the_artifact_and_marks_the_row_retired(env):
    world = make_world()
    repo = _accepted(world)

    out = review.retire(world, make_cfg(), PATTERN)

    assert out["removed"] == f"skills/{PATTERN}/SKILL.md"
    branch = out["branch"]
    assert gitutil.show(repo, branch, f"skills/{PATTERN}/SKILL.md")[0] is False
    entry = curriculum.parse_ledger(
        gitutil.show(repo, branch, "promotions.json")[1]).entries[PATTERN]
    assert entry.status == "retired"
    assert entry.served_by is None
    # Stages only, exactly like rehome.
    assert (repo / "skills" / PATTERN / "SKILL.md").exists()


def test_retiring_twice_is_refused(env):
    world = make_world()
    _accepted(world)
    review.retire(world, make_cfg(), PATTERN)
    with pytest.raises(review.ReviewError, match="already retired"):
        review.retire(world, make_cfg(), PATTERN)


def test_accepting_a_retirement_reaps_the_dangling_symlink(env):
    world = make_world()
    repo = _accepted(world)
    link = paths.claude_config_dir() / "skills" / PATTERN
    assert link.is_symlink()

    review.retire(world, make_cfg(), PATTERN)
    detail = review.detail(world, make_cfg(), PATTERN)
    review.accept(world, make_cfg(), PATTERN, detail.reviewed_state)

    assert not (repo / "skills" / PATTERN).exists()
    assert not link.is_symlink(), "a retired skill must not stay listed in the config"


# --- the digest ---------------------------------------------------------------

def test_the_digest_covers_the_repo_world_pattern_branch_and_both_commits(env):
    world = make_world()
    repo = _seed(world)
    _stage(world)
    default = gitutil.default_branch(repo)
    snapshot = review._snapshot(world, repo, default, PATTERN)

    import hashlib
    canonical = json.dumps({
        "base_ref": default,
        "base_sha": snapshot.base_sha,
        "branch": snapshot.branch,
        "branch_sha": snapshot.branch_sha,
        "pattern": PATTERN,
        "repo": str(repo.resolve()),
        "version": 1,
        "world": world.name,
    }, sort_keys=True, separators=(",", ":"))
    expected = hashlib.sha256(
        (review.DIGEST_PREFIX + canonical).encode("utf-8")).hexdigest()
    assert snapshot.reviewed_state == expected


# --- accept is exclusive with the curriculum run ------------------------------

def test_accept_refuses_a_branch_that_moved_after_the_digest_was_checked(env, monkeypatch):
    # The window the digest check does not cover. Every guard reads the branch by
    # NAME, and a worker tick force-updates that name (`run.py`'s `branch -f`).
    # A tick landing between the check and the merge used to publish whatever it
    # wrote, under a digest describing the commit a human actually read.
    world = make_world()
    repo = _seed(world)
    _stage(world)
    branch = run.branch_name(world.name, PATTERN)
    detail = review.detail(world, make_cfg(), PATTERN)
    before_head = gitutil.head(repo)

    real_scratch = gitutil.scratch_worktree

    @contextlib.contextmanager
    def advancing(repo_arg, branch_arg, base):
        if branch_arg == branch:
            # Exactly what a curriculum tick does to a staged branch.
            gitutil.git(repo_arg, "branch", "-q", "-f", branch_arg, "main")
        with real_scratch(repo_arg, branch_arg, base) as tree:
            yield tree

    monkeypatch.setattr(gitutil, "scratch_worktree", advancing)

    with pytest.raises(review.ReviewError, match="moved"):
        review.accept(world, make_cfg(), PATTERN, detail.reviewed_state)

    assert gitutil.head(repo) == before_head, "nothing reached the default branch"
    assert not (repo / "skills" / PATTERN).exists()
    assert not (repo / "promotions.json").exists()


def test_accept_merges_the_commit_it_prepared_not_the_moving_ref(env, monkeypatch):
    # The merge argument is the sha accept just built, so a branch that moves
    # after the worktree closes cannot substitute its own content for it.
    world = make_world()
    repo = _seed(world)
    _stage(world)
    branch = run.branch_name(world.name, PATTERN)
    detail = review.detail(world, make_cfg(), PATTERN)

    merged_args: list[tuple] = []
    real_git = gitutil.git

    def recording_git(repo_arg, *args, **kwargs):
        if args[:3] == ("merge", "-q", "--ff-only"):
            merged_args.append(args)
        return real_git(repo_arg, *args, **kwargs)

    monkeypatch.setattr(gitutil, "git", recording_git)
    out = review.accept(world, make_cfg(), PATTERN, detail.reviewed_state)

    assert merged_args, "accept never merged"
    target = merged_args[-1][3]
    assert target != branch, "merging the ref re-resolves a name that can move"
    assert target.startswith(out["commit"])
    assert (repo / "skills" / PATTERN / "SKILL.md").exists()


@pytest.mark.parametrize("action", ["accept", "reject", "rehome", "retire"])
def test_a_write_refuses_while_the_worker_holds_the_lock(env, action):
    from sil.worker import Lock

    world = make_world()
    repo = _seed(world)
    _stage(world)
    detail = review.detail(world, make_cfg(), PATTERN)
    calls = {
        "accept": lambda: review.accept(world, make_cfg(), PATTERN, detail.reviewed_state),
        "reject": lambda: review.reject(world, make_cfg(), PATTERN),
        "rehome": lambda: review.rehome(world, make_cfg(), PATTERN, "hook"),
        "retire": lambda: review.retire(world, make_cfg(), PATTERN),
    }
    before_head = gitutil.head(repo)

    with Lock():
        with pytest.raises(review.ReviewError, match="worker is running"):
            calls[action]()

    assert gitutil.head(repo) == before_head
    # And the refusal is only for the duration: the lock is released, so the same
    # call works immediately afterwards.
    calls[action]()


def test_an_untracked_artifact_file_is_refused_before_the_branch_is_touched(env):
    # `merge --ff-only` refuses to overwrite an untracked file. Checked only for
    # tracked changes, that refusal arrived after the branch had been rewritten,
    # leaving a reviewed digest describing a commit that was no longer its head.
    world = make_world()
    repo = _seed(world)
    _stage(world)
    branch = run.branch_name(world.name, PATTERN)
    detail = review.detail(world, make_cfg(), PATTERN)

    live = repo / "skills" / PATTERN / "SKILL.md"
    live.parent.mkdir(parents=True, exist_ok=True)
    live.write_text("hand written, never committed\n", encoding="utf-8")
    before_head = gitutil.head(repo)
    before_commits = gitutil.git(repo, "log", "--format=%H", f"main..{branch}").splitlines()

    with pytest.raises(review.ReviewError, match="untracked"):
        review.accept(world, make_cfg(), PATTERN, detail.reviewed_state)

    assert gitutil.head(repo) == before_head
    assert gitutil.git(repo, "log", "--format=%H",
                       f"main..{branch}").splitlines() == before_commits
    assert live.read_text() == "hand written, never committed\n"


# --- the remote half ----------------------------------------------------------

def _fake_remote(monkeypatch, gh):
    """No network: swallow push/ls-remote, route every `gh` call to `gh`."""
    real_git = gitutil.git

    def fake_git(repo_arg, *args, **kwargs):
        if args and args[0] in ("push", "ls-remote"):
            return ""
        return real_git(repo_arg, *args, **kwargs)

    monkeypatch.setattr(gitutil, "git", fake_git)
    monkeypatch.setattr(gitutil, "has_gh", lambda: True)
    monkeypatch.setattr(review, "_gh", gh)


def test_a_pull_request_whose_head_moved_is_recorded_and_not_merged(env, monkeypatch):
    # `gh pr merge` merges whatever the pull request points at now, not what was
    # pushed. Between create and merge anyone can push to the branch, and merging
    # on the state read at create publishes a commit nobody reviewed.
    world = make_world(remote="pr")
    repo = _seed(world)
    _stage(world)
    detail = review.detail(world, make_cfg(), PATTERN)

    seen: list[tuple] = []

    def gh(repo_arg, *args):
        seen.append(args)
        if args[:2] == ("pr", "list"):
            return json.dumps([{"number": 7, "url": "https://example.invalid/pr/7"}])
        if args[:2] == ("pr", "view"):
            return json.dumps({"headRefOid": "f" * 40})
        return ""

    _fake_remote(monkeypatch, gh)
    out = review.accept(world, make_cfg(), PATTERN, detail.reviewed_state)

    assert out["pr"] == 7
    assert "ffffffffffff" in out["remote_error"]
    assert not any(a[:2] == ("pr", "merge") for a in seen), seen
    # Merged locally all the same: the remote step never undoes the acceptance.
    assert (repo / "skills" / PATTERN / "SKILL.md").exists()


def test_an_unmoved_pull_request_is_merged(env, monkeypatch):
    world = make_world(remote="pr")
    repo = _seed(world)
    _stage(world)
    detail = review.detail(world, make_cfg(), PATTERN)

    seen: list[tuple] = []
    branch = run.branch_name(world.name, PATTERN)

    def gh(repo_arg, *args):
        seen.append(args)
        if args[:2] == ("pr", "list"):
            return json.dumps([{"number": 7, "url": "https://example.invalid/pr/7"}])
        if args[:2] == ("pr", "view"):
            return json.dumps({"headRefOid": gitutil.git(repo, "rev-parse", branch)})
        return ""

    _fake_remote(monkeypatch, gh)
    out = review.accept(world, make_cfg(), PATTERN, detail.reviewed_state)

    assert "remote_error" not in out, out
    assert any(a[:2] == ("pr", "merge") for a in seen), seen
