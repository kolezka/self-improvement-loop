"""The review and accept path: what a human sees, and what accepting it does.

Everything here works on the world's target repo. Two rules shape the module:

* Accept is bound to a digest of exactly what was rendered. The branch, its
  commit, the base and its commit all go into `reviewed_state`; if any of them
  moved since the preview, accept refuses rather than merging something nobody
  read.
* A branch may only carry its own artifact and the ledger, and the ledger row it
  changes is only its own. V1 published two unrelated commits inside a skill's
  pull request because the guard judged commit counts rather than paths.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path

from sil import artifacts, config, curriculum, gitutil, paths, store
from sil.models import (
    ArtifactRef, ArtifactType, Config, PromotionEntry, ReviewDetail, ReviewDiff,
    ReviewItem, RouterRow, World, now_iso,
)
from sil.run import branch_name

# A digest of the rendered review. The prefix keeps the hash domain-separated:
# nothing else in this project hashes the same JSON for a different purpose.
DIGEST_PREFIX = "sil.accept.review-state\n"

GH_TIMEOUT = 60
NET_TIMEOUT = 120


class ReviewError(ValueError):
    """A refusal the operator has to read and act on."""


@dataclass(frozen=True)
class Snapshot:
    """The immutable revisions behind one rendered review."""

    world: str
    repo: Path
    pattern: str
    branch: str
    branch_sha: str
    base_ref: str
    base_sha: str
    reviewed_state: str


def _ledger_rel(world: World) -> str:
    return world.layout.ledger.strip("/")


def _snapshot(world: World, repo: Path, default: str, pattern: str) -> Snapshot:
    """Resolve the moving refs once and bind their commits together.

    Everything downstream reads through the commit, never the branch name. A
    caller that hashed the branch and then read the body through the moving ref
    could describe one revision while rendering another.
    """
    branch = branch_name(world.name, pattern)
    branch_sha = gitutil.git(repo, "rev-parse", "--verify", f"{branch}^{{commit}}",
                             check=False)
    base_sha = gitutil.git(repo, "rev-parse", "--verify", f"{default}^{{commit}}",
                           check=False)
    digest = ""
    if branch_sha and base_sha:
        canonical = json.dumps({
            "base_ref": default,
            "base_sha": base_sha,
            "branch": branch,
            "branch_sha": branch_sha,
            "pattern": pattern,
            "repo": str(repo.resolve()),
            "version": 1,
            "world": world.name,
        }, sort_keys=True, separators=(",", ":"))
        digest = hashlib.sha256((DIGEST_PREFIX + canonical).encode("utf-8")).hexdigest()
    return Snapshot(world=world.name, repo=repo, pattern=pattern, branch=branch,
                    branch_sha=branch_sha, base_ref=default, base_sha=base_sha,
                    reviewed_state=digest)


def _branch_entry(world: World, repo: Path, ref: str,
                  pattern: str) -> PromotionEntry | None:
    """This pattern's ledger row as committed at `ref`, or None when unreadable."""
    found, raw = gitutil.show(repo, ref, _ledger_rel(world))
    if not found:
        return None
    try:
        return curriculum.parse_ledger(raw).entries.get(pattern)
    except Exception:  # noqa: BLE001 - a malformed ledger is an unknown ledger
        return None


def _entry_type(entry: PromotionEntry | None) -> str:
    """The type a branch's row actually describes, served_by first.

    They disagree in exactly the re-home case, where `served_by` is the new type
    and `artifact_type` may still be the old one.
    """
    if entry is None:
        return "skill"
    if entry.served_by is not None and entry.served_by.type != ArtifactType.none:
        return entry.served_by.type.value
    return entry.artifact_type.value


def _artifact_body(world: World, repo: Path, ref: str, artifact_type: str,
                   pattern: str) -> tuple[bool, str]:
    """(found, body) for this pattern's artifact at `ref`.

    For "rule" only the pattern's own tagged bullet, never the whole shared file:
    every pattern's rule lives in it, and returning it whole would render another
    world's boot contract as this pattern's body.
    """
    rel = artifacts.artifact_rel(world, artifact_type, pattern)
    if not rel:
        return artifact_type == "none", ""
    found, raw = gitutil.show(repo, ref, rel)
    if artifact_type == "rule":
        return found, (artifacts.rule_bullet_in_text(raw, pattern) if raw else "")
    return found, raw


def _foreign_paths(world: World, repo: Path, snapshot: Snapshot,
                   pattern: str) -> list[str]:
    """Files this branch changes that do not belong to `pattern`.

    Judged by path, never by commit count. A re-homed pattern legitimately
    carries several commits (each landing on top so the operator's override is
    not orphaned), and a count-based guard refused every migration while still
    letting two unrelated commits ride into a pull request because the shape it
    saw most often was one commit.
    """
    allowed = artifacts.allowed_paths(world, pattern)
    touched = gitutil.commit_paths(repo, snapshot.base_sha, snapshot.branch_sha)
    return sorted(set(touched) - allowed)


# --- read side ---------------------------------------------------------------

def queue(world: World, cfg: Config) -> list[ReviewItem]:
    """Every pattern staged for this world and not yet merged, staged rows first."""
    repo = config.target_root(world)
    if not gitutil.is_repo(repo):
        return []
    default = gitutil.default_branch(repo)
    prefix = f"curriculum/{world.name.casefold()}/"
    listing = gitutil.git(repo, "branch", "--list", f"{prefix}*", "--no-merged",
                          default, "--format=%(refname:short)", check=False)
    rows: list[ReviewItem] = []
    for line in listing.splitlines():
        branch = line.strip()
        if not branch.startswith(prefix):
            continue
        pattern = branch[len(prefix):]
        entry = _branch_entry(world, repo, branch, pattern)
        atype = _entry_type(entry)
        rows.append(ReviewItem(
            world=world.name, pattern=pattern, branch=branch,
            artifact_type=ArtifactType(atype),
            artifact_path=artifacts.artifact_rel(world, atype, pattern) or None,
            count=entry.promoted_at_count if entry else 0,
            staged_at=entry.last_updated if entry else None,
            commit=gitutil.git(repo, "rev-parse", "--short", branch, check=False) or None,
        ))
    rows.sort(key=lambda r: r.pattern)
    return rows


def detail(world: World, cfg: Config, pattern: str) -> ReviewDetail:
    """The body on the branch, its evidence, and whether accept is blocked."""
    repo = config.target_root(world)
    default = gitutil.default_branch(repo)
    snapshot = _snapshot(world, repo, default, pattern)
    if not snapshot.branch_sha:
        raise ReviewError(
            f"{snapshot.branch} has no resolvable commit; nothing to review")

    entry = _branch_entry(world, repo, snapshot.branch_sha, pattern)
    atype = _entry_type(entry)
    found, body = _artifact_body(world, repo, snapshot.branch_sha, atype, pattern)

    blocked = None
    if artifacts.is_placeholder_body(atype, body):
        blocked = (f"{snapshot.branch} still carries the re-home placeholder for "
                   f"{pattern!r} ({atype}); no real draft has been written yet. "
                   f"Wait for the next run to redraft it, or reject and re-route.")
    else:
        foreign = _foreign_paths(world, repo, snapshot, pattern)
        if foreign:
            blocked = (f"{snapshot.branch} changes {len(foreign)} file(s) that do "
                       f"not belong to {pattern!r}: {', '.join(foreign)}. Commit "
                       f"them separately, then accept.")

    sources = [r.id for r in curriculum.reflections(world) if r.pattern == pattern]
    return ReviewDetail(
        world=world.name, pattern=pattern, branch=snapshot.branch,
        artifact_type=ArtifactType(atype),
        artifact_path=artifacts.artifact_rel(world, atype, pattern) or None,
        count=entry.promoted_at_count if entry else 0,
        staged_at=entry.last_updated if entry else None,
        commit=snapshot.branch_sha[:12],
        body=body if found else "",
        sources=sources,
        reviewed_state=snapshot.reviewed_state,
        accept_blocked=blocked,
    )


def diff(world: World, cfg: Config, pattern: str) -> ReviewDiff:
    """What accepting this exact commit would change on the default branch."""
    repo = config.target_root(world)
    default = gitutil.default_branch(repo)
    snapshot = _snapshot(world, repo, default, pattern)
    if not snapshot.branch_sha or not snapshot.base_sha:
        raise ReviewError(f"{snapshot.branch} has no resolvable commit; no diff")
    text = gitutil.git(repo, "diff", f"{snapshot.base_sha}...{snapshot.branch_sha}",
                       check=False)
    return ReviewDiff(world=world.name, pattern=pattern, diff=text,
                      reviewed_state=snapshot.reviewed_state)


def inventory(world: World, cfg: Config) -> list[RouterRow]:
    """Every pattern the ledger knows, joined with live counts and scorecards."""
    ledger = curriculum.load_ledger(world)
    counts: dict[str, int] = {}
    for reflection in curriculum.reflections(world):
        counts[reflection.pattern] = counts.get(reflection.pattern, 0) + 1
    cards = curriculum._scorecard_by_pattern(curriculum.scorecards(world))
    rows = []
    for pattern, entry in sorted(ledger.entries.items()):
        rows.append(RouterRow(
            pattern=pattern,
            artifact_type=entry.artifact_type,
            served_by=entry.served_by.path if entry.served_by else None,
            status=entry.status,
            reflections=counts.get(pattern, 0),
            scorecard=cards.get(pattern),
        ))
    return rows


# --- write side --------------------------------------------------------------

def _require_live_ready(world: World, repo: Path, default: str) -> None:
    """The live checkout must be able to take a fast-forward.

    Refusing rather than working around it: moving someone else's HEAD, or
    merging under their uncommitted edits, is not this operation's call.
    """
    branch = gitutil.current_branch(repo)
    if branch != default:
        raise ReviewError(
            f"{repo} is on {branch or 'a detached HEAD'}, not {default}. Check "
            f"{default} out and retry; nothing was changed.")
    dirty = gitutil.dirty_paths(repo, artifacts.artifact_prefixes(world))
    if dirty:
        raise ReviewError(
            f"{repo} has uncommitted changes under {', '.join(dirty)}. Commit or "
            f"discard them and retry; nothing was changed.")


def accept(world: World, cfg: Config, pattern: str, reviewed_state: str) -> dict:
    """Merge the reviewed branch into the default branch and make it active.

    The digest is recomputed here rather than trusted, so a branch that moved
    between the preview and the click is refused. Every guard runs before the
    first write, so a refusal leaves nothing to unwind.
    """
    repo = config.target_root(world)
    if not gitutil.is_repo(repo):
        raise ReviewError(f"{repo} is not a git repository")
    default = gitutil.default_branch(repo)
    snapshot = _snapshot(world, repo, default, pattern)
    if not snapshot.branch_sha:
        raise ReviewError(f"{snapshot.branch} has no resolvable commit; nothing to accept")
    if not reviewed_state or reviewed_state != snapshot.reviewed_state:
        raise ReviewError(
            "reviewed state changed since preview; reload the review and accept again")

    entry = _branch_entry(world, repo, snapshot.branch_sha, pattern)
    atype = _entry_type(entry)
    _, body = _artifact_body(world, repo, snapshot.branch_sha, atype, pattern)
    if artifacts.is_placeholder_body(atype, body):
        raise ReviewError(
            f"{snapshot.branch} still carries the re-home placeholder for "
            f"{pattern!r} ({atype}); no real draft has been written yet")
    foreign = _foreign_paths(world, repo, snapshot, pattern)
    if foreign:
        raise ReviewError(
            f"{snapshot.branch} changes {len(foreign)} file(s) that do not belong "
            f"to {pattern!r}: {', '.join(foreign)}. Accepting would publish them "
            f"inside this artifact's review. Commit them separately, then accept.")
    _require_live_ready(world, repo, default)

    ledger_rel = _ledger_rel(world)
    with gitutil.scratch_worktree(repo, snapshot.branch, default) as tree:
        if not _is_ancestor(repo, snapshot.base_sha, snapshot.branch_sha):
            _merge_base_into_branch(tree, snapshot, ledger_rel)
        # The default branch's ledger is the record of what has been accepted;
        # this acceptance adds exactly one row to it. Read from the blob at the
        # base, so a branch written before the one-row rule cannot drag its
        # siblings in and burn patterns a human already refused.
        merged = _ledger_at(world, repo, snapshot.base_sha)
        row = entry or merged.entries.get(pattern)
        if row is not None:
            merged.entries[pattern] = row.model_copy(update={
                "status": "promoted",
                "commit": snapshot.branch_sha[:12],
                "last_updated": now_iso(),
            })
        store.save_ledger(tree / ledger_rel, merged)
        gitutil.git(tree, "add", "--", ledger_rel)
        gitutil.git(tree, "commit", "-q", "-m",
                    f"feat({atype}): {pattern} (reviewed)")
        prepared = gitutil.git(tree, "rev-parse", "HEAD")

    gitutil.git(repo, "merge", "-q", "--ff-only", snapshot.branch)

    # Past this line the artifact is on the default branch. Nothing below may
    # report a hard failure: an error here would contradict a repo that already
    # carries it. Every remaining step records its own problem instead.
    out: dict = {"merged": snapshot.branch, "pattern": pattern,
                 "artifact_type": atype, "commit": prepared[:12]}
    try:
        linked = relink(world, pattern, atype)
        out["linked"] = str(linked) if linked else None
    except Exception as e:  # noqa: BLE001 - merged already; a link problem is a warning
        out["linked"] = None
        out["link_error"] = str(e)

    _publish(world, repo, default, snapshot.branch, pattern, atype, out)

    gitutil.git(repo, "branch", "-q", "-D", snapshot.branch, check=False)
    gone = not gitutil.ref_exists(repo, f"refs/heads/{snapshot.branch}")
    out["branch_deleted"] = gone
    if not gone:
        # A merged branch that survives keeps showing in the review queue, so say
        # so rather than let it look accepted and pending at the same time.
        out["branch_error"] = f"{snapshot.branch} is merged but could not be deleted"
    return out


def _is_ancestor(repo: Path, ancestor: str, descendant: str) -> bool:
    proc = subprocess.run(
        ["git", "merge-base", "--is-ancestor", ancestor, descendant],
        cwd=str(repo), capture_output=True, text=True, timeout=gitutil.DEFAULT_TIMEOUT)
    return proc.returncode == 0


def _merge_base_into_branch(tree: Path, snapshot: Snapshot, ledger_rel: str) -> None:
    """Bring the default branch into the staged branch, in the scratch worktree.

    Two branches that both add the ledger have no common ancestor for it, so git
    calls the second acceptance an add/add conflict. That is the ordinary shape
    of accepting a second artifact, not a failure, and it is resolved by the
    ledger rewrite that follows. Anything else conflicting is a human decision.
    """
    try:
        gitutil.git(tree, "merge", "--no-ff", "--no-commit", "-q", snapshot.base_sha)
    except gitutil.GitError:
        conflicted = [p for p in gitutil.git(
            tree, "diff", "--name-only", "--diff-filter=U", check=False).splitlines()
            if p.strip()]
        if not conflicted:
            # Not a conflict at all: an unreadable index, a bad ref. There is no
            # merge in progress, so `merge --abort` would replace git's real
            # reason with "no merge to abort".
            raise
        if conflicted != [ledger_rel]:
            gitutil.git(tree, "merge", "--abort", check=False)
            raise ReviewError(
                f"{snapshot.branch} conflicts outside the ledger: "
                f"{', '.join(conflicted)}") from None


def _ledger_at(world: World, repo: Path, ref: str):
    found, raw = gitutil.show(repo, ref, _ledger_rel(world))
    if not found:
        return curriculum.parse_ledger("{}")
    try:
        return curriculum.parse_ledger(raw)
    except Exception:  # noqa: BLE001 - an unreadable base ledger starts empty
        return curriculum.parse_ledger("{}")


def reject(world: World, cfg: Config, pattern: str) -> dict:
    """Record the refusal on the default branch, then delete the branch.

    Ledger first, branch second. Interrupted the other way the branch is gone
    with nothing recorded, which is exactly the treadmill this fixes: in V1
    rejecting changed nothing, so three artifacts refused at 13:00 were re-staged
    byte-identical by 15:05. This way the worst case is a recorded rejection
    whose branch survives, which stays in the queue and can be rejected again.

    The watermark costs the same as a promotion: `threshold` new reflections
    before the pattern can be proposed again, never a permanent veto. A lesson
    can genuinely improve on a second attempt.
    """
    repo = config.target_root(world)
    default = gitutil.default_branch(repo)
    snapshot = _snapshot(world, repo, default, pattern)
    if not snapshot.branch_sha:
        raise ReviewError(f"{snapshot.branch} has no resolvable commit; nothing to reject")
    _require_live_ready(world, repo, default)

    branch_row = _branch_entry(world, repo, snapshot.branch_sha, pattern)
    at = len([r for r in curriculum.reflections(world) if r.pattern == pattern])
    ledger_rel = _ledger_rel(world)

    def mutate(tree: Path) -> list[str]:
        ledger = store.load_ledger(tree / ledger_rel)
        prior = ledger.entries.get(pattern)
        if prior is not None:
            # Only the watermark moves. `prior` describes what is already on the
            # default branch, so its type and served_by still hold after the
            # refusal; overwriting them with the branch's would make the ledger
            # describe a file this rejection just threw away.
            ledger.entries[pattern] = prior.model_copy(update={
                "rejected_at_count": at, "last_updated": now_iso()})
        else:
            # Never promoted, so nothing serves this pattern now. `served_by` is
            # deliberately not recovered from the branch: `run()` reads it as a
            # forced route, which would re-impose the very shape a human refused
            # the moment the pattern earned its way back past the watermark.
            ledger.entries[pattern] = PromotionEntry(
                pattern=pattern, promoted_at_count=0, rejected_at_count=at,
                status="rejected",
                artifact_type=ArtifactType(_entry_type(branch_row)),
                served_by=None, last_updated=now_iso())
        store.save_ledger(tree / ledger_rel, ledger)
        return [ledger_rel]

    sha = _commit_on_default(world, repo, default, mutate,
                             f"chore(curriculum): reject {pattern}")
    gitutil.git(repo, "branch", "-q", "-D", snapshot.branch, check=False)
    return {"pattern": pattern, "deleted": snapshot.branch,
            "sha": snapshot.branch_sha, "rejected_at_count": at, "commit": sha[:12]}


def _commit_on_default(world: World, repo: Path, default: str, mutate,
                       message: str) -> str:
    """One commit onto the default branch, written in a throwaway worktree.

    The live checkout holds the default branch, and git refuses a second worktree
    on the same branch, so the commit is made on a scratch ref and fast-forwarded
    in. The operator's tree only ever sees a fast-forward.
    """
    _require_live_ready(world, repo, default)
    scratch = f"sil-scratch/{uuid.uuid4().hex[:8]}"
    gitutil.git(repo, "branch", scratch, default)
    try:
        with gitutil.scratch_worktree(repo, scratch, default) as tree:
            touched = mutate(tree)
            if not touched:
                raise ReviewError(f"nothing to commit for {message!r}")
            gitutil.git(tree, "add", "--", *touched)
            gitutil.git(tree, "commit", "-q", "-m", message)
            sha = gitutil.git(tree, "rev-parse", "HEAD")
        gitutil.git(repo, "merge", "-q", "--ff-only", scratch)
        return sha
    finally:
        gitutil.git(repo, "branch", "-q", "-D", scratch, check=False)


def _stage_on_branch(world: World, repo: Path, pattern: str, mutate) -> str:
    """One commit onto `curriculum/<world>/<pattern>`, never merged.

    `mutate(tree)` returns `(paths_to_add, commit_message)`. The message comes
    out of the mutation rather than in, because it names the artifact type, and
    the type is only known once the ledger inside the checkout has been read.

    An existing branch is landed on top of rather than reset: rehome and retire
    are one-off operator actions that can hit a pattern with a genuinely pending,
    part-reviewed draft, and resetting would orphan that commit where nothing but
    the reflog could find it.

    The ledger is read inside the checkout, never before it. A pattern that is
    only staged has no row on the default branch at all, so reading the live tree
    would report "not in the ledger" for exactly the pending rows these actions
    exist to serve.
    """
    default = gitutil.default_branch(repo)
    branch = branch_name(world.name, pattern)
    with gitutil.scratch_worktree(repo, branch, default) as tree:
        touched, message = mutate(tree)
        if not touched:
            raise ReviewError(f"{pattern!r}: nothing to commit on {branch}")
        gitutil.git(tree, "add", "--", *touched)
        gitutil.git(tree, "commit", "-q", "-m", message)
    return branch


def rehome(world: World, cfg: Config, pattern: str, artifact_type: str) -> dict:
    """Stage this pattern onto a different artifact type, on its own branch.

    Stages only. The human's override is an input to the next draft, not an
    approval of a result, and accept is still the only thing that moves anything
    onto the default branch.

    No drafter runs here. What lands is a schema-valid stub, and the ledger's
    `served_by` flip is what makes the next run redraft into the chosen type
    through the same pipeline every other promotion uses.
    """
    repo = config.target_root(world)
    ledger_rel = _ledger_rel(world)
    result: dict = {}

    def mutate(tree: Path) -> list[str]:
        ledger = store.load_ledger(tree / ledger_rel)
        entry = ledger.entries.get(pattern)
        if entry is None:
            raise ReviewError(f"{pattern!r} is not in the ledger; nothing to re-home")
        old_type = _entry_type(entry)
        if old_type == artifact_type:
            raise ReviewError(f"{pattern!r} is already served by {artifact_type!r}")
        touched: list[str] = []
        removed = artifacts.remove_artifact(world, old_type, pattern, root=tree)
        if removed:
            touched.append(removed)
        if artifact_type == "rule":
            artifacts.ensure_rules_file(world, root=tree)
        artifacts.write_artifact(
            world, artifact_type, pattern,
            artifacts.placeholder_body(pattern, artifact_type, old_type), root=tree)
        new_rel = artifacts.artifact_rel(world, artifact_type, pattern)
        if new_rel:
            touched.append(new_rel)
        ledger.entries[pattern] = entry.model_copy(update={
            "artifact_type": ArtifactType(artifact_type),
            "served_by": ArtifactRef(type=ArtifactType(artifact_type), path=new_rel),
            "status": "staged",
            "last_updated": now_iso(),
        })
        store.save_ledger(tree / ledger_rel, ledger)
        touched.append(ledger_rel)
        result["path"] = new_rel
        return touched, f"feat({artifact_type}): re-home {pattern} (auto, gated)"

    branch = _stage_on_branch(world, repo, pattern, mutate)
    return {"branch": branch, "pattern": pattern, "artifact_type": artifact_type,
            "path": result.get("path", "")}


def retire(world: World, cfg: Config, pattern: str) -> dict:
    """Delete the artifact and mark the ledger row retired, staged on its branch.

    Deletes rather than flags. An artifact left on disk with only a ledger flag
    still appears in the available-skills list and still costs attention on every
    session, which is the entire cost being removed. Git is the trail.
    """
    repo = config.target_root(world)
    ledger_rel = _ledger_rel(world)
    result: dict = {}

    def mutate(tree: Path) -> list[str]:
        ledger = store.load_ledger(tree / ledger_rel)
        entry = ledger.entries.get(pattern)
        if entry is None:
            raise ReviewError(f"{pattern!r} is not in the ledger; nothing to retire")
        if entry.status == "retired":
            raise ReviewError(f"{pattern!r} is already retired")
        old_type = _entry_type(entry)
        removed = artifacts.remove_artifact(world, old_type, pattern, root=tree)
        ledger.entries[pattern] = entry.model_copy(update={
            "status": "retired", "served_by": None, "last_updated": now_iso()})
        store.save_ledger(tree / ledger_rel, ledger)
        result["removed"] = removed
        result["type"] = old_type
        return (([removed] if removed else []) + [ledger_rel],
                f"feat({old_type}): retire {pattern} (auto, gated)")

    branch = _stage_on_branch(world, repo, pattern, mutate)
    return {"branch": branch, "pattern": pattern, "removed": result.get("removed", "")}


# --- making an accepted artifact active --------------------------------------

def relink(world: World, pattern: str, artifact_type: str) -> Path | None:
    """Symlink an accepted skill or agent into the Claude config directory.

    Accepting means "make it active", not "record it in git": in V1 an accepted
    skill stayed inert until somebody remembered to run install.sh.

    Hooks need nothing, because the dispatcher reads the world's nudges directory
    directly, and a rule is injected at SessionStart.

    A real directory or file at the link path is never replaced. `ln -sfn` over a
    directory creates the link INSIDE it, leaving `skills/<name>/<name>` that no
    agent ever reads, and overwriting a hand-written one loses work with no git
    history to recover it from.
    """
    if artifact_type not in ("skill", "agent"):
        return None
    target = config.target_root(world)
    rel = artifacts.artifact_rel(world, artifact_type, pattern)
    if artifact_type == "skill":
        source = (target / rel).parent
        link = paths.claude_config_dir() / "skills" / pattern
    else:
        source = target / rel
        link = paths.claude_config_dir() / "agents" / f"{pattern}.md"

    link.parent.mkdir(parents=True, exist_ok=True)
    if link.is_symlink():
        current = Path(os.readlink(link))
        if not source.exists():
            link.unlink()          # the artifact was retired; reap the dead link
            return None
        if current == source:
            return link
        link.unlink()
    elif link.exists():
        raise ReviewError(
            f"{link} already exists and is not a symlink; refusing to replace it. "
            f"Move it aside and relink.")
    if not source.exists():
        return None
    link.symlink_to(source, target_is_directory=(artifact_type == "skill"))
    return link


# --- remote --------------------------------------------------------------

def _publish(world: World, repo: Path, default: str, branch: str, pattern: str,
             artifact_type: str, out: dict) -> None:
    """Push or open a pull request, per the world's `remote` setting.

    Runs past the merge boundary, so every failure is recorded in `out` and none
    of them raises: the artifact is already on the default branch and an
    exception here would contradict that.
    """
    if world.remote == "none":
        return
    if world.remote == "push":
        try:
            gitutil.git(repo, "push", "-q", "origin", default, timeout=NET_TIMEOUT)
            out["pushed"] = default
        except gitutil.GitError as e:
            out["remote_error"] = f"merged locally, not pushed: {e}"
        return

    if not gitutil.has_gh():
        out["remote_error"] = (
            "gh not found on PATH; the artifact is merged locally but no pull "
            "request was opened")
        return
    try:
        gitutil.git(repo, "push", "-q", "-u", "origin", branch, timeout=NET_TIMEOUT)
        title = f"feat({artifact_type}): {pattern} (reviewed)"
        body = (f"Promotes `{pattern}` from the curriculum loop in world "
                f"`{world.name}`. Reviewed in the loop UI: the artifact body, its "
                f"source reflections and the full diff.")
        _gh(repo, "pr", "create", "--base", default, "--head", branch,
            "--title", title, "--body", body)
        number = json.loads(_gh(repo, "pr", "list", "--head", branch, "--base",
                                default, "--state", "open", "--json", "number,url",
                                "--limit", "1") or "[]")
        if not number:
            out["remote_error"] = f"opened a pull request for {branch} but could not read it back"
            return
        out["pr"] = number[0]["number"]
        out["pr_url"] = number[0]["url"]
        _gh(repo, "pr", "merge", str(out["pr"]), "--merge")
    except Exception as e:  # noqa: BLE001 - already merged locally; this is a warning
        out["remote_error"] = f"merged locally, but the pull request step failed: {e}"


def _gh(repo: Path, *args: str) -> str:
    exe = shutil.which("gh")
    if exe is None:
        raise ReviewError("gh not found on PATH")
    env = dict(os.environ)
    env["GH_PROMPT_DISABLED"] = "1"
    env["GH_NO_UPDATE_NOTIFIER"] = "1"
    env["GIT_TERMINAL_PROMPT"] = "0"
    proc = subprocess.run([exe, *args], cwd=str(repo), capture_output=True,
                          text=True, env=env, timeout=GH_TIMEOUT)
    if proc.returncode != 0:
        raise ReviewError(f"gh {' '.join(args)}: {proc.stderr.strip() or 'failed'}")
    return proc.stdout.strip()
