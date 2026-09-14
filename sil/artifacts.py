"""Where each artifact type lives in a world's target repo, and how it is written.

Disk only: no git, no network. The caller decides what gets committed, which is
what lets `run()` and `review.accept()` write into a scratch worktree instead of
the operator's checkout.

Every path comes from `world.layout`, so the built-in `learned/` repo and the V1
dotfiles layout (`claude/skills`, `claude/hooks/nudges`, `claude/agents`,
`global.CLAUDE.md`) are the same code with different config.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from sil import config, paths, store
from sil.consts import RULE_END, RULE_START, RULE_TAG
from sil.models import ArtifactType, World

TYPES = ("skill", "hook", "rule", "agent")


def _type_name(artifact_type: ArtifactType | str) -> str:
    return artifact_type.value if isinstance(artifact_type, ArtifactType) else str(artifact_type)


def artifact_rel(world: World, artifact_type: ArtifactType | str, pattern: str) -> str:
    """Target-repo-relative path for this artifact, or "" when the type has no file.

    The slug is validated here, at the one choke point, for every type and not
    only the ones that currently build a path. A pattern comes out of
    model-authored reflection text and then becomes both a path component and a
    git branch name; a future artifact type must not reopen traversal by skipping
    a check that lived in a caller.
    """
    if not store.is_slug(pattern):
        raise ValueError(f"unsafe pattern slug {pattern!r}")
    t = _type_name(artifact_type)
    layout = world.layout
    if t == "skill":
        return f"{layout.skills_dir.strip('/')}/{pattern}/SKILL.md"
    if t == "hook":
        return f"{layout.nudges_dir.strip('/')}/{pattern}.json"
    if t == "agent":
        return f"{layout.agents_dir.strip('/')}/{pattern}.md"
    if t == "rule":
        return layout.rules_file.strip("/")
    if t == "none":
        return ""
    raise ValueError(f"unknown artifact type {t!r}")


def artifact_prefixes(world: World) -> list[str]:
    """Every path a routed artifact of this world can land under, plus the ledger.

    Used as the pathspec of the repo-integrity gate, so a dirty file anywhere
    else in the target does not block a promotion.
    """
    layout = world.layout
    return sorted({
        layout.skills_dir.strip("/"),
        layout.nudges_dir.strip("/"),
        layout.agents_dir.strip("/"),
        layout.rules_file.strip("/"),
        layout.ledger.strip("/"),
    })


def allowed_paths(world: World, pattern: str) -> set[str]:
    """The only files a curriculum branch for `pattern` may change.

    Every type, not just the current one: a re-home touches the path it leaves as
    well as the one it arrives at, and refusing that would make a migrated pattern
    permanently unacceptable.
    """
    out = {world.layout.ledger.strip("/")}
    for t in TYPES:
        rel = artifact_rel(world, t, pattern)
        if rel:
            out.add(rel)
    return out


def _root(world: World, root: Path | None) -> Path:
    return Path(root) if root is not None else config.target_root(world)


def read_artifact(world: World, artifact_type: ArtifactType | str, pattern: str,
                  *, root: Path | None = None) -> str:
    """This pattern's artifact text. For "rule", only its own tagged bullet, never
    the whole shared file."""
    t = _type_name(artifact_type)
    rel = artifact_rel(world, t, pattern)
    if not rel:
        return ""
    path = _root(world, root) / rel
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8")
    if t == "rule":
        return rule_bullet_in_text(text, pattern)
    return text


def write_artifact(world: World, artifact_type: ArtifactType | str, pattern: str,
                   payload, *, root: Path | None = None) -> Path | None:
    """Write one artifact. Returns the path written, or None for type "none".

    `root` overrides the world's target repo so a caller can write into a scratch
    worktree; the layout inside it is identical.
    """
    t = _type_name(artifact_type)
    rel = artifact_rel(world, t, pattern)
    if not rel:
        return None
    path = _root(world, root) / rel
    if t == "rule":
        _write_rule(path, pattern, str(payload).strip())
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    if t == "hook":
        path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
                        encoding="utf-8")
    else:
        path.write_text(str(payload), encoding="utf-8")
    return path


def remove_artifact(world: World, artifact_type: ArtifactType | str, pattern: str,
                    *, root: Path | None = None) -> str:
    """Undo `write_artifact`: delete the file, or for "rule" drop just this
    pattern's tagged bullet from the shared managed block.

    Never unlinks the rule file itself. Every pattern's rule lives in it, and for
    a V1-layout world that file is the operator's live boot contract.

    Returns the repo-relative path touched, or "" when there was nothing to remove.
    """
    t = _type_name(artifact_type)
    rel = artifact_rel(world, t, pattern)
    if not rel:
        return ""
    path = _root(world, root) / rel
    if t == "rule":
        return rel if _remove_rule_bullet(path, pattern) else ""
    if not path.exists():
        return ""
    path.unlink()
    parent = path.parent
    if t == "skill" and parent.is_dir() and not any(parent.iterdir()):
        parent.rmdir()
    return rel


# --- rules: one managed block, one tagged bullet per pattern -----------------

def rule_bullet_in_text(text: str, pattern: str) -> str:
    """This pattern's tagged bullet inside `text`, or "" when it has none."""
    tag = RULE_TAG.format(pattern=pattern)
    for line in text.splitlines():
        if line.rstrip().endswith(tag):
            return line
    return ""


def rules_problem(world: World, *, root: Path | None = None) -> str | None:
    """Why a rule write into this world would refuse, checked read-only.

    Mirrors `_write_rule`'s three guards exactly. Running the writer itself to
    find out would mutate the operator's file before the scratch worktree exists.
    """
    path = _root(world, root) / world.layout.rules_file.strip("/")
    try:
        text = path.read_text(encoding="utf-8") if path.exists() else ""
    except OSError as e:
        return f"{path} is unreadable: {e}"
    return _marker_problem(path, text)


def _marker_problem(path: Path, text: str) -> str | None:
    starts, ends = text.count(RULE_START), text.count(RULE_END)
    if starts == 0 or ends == 0:
        return (f"{path} has no {RULE_START} / {RULE_END} marker pair; refusing to "
                f"append blind to a hand-maintained file")
    if starts > 1 or ends > 1:
        # A docs example of the marker syntax produces a second pair. Taking the
        # first as live would be a guess about a file a human maintains.
        return (f"{path} has {starts} start and {ends} end marker(s); ambiguous "
                f"which pair is live, refusing to guess")
    if text.index(RULE_START) > text.index(RULE_END):
        return (f"{path} has {RULE_END} before {RULE_START}; malformed marker "
                f"order, refusing to guess the managed region")
    return None


def owns_rules_file(world: World) -> bool:
    """Whether the loop may create this world's rules file.

    True only for the built-in `learned/` repo. A world pointing at a repo the
    operator maintains opts in by placing the markers itself; writing them there
    would be this code deciding that someone else's CLAUDE.md is ours to append to.
    """
    return config.target_root(world).resolve() == paths.default_target(world.name).resolve()


def ensure_rules_file(world: World, *, root: Path | None = None) -> Path | None:
    """Create the rules file with an empty marker pair, for the built-in target only.

    `root` points the write at a scratch worktree. Ownership is still decided by
    the world's real target, never by the directory being written into.
    """
    if not owns_rules_file(world):
        return None
    path = _root(world, root) / world.layout.rules_file.strip("/")
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"# Learned rules\n\nPromoted by the loop. Edit outside the markers only.\n\n"
        f"{RULE_START}\n{RULE_END}\n",
        encoding="utf-8",
    )
    return path


def _write_rule(path: Path, pattern: str, bullet: str) -> None:
    """Replace this pattern's tagged bullet inside the managed block, or add it.

    By tag, never by position: without the tag, refining a rule appends a second
    near-identical bullet on every run. Text outside the markers is never touched.
    """
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    problem = _marker_problem(path, text)
    if problem:
        raise ValueError(problem)
    head, _, rest = text.partition(RULE_START)
    block, _, tail = rest.partition(RULE_END)
    tag = RULE_TAG.format(pattern=pattern)
    kept = [line for line in block.splitlines()
            if line.strip() and not line.rstrip().endswith(tag)]
    kept.append(f"{bullet} {tag}")
    path.write_text(f"{head}{RULE_START}\n" + "\n".join(kept) + f"\n{RULE_END}{tail}",
                    encoding="utf-8")


def _remove_rule_bullet(path: Path, pattern: str) -> bool:
    if not path.exists():
        return False
    text = path.read_text(encoding="utf-8")
    tag = RULE_TAG.format(pattern=pattern)
    if tag not in text:
        return False
    problem = _marker_problem(path, text)
    if problem:
        raise ValueError(problem)
    head, _, rest = text.partition(RULE_START)
    block, _, tail = rest.partition(RULE_END)
    kept = [line for line in block.splitlines()
            if line.strip() and not line.rstrip().endswith(tag)]
    body = ("\n" + "\n".join(kept) + "\n") if kept else "\n"
    path.write_text(f"{head}{RULE_START}{body}{RULE_END}{tail}", encoding="utf-8")
    return True


# --- rehome placeholders -----------------------------------------------------

_PLACEHOLDER_NOTE = re.compile(r"re-homed from '[a-z]+', awaiting a real draft")


def placeholder_body(pattern: str, artifact_type: ArtifactType | str, old_type: str):
    """A schema-valid stub for a freshly re-homed artifact.

    Rehome runs no drafter: the human's override is an input to the next draft,
    not a body. The stub exists so the ledger has something to point at, and
    `is_placeholder_body` is what stops it being accepted as a real one.
    """
    t = _type_name(artifact_type)
    note = f"re-homed from {old_type!r}, awaiting a real draft"
    if t == "none":
        return ""
    if t == "hook":
        return {"pattern": pattern, "event": "PreToolUse", "gate": {"always": True},
                "once_per": "session", "text": f"TODO: {note}"[:400]}
    if t == "rule":
        return f"- TODO: {note} ({pattern})"
    return (f"---\nname: {pattern}\ndescription: Use when TODO -- {note}\n---\n\n"
            f"## TODO\n\n{note}.\n")


def is_placeholder_body(artifact_type: ArtifactType | str, body: str) -> bool:
    """True when `body` is `placeholder_body`'s stub, not a real draft.

    Structural, never a bare "TODO" substring: a real artifact is free to discuss
    TODOs, and a naive check would flag it as unfinished forever.
    """
    t = _type_name(artifact_type)
    if not body:
        return False
    if t == "hook":
        try:
            payload = json.loads(body)
        except (json.JSONDecodeError, TypeError):
            return False
        return (isinstance(payload, dict)
                and payload.get("event") == "PreToolUse"
                and payload.get("gate") == {"always": True}
                and payload.get("once_per") == "session"
                and bool(_PLACEHOLDER_NOTE.search(str(payload.get("text", "")))))
    if t in ("skill", "agent"):
        return ("description: Use when TODO -- " in body
                and "\n## TODO\n" in body
                and bool(_PLACEHOLDER_NOTE.search(body)))
    if t == "rule":
        return body.lstrip().startswith("- TODO: ") and bool(_PLACEHOLDER_NOTE.search(body))
    return False
