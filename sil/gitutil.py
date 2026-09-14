"""Thin git helpers. Every subprocess call in the curriculum and review paths
goes through here, so timeouts and error shape are decided once.

No call reaches the network. `review.py` does the two that do (push, gh) and
marks them as such.
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from contextlib import contextmanager
from pathlib import Path

# A local git command that has not answered in a minute is stuck, not slow.
DEFAULT_TIMEOUT = 60


class GitError(RuntimeError):
    """git exited non-zero. Carries git's own stderr: "would be overwritten by
    merge" and "not a git repository" need different actions from the operator."""


def git(repo: Path | str, *args: str, check: bool = True,
        timeout: int = DEFAULT_TIMEOUT) -> str:
    """Run git in `repo` and return stdout, stripped.

    `check=False` returns "" instead of raising. Use it only where a failure is
    the thing being tested for (does this ref exist) or where raising would undo
    work that already succeeded.
    """
    try:
        proc = subprocess.run(
            ["git", *args], cwd=str(repo), capture_output=True, text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        if not check:
            return ""
        raise GitError(f"git {' '.join(args)} timed out after {timeout}s") from None
    if proc.returncode != 0:
        if not check:
            return ""
        detail = (proc.stderr or proc.stdout or "").strip() or f"exited {proc.returncode}"
        raise GitError(f"git {' '.join(args)}: {detail}")
    return proc.stdout.strip()


def is_repo(path: Path | str) -> bool:
    p = Path(path)
    if not p.is_dir():
        return False
    return git(p, "rev-parse", "--git-dir", check=False) != ""


def head(repo: Path | str) -> str:
    return git(repo, "rev-parse", "HEAD", check=False)


def current_branch(repo: Path | str) -> str:
    return git(repo, "rev-parse", "--abbrev-ref", "HEAD", check=False)


def ref_exists(repo: Path | str, ref: str) -> bool:
    return git(repo, "rev-parse", "--verify", "--quiet", ref, check=False) != ""


def default_branch(repo: Path | str) -> str:
    """`main`, else `master`, else whatever is checked out.

    Asked of the repo rather than configured, because a world's target can be any
    repo the operator already has.
    """
    for name in ("main", "master"):
        if ref_exists(repo, f"refs/heads/{name}"):
            return name
    return current_branch(repo) or "main"


def ensure_repo(path: Path | str) -> Path:
    """Make `path` a git repo with one empty commit on `main`.

    Only for the built-in `learned/` target. A world pointing at a repo the
    operator maintains is never initialised here: creating a repo under someone
    else's path is not this code's call.
    """
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    if is_repo(p):
        return p
    git(p, "init", "-q", "-b", "main")
    git(p, "config", "user.email", "loop@self-improvement-loop.local")
    git(p, "config", "user.name", "self-improvement-loop")
    git(p, "config", "commit.gpgsign", "false")
    git(p, "commit", "-q", "--allow-empty", "-m", "chore: initialise learned repo")
    return p


def _hooks_off(work_dir: Path) -> list[str]:
    """`git -c` args pointing core.hooksPath at an empty directory.

    A post-checkout hook fires in every linked worktree, and a throwaway tree is
    the wrong place to trigger someone's build.
    """
    empty = work_dir.parent / "nohooks"
    empty.mkdir(parents=True, exist_ok=True)
    return ["-c", f"core.hooksPath={empty}"]


@contextmanager
def scratch_worktree(repo: Path | str, branch: str, base: str):
    """Check `branch` out in a throwaway worktree, never in the live checkout.

    An existing branch is checked out as is, so a commit lands on top of whatever
    a human already reviewed there. A missing one is created from `base`.

    The removal runs in `finally` on every path, including an exception raised by
    the body: a leaked registration makes every later `worktree add` fail on the
    same branch. `prune` runs after the temp dir is gone, which is the only state
    in which it can clean up a `remove --force` that itself failed.
    """
    repo = Path(repo)
    with tempfile.TemporaryDirectory(prefix="sil-wt-") as tmp:
        work_dir = Path(tmp) / "wt"
        try:
            if ref_exists(repo, f"refs/heads/{branch}"):
                git(repo, *_hooks_off(work_dir), "worktree", "add", "-q",
                    str(work_dir), branch)
            else:
                git(repo, *_hooks_off(work_dir), "worktree", "add", "-q", "-b",
                    branch, str(work_dir), base)
            yield work_dir
        finally:
            # --force: the body may have left a dirty or conflicted tree.
            git(repo, "worktree", "remove", "--force", str(work_dir), check=False)
    git(repo, "worktree", "prune", check=False)


def dirty_paths(repo: Path | str, prefix: str | list[str],
                *, include_untracked: bool = False) -> list[str]:
    """Repo-relative paths with uncommitted changes under `prefix`.

    Tracked changes only by default. An untracked file is a human's work in
    progress that no write of ours would clobber unless it sits exactly at the
    artifact path, and that case is guarded separately at the write.
    """
    prefixes = [prefix] if isinstance(prefix, str) else list(prefix)
    prefixes = [p for p in prefixes if p]
    if not prefixes:
        return []
    mode = "--untracked-files=all" if include_untracked else "--untracked-files=no"
    out = git(repo, "status", "--porcelain", "-z", mode, "--", *prefixes,
              check=False)
    return sorted(rec[3:] for rec in out.split("\0") if len(rec) > 3)


def commit_paths(repo: Path | str, base: str, ref: str) -> list[str]:
    """Files `ref` changes relative to the merge base with `base`."""
    out = git(repo, "diff", "--name-only", f"{base}...{ref}", check=False)
    return sorted(line for line in out.splitlines() if line.strip())


def show(repo: Path | str, ref: str, rel: str) -> tuple[bool, str]:
    """(found, text) for one blob. A failed read is not an empty file: a caller
    that conflated the two reported every unreadable artifact as a stale branch."""
    proc = subprocess.run(
        ["git", "show", f"{ref}:{rel}"], cwd=str(repo), capture_output=True,
        text=True, timeout=DEFAULT_TIMEOUT,
    )
    if proc.returncode != 0:
        return False, ""
    return True, proc.stdout


def has_gh() -> bool:
    return shutil.which("gh") is not None
