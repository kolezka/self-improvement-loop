"""Shared helpers for the curriculum, router, lint, artifact, run and review tests.

Not a conftest: the other module groups own their own test files and a shared
conftest would be a file two agents edit. Import from here explicitly instead.

Everything is hermetic. The three SIL directories, CLAUDE_CONFIG_DIR and git's
own global config all point inside tmp_path, so a test can never read or write
the machine's real state.
"""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path

from sil import gitutil, paths, store
from sil.models import Config, Layout, Promotion, World


def sil_env(tmp_path: Path, monkeypatch) -> Path:
    """Point every root at tmp_path. Returns the root it built."""
    root = tmp_path / "sil"
    for name, sub in (("SIL_CONFIG_DIR", "config"), ("SIL_STATE_DIR", "state"),
                      ("SIL_DATA_DIR", "data")):
        target = root / sub
        target.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv(name, str(target))
    claude = root / "claude"
    claude.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(claude))
    # git must not read the operator's config: a global hooksPath, gpg signing or
    # an alias would make these tests depend on the machine they run on.
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(root / "gitconfig"))
    monkeypatch.setenv("GIT_CONFIG_SYSTEM", str(root / "gitconfig"))
    monkeypatch.delenv("CLAUDE_PLUGIN_ROOT", raising=False)
    return root


def make_world(name: str = "default", **kwargs) -> World:
    return World(name=name, **kwargs)


V1_LAYOUT = Layout(skills_dir="claude/skills", nudges_dir="claude/hooks/nudges",
                   agents_dir="claude/agents", rules_file="global.CLAUDE.md",
                   ledger="claude/skills/promotions.json")


def make_cfg(threshold: int = 3, per_run_cap: int = 3, auto_merge: bool = False,
             worlds: list[World] | None = None) -> Config:
    return Config(
        worlds=worlds or [World(name="default")],
        promotion=Promotion(threshold=threshold, per_run_cap=per_run_cap,
                            auto_merge=auto_merge),
    )


LESSON = (
    "Before calling a change safe, run `rg` over every call site of the changed "
    "symbol and read the graphify inventory; a single unguarded consumer is the "
    "whole bug."
)


def reflection_body(pattern: str, day: str, lesson: str = LESSON) -> str:
    return (
        f"Last updated: {day}\n\n"
        f"Pattern: {pattern}\n\n"
        "## What worked\n"
        "Reading the promotions ledger before touching the branch.\n\n"
        "## What failed & why\n"
        "I generalised from one obvious consumer and missed an unguarded call site.\n\n"
        "## Reusable lesson\n"
        f"{lesson}\n\n"
        "## Verification\n"
        "Re-ran `rg` across the repository and counted the hits.\n\n"
        "## Not verified\n"
        "Whether the graphify extraction covers wrapped call sites.\n"
    )


def add_reflections(world: World, pattern: str, count: int, *, start_day: int = 1,
                    lesson: str = LESSON) -> list[Path]:
    """`count` reflection documents for one pattern, dated consecutively."""
    out = []
    for i in range(count):
        day = f"2026-09-{start_day + i:02d}"
        rid = f"{day}-{pattern}-{i:02d}"
        out.append(store.write_reflection(
            world.name, {"id": rid, "created": day},
            reflection_body(pattern, day, lesson)))
    return out


def init_target(world: World, *, root: Path | None = None) -> Path:
    """A git repo at the world's target, with one empty commit on main."""
    from sil import config

    return gitutil.ensure_repo(root or config.target_root(world))


def commit_file(repo: Path, rel: str, text: str, message: str = "chore: fixture") -> None:
    path = repo / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    gitutil.git(repo, "add", "--", rel)
    gitutil.git(repo, "commit", "-q", "-m", message)


# --- fake sil.nudge (group A) ------------------------------------------------

EVENTS = {
    "PreToolUse": frozenset({"Bash", "Edit", "Write", "Read", "Grep", "Glob", "Agent"}),
    "PostToolUse": frozenset({"Bash", "Edit", "Write", "Read", "Grep", "Glob", "Agent"}),
    "Stop": None,
    "SessionStart": None,
    "UserPromptSubmit": None,
}


class _NudgeError(ValueError):
    pass


def _evaluate(gate: dict, payload: dict) -> bool:
    """A faithful stand-in for the dispatcher's gate interpreter.

    Real enough that the router's "execute the gate against the corpus" rule is
    actually exercised: a stub returning True would make every hook test pass for
    the wrong reason.
    """
    import fnmatch
    import re

    if not isinstance(gate, dict) or len(gate) != 1:
        raise _NudgeError(f"a gate is exactly one predicate, got: {gate!r}")
    (name, arg), = gate.items()
    tool_input = payload.get("tool_input") if isinstance(payload.get("tool_input"), dict) else {}
    if name == "always":
        return bool(arg)
    if name == "tool_is":
        if not isinstance(arg, list):
            raise _NudgeError("tool_is takes a list")
        return payload.get("tool_name") in arg
    if name == "command_matches":
        return bool(re.search(str(arg), str(tool_input.get("command", ""))))
    if name == "file_path_matches":
        return fnmatch.fnmatch(str(tool_input.get("file_path", "")), str(arg))
    if name == "prompt_matches":
        return bool(re.search(str(arg), str(payload.get("prompt", ""))))
    if name == "all":
        return all(_evaluate(child, payload) for child in arg)
    if name == "any":
        return any(_evaluate(child, payload) for child in arg)
    if name == "not":
        return not _evaluate(arg, payload)
    raise _NudgeError(f"unknown predicate {name!r}")


def _lint_nudge(obj: dict) -> list[str]:
    problems = []
    for key in ("pattern", "event", "gate", "once_per", "text"):
        if key not in obj:
            problems.append(f"missing key {key!r}")
    if obj.get("event") not in EVENTS and "event" in obj:
        problems.append(f"unknown event {obj.get('event')!r}")
    if obj.get("once_per") not in ("session", "always") and "once_per" in obj:
        problems.append("once_per must be 'session' or 'always'")
    if len(str(obj.get("text", ""))) > 400:
        problems.append("text is over 400 characters")
    return problems


def install_fake_nudge(monkeypatch, *, lint_nudge=None) -> types.ModuleType:
    module = types.ModuleType("sil.nudge")
    module.EVENTS = EVENTS
    module.NudgeError = _NudgeError
    module.evaluate = _evaluate
    module.lint_nudge = lint_nudge or _lint_nudge
    monkeypatch.setitem(sys.modules, "sil.nudge", module)
    return module


# --- fake sil.feedback (group B) ---------------------------------------------

def install_fake_feedback(monkeypatch, scorecard_file: Path) -> types.ModuleType:
    """A feedback module that reads scorecards from one JSON file on disk."""
    from sil.models import Scorecard

    module = types.ModuleType("sil.feedback")

    def load(world):
        if not scorecard_file.exists():
            return []
        raw = json.loads(scorecard_file.read_text(encoding="utf-8"))
        return [Scorecard.model_validate(row) for row in raw]

    module.load = load
    monkeypatch.setitem(sys.modules, "sil.feedback", module)
    return module


# --- fake provider -----------------------------------------------------------

def skill_body(pattern: str, quote: str = "") -> str:
    return (
        f"---\nname: {pattern}\n"
        "description: Use when a change touches a shared symbol and you are about "
        "to call it safe.\n---\n\n"
        "## Enumerate every call site\n\n"
        "Run `rg` over the changed symbol and read the graphify inventory before "
        "calling the change safe. One unguarded consumer is the whole bug, and the "
        "promotions ledger will not tell you about it.\n"
        + (f"\nEvidence: {quote}\n" if quote else "")
    )


AGENT_BODY = skill_body


def rule_body() -> str:
    return ("- Run `rg` over every call site of a changed symbol and read the "
            "graphify inventory before calling the change safe.")


def hook_body(pattern: str) -> dict:
    return {
        "pattern": pattern,
        "event": "PreToolUse",
        "matcher": "Bash",
        "gate": {"command_matches": "git (commit|push)"},
        "once_per": "session",
        "text": ("Run `rg` over every call site of the changed symbol and read the "
                 "graphify inventory before committing; the promotions ledger "
                 "records only a watermark."),
    }


class FakeChat:
    """A `sil.providers.chat` stand-in that records every call."""

    def __init__(self, draft: dict | None = None, verdict: bool = True,
                 reason: str = "quoted from a source", drafts: list | None = None):
        self.draft = draft or {}
        self.drafts = drafts
        self.verdict = verdict
        self.reason = reason
        self.calls: list[tuple[str, list[dict]]] = []

    def __call__(self, role, messages, *, world=None, cfg_llm=None,
                 json_mode=False, max_tokens=4000):
        self.calls.append((role, messages))
        if role == "judge":
            return json.dumps({"verdict": "yes" if self.verdict else "no",
                               "reason": self.reason})
        if self.drafts:
            return json.dumps(self.drafts.pop(0))
        return json.dumps(self.draft)

    @property
    def roles(self) -> list[str]:
        return [role for role, _ in self.calls]

    def prompts_for(self, role: str) -> list[str]:
        return [m[-1]["content"] for r, m in self.calls if r == role]


def skill_draft(pattern: str, quote: str) -> dict:
    return {"trigger_event": "none", "gate": None, "needs_own_context": False,
            "context_evidence": None, "capability_evidence": quote,
            "declined": False, "artifact": skill_body(pattern, quote)}


def rule_draft() -> dict:
    return {"trigger_event": "none", "gate": None, "needs_own_context": False,
            "context_evidence": None, "capability_evidence": None,
            "declined": False, "artifact": rule_body()}


def hook_draft(pattern: str) -> dict:
    return {"trigger_event": "PreToolUse:Bash",
            "gate": {"command_matches": "git (commit|push)"},
            "needs_own_context": False, "context_evidence": None,
            "capability_evidence": None, "declined": False,
            "artifact": hook_body(pattern)}
