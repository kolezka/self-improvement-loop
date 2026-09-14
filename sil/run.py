"""The curriculum run: plan, draft, route, gate, stage.

Gate order per pattern is route, rule writability, artifact lint, repo integrity,
judge, stage. The free gates run first, and all of them run before anything is
written, so there is no write-then-undo dance.

Two properties hold for every path through this module:

* it never pushes, and
* it never touches the operator's checkout. Staging happens in a scratch worktree
  of the target repo, so a failure cannot move HEAD or leave an uncommitted
  artifact behind. V1 checked branches out in the live tree and needed a
  never-raising recovery block to undo it; there is nothing to undo here.
"""

from __future__ import annotations

import importlib
import re
from pathlib import Path

from sil import artifacts, config, curriculum, gitutil, lint, paths, prompts, router, store
from sil.models import (
    ArtifactRef, ArtifactType, Config, PromotionEntry, RunReport, World, now_iso,
)

_RULE_TAG_RE = re.compile(r"<!--rule:([A-Za-z0-9][A-Za-z0-9-]*)-->")


def branch_name(world: str, pattern: str) -> str:
    """`curriculum/<world>/<pattern>`, world segment casefolded.

    Git cannot hold `curriculum/x` and `curriculum/x/y` at once, so the world
    segment is never optional. Casefolded at this one construction site: refs are
    case-sensitive, a world is spelled both ways by different config files, and
    the day this was missing V1 staged `curriculum/Inkitt/<p>` while the review
    pane globbed `curriculum/inkitt/*` and reported nothing pending.
    """
    return f"curriculum/{world.casefold()}/{pattern}"


def _default_chat():
    return importlib.import_module("sil.providers").chat


def _describe(e: BaseException) -> str:
    return f"{type(e).__name__}: {str(e)[:160]}"


def _drafted_type(answer: router.RouteAnswer) -> str:
    """The body shape the drafter committed to, before the router validates it."""
    if answer.trigger_event != "none" and answer.gate is not None:
        return "hook"
    if answer.needs_own_context:
        return "agent"
    if answer.capability_evidence is not None:
        return "skill"
    return "rule"


def _branch_entry(world: World, repo: Path, branch: str,
                  pattern: str) -> PromotionEntry | None:
    """This pattern's ledger entry as committed on `branch`, or None.

    None means "cannot tell": no such ref, or a ledger git or json refuses. Every
    caller treats that as "do the work". Reading an unreadable file as "already
    done" would strand a pattern behind one corrupt commit forever.
    """
    if not gitutil.ref_exists(repo, f"refs/heads/{branch}"):
        return None
    found, raw = gitutil.show(repo, branch, world.layout.ledger.strip("/"))
    if not found:
        return None
    try:
        return curriculum.parse_ledger(raw).entries.get(pattern)
    except Exception:  # noqa: BLE001 - a malformed ledger is an unknown ledger
        return None


def _served_by(staged: PromotionEntry | None,
               prior: PromotionEntry | None) -> ArtifactRef | None:
    """What artifact type already serves this pattern, branch first.

    A re-home stages `served_by` on the branch and never on the default branch,
    which only learns it at accept. Reading the default branch alone made every
    re-home invisible to `run()`: the pattern re-routed from scratch, drafted the
    old shape, and the branch reset orphaned the operator's override on the next
    tick.
    """
    if staged is not None and staged.served_by is not None:
        return staged.served_by
    return prior.served_by if prior is not None else None


def _foreign_rule_tags(repo: Path, base: str, rel: str, pattern: str) -> list[str]:
    """Other patterns' rule tags this branch's `rel` diff touches.

    `rule` is the only type where every pattern shares one file, so a stray
    bullet left on disk by an earlier iteration would be committed alongside this
    one, invisibly: the branch's ledger names only this pattern, and accepting it
    would merge a rule nobody reviewed. Writing in a fresh worktree is what
    prevents that; this is the lock that refuses to stage if it ever happens again.
    """
    tags: set[str] = set()
    for line in gitutil.git(repo, "diff", base, "--", rel, check=False).splitlines():
        if line[:1] in "+-" and not line.startswith(("+++", "---")):
            tags.update(_RULE_TAG_RE.findall(line))
    return sorted(tags - {pattern})


def run(world: World, cfg: Config, *, apply: bool, chat=None,
        extra_dirs: list[Path] | None = None, cards=None) -> RunReport:
    """One curriculum tick for one world.

    A dry run mutates nothing at all: no repo is created, no provider is called,
    no branch is written. It reports what a real run would attempt.
    """
    report = RunReport(world=world.name, dry_run=not apply)
    target = config.target_root(world)
    items = curriculum.reflections(world, extra_dirs)
    groups = curriculum.cluster(items)
    plan = curriculum.plan(world, cfg, extra_dirs=extra_dirs, cards=cards, items=items)

    actionable = []
    for action in plan.actions:
        if action.action == "below-threshold":
            report.dropped[action.pattern] = action.count
        elif action.action == "over-cap":
            report.gated_out[action.pattern] = action.reason or "over per-run cap"
        elif action.action in ("promote", "refine"):
            actionable.append(action)
        # `done` is silent, and `retire-candidate` is a proposal for a human that
        # this function deliberately never executes.

    if not apply:
        report.staged = [a.pattern for a in actionable]
        report.finished = now_iso()
        return report

    if not gitutil.is_repo(target):
        if target.resolve() == paths.default_target(world.name).resolve():
            gitutil.ensure_repo(target)
        else:
            report.error = (f"{target} is not a git repository; point the world's "
                            f"`target` at one or clear it to use the built-in "
                            f"learned/ repo")
            report.finished = now_iso()
            return report

    chat = chat or _default_chat()
    default = gitutil.default_branch(target)
    payloads = curriculum.load_payload_corpus(world)
    ledger = curriculum.load_ledger(world)
    ledger_rel = world.layout.ledger.strip("/")

    for action in actionable:
        try:
            _stage_one(world, cfg, report, action, groups[action.pattern], chat,
                       target=target, default=default, payloads=payloads,
                       ledger=ledger, ledger_rel=ledger_rel)
        except Exception as e:  # noqa: BLE001 - one pattern's failure is not the run's
            report.gated_out[action.pattern] = f"staging failed: {_describe(e)}"

    report.finished = now_iso()
    return report


def _stage_one(world, cfg, report, action, items, chat, *, target, default,
               payloads, ledger, ledger_rel) -> None:
    pattern = action.pattern
    sources_text = curriculum.sources_text(items)
    lessons = curriculum.lesson_texts(items)
    if action.action == "refine" and action.reason:
        # The misfire reasons travel with the evidence, so the redraft is told
        # what was wrong with the artifact it is replacing.
        lessons.append(f"Artifact feedback: {action.reason}")

    branch = branch_name(world.name, pattern)
    prior = ledger.entries.get(pattern)
    staged_entry = _branch_entry(world, target, branch, pattern)
    served = _served_by(staged_entry, prior)
    forced_type = served.type.value if served is not None else None
    if forced_type == "none":
        # A served_by of "none" has no shape to draft and no file to write.
        # Treated as "not served" rather than a veto: in V1 it was the one state
        # with no way back, and a pattern sat on it for 28 consecutive runs.
        forced_type = None

    existing = (artifacts.read_artifact(world, forced_type, pattern) or None
                if forced_type else None)
    if existing and artifacts.is_placeholder_body(forced_type, existing):
        # A stub is not a draft to refine. Handed one as `existing`, the prompt
        # flips to "refine" and the drafter keeps the structural keys it was
        # given, so a placeholder's always-fire gate silently becomes the real one.
        existing = None

    # A forced rule is the one case where the type is known before drafting, so
    # the writability check is free here. On a target with no marker pair that
    # saves a provider call whose answer never changes.
    if forced_type == "rule":
        problem = _rule_problem(world)
        if problem:
            report.gated_out[pattern] = f"rule target not writable: {problem}"
            return

    try:
        raw = chat("drafter",
                   prompts.draft_messages(pattern, lessons, existing, forced_type),
                   world=world, json_mode=True)
    except Exception as e:  # noqa: BLE001 - a provider failure gates one pattern
        report.gated_out[pattern] = f"draft failed: {_describe(e)}"
        return
    body, answer = prompts.parse_draft(raw, forced_type=forced_type)

    if forced_type is not None:
        routed_type = forced_type
        routed_reason = "already served by this artifact"
    else:
        result = router.route(answer, sources_text, payloads)
        routed_type, routed_reason = result.artifact_type, result.reason

    if routed_type == "none":
        report.gated_out[pattern] = f"router: {routed_reason}"
        return

    if routed_type == "rule":
        problem = _rule_problem(world)
        if problem:
            report.gated_out[pattern] = f"rule target not writable: {problem}"
            return

    # The router can disagree with the shape the drafter committed to. Redraft
    # once in the type that survived, rather than feeding a mismatched body to a
    # lint that can only ever fail.
    if forced_type is None and routed_type != _drafted_type(answer):
        try:
            raw = chat("drafter",
                       prompts.draft_messages(pattern, lessons, None, routed_type),
                       world=world, json_mode=True)
        except Exception as e:  # noqa: BLE001 - isolate the provider failure again
            report.gated_out[pattern] = (
                f"redraft failed after the router selected {routed_type} "
                f"({routed_reason}): {_describe(e)}")
            return
        body, _ = prompts.parse_draft(raw, forced_type=routed_type)

    problems = lint.lint(routed_type, body, pattern, sources_text)
    if problems:
        reason = "artifact-lint: " + "; ".join(problems)
        if forced_type is None:
            reason += f"; router: {routed_reason}"
        report.gated_out[pattern] = reason
        return

    dirty = gitutil.dirty_paths(target, artifacts.artifact_prefixes(world))
    if dirty:
        report.gated_out[pattern] = (
            f"repo integrity: uncommitted changes under a routed artifact path "
            f"({', '.join(dirty)}); commit or discard them")
        return

    judge_body = body if isinstance(body, str) else _hook_text(body)
    try:
        verdict_raw = chat("judge",
                           prompts.judge_messages(pattern, routed_type, judge_body, lessons),
                           world=world, json_mode=True)
    except Exception as e:  # noqa: BLE001 - a provider failure is not an approval
        report.gated_out[pattern] = f"judge failed: {_describe(e)}"
        return
    passed, why = prompts.parse_verdict(verdict_raw)
    if not passed:
        report.gated_out[pattern] = f"judge: {why}"
        return

    rel = artifacts.artifact_rel(world, routed_type, pattern)
    auto_merge = cfg.promotion.auto_merge and world.llm != "local"
    entry = PromotionEntry(
        pattern=pattern,
        promoted_at_count=action.count,
        rejected_at_count=prior.rejected_at_count if prior is not None else 0,
        status="promoted" if auto_merge else "staged",
        artifact_type=ArtifactType(routed_type),
        served_by=ArtifactRef(type=ArtifactType(routed_type), path=rel),
        last_updated=now_iso(),
    )

    # An ordinary redraft starts from the default branch, exactly as a reset
    # would. A branch carrying an operator's re-home is preserved and landed on
    # top of, because resetting it would orphan the commit they reviewed.
    preserve = staged_entry is not None and staged_entry.served_by is not None
    if gitutil.ref_exists(target, f"refs/heads/{branch}") and not preserve:
        gitutil.git(target, "branch", "-q", "-f", branch, default)

    verb = "refine" if action.action == "refine" else "promote"
    message = f"feat({routed_type}): {verb} {pattern} (auto, gated)"
    with gitutil.scratch_worktree(target, branch, default) as tree:
        if routed_type == "rule":
            artifacts.ensure_rules_file(world, root=tree)
        artifacts.write_artifact(world, routed_type, pattern, body, root=tree)
        if routed_type == "rule":
            foreign = _foreign_rule_tags(tree, default, rel, pattern)
            if foreign:
                raise RuntimeError(
                    f"{rel} also changes rule(s) for {', '.join(foreign)}")
        tree_ledger = store.load_ledger(tree / ledger_rel)
        # Only this pattern's row is written. Branches are reviewed
        # independently, so one may never claim another's promotion.
        tree_ledger.entries[pattern] = entry
        store.save_ledger(tree / ledger_rel, tree_ledger)
        gitutil.git(tree, "add", "--", rel, ledger_rel)
        gitutil.git(tree, "commit", "-q", "-m", message)
        sha = gitutil.git(tree, "rev-parse", "HEAD")

    entry.commit = sha[:12]
    # Kept in memory so later patterns in this run see the watermark, and
    # deliberately never written to the live tree: a staged artifact's ledger
    # exists only on its branch. Writing it here would drop an untracked
    # promotions.json claiming a promotion no human accepted, and the next run
    # would read that watermark and skip the pattern forever.
    ledger.entries[pattern] = entry
    report.staged.append(pattern)

    if auto_merge:
        _auto_merge(report, target, default, branch, pattern)


def _auto_merge(report, target: Path, default: str, branch: str, pattern: str) -> None:
    """Fast-forward the staged branch into the default branch, in the live repo.

    Opt-in, and never reached for an `llm: local` world: the on-machine judge
    accepted 3 of 4 adversarial-but-lint-clean drafts, including one advising
    that unverified incident numbers be published, for which it fabricated a
    supporting source quote.
    """
    if gitutil.current_branch(target) != default:
        report.gated_out[pattern] = (
            f"staged on {branch}; auto-merge needs {default} checked out, and the "
            f"target is on {gitutil.current_branch(target) or 'an unknown branch'}")
        return
    try:
        gitutil.git(target, "merge", "-q", "--ff-only", branch)
    except gitutil.GitError as e:
        report.gated_out[pattern] = f"staged on {branch}; auto-merge failed: {e}"
        return
    report.merged.append(pattern)


def _rule_problem(world: World) -> str | None:
    """Whether a rule write would refuse, checked read-only against the live target.

    Read-only is the point: running the writer to find out would mutate the
    operator's file before the scratch worktree exists. A missing file in the
    built-in learned/ repo is not a problem, because the write creates it inside
    the worktree; a missing file anywhere else is, because the marker pair is how
    a repo opts in.
    """
    try:
        rules = config.target_root(world) / world.layout.rules_file.strip("/")
        if not rules.exists():
            if artifacts.owns_rules_file(world):
                return None
            return (f"{rules} does not exist; add it with a "
                    f"{artifacts.RULE_START} / {artifacts.RULE_END} marker pair to "
                    f"opt this repo into rule writes")
        return artifacts.rules_problem(world)
    except Exception as e:  # noqa: BLE001 - a broken pre-check gates, never crashes
        return f"could not check writability: {_describe(e)}"


def _hook_text(body) -> str:
    return str(body.get("text", "")) if isinstance(body, dict) else str(body)
