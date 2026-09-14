"""Tests for the plugin manifest, hooks.json, command frontmatter, skill
frontmatter, and the repo-wide no-long-dash writing rule."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

from sil.consts import HOOK_EVENTS

ROOT = Path(__file__).resolve().parent.parent


def _frontmatter(text: str) -> dict:
    assert text.startswith("---\n"), "file must start with a frontmatter block"
    end = text.find("\n---\n", 4)
    assert end != -1, "frontmatter block must be closed with ---"
    return yaml.safe_load(text[4:end]) or {}


# --- plugin.json --------------------------------------------------------------

def test_plugin_json_fields():
    data = json.loads((ROOT / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
    assert data["name"] == "self-improvement-loop"
    assert data["version"] == "0.1.0"
    assert data["description"]
    assert data["author"]["name"] == "Mariusz Rakus"
    assert data["repository"] == "https://github.com/kolezka/self-improvement-loop"
    assert data["license"] == "MIT"
    assert isinstance(data["keywords"], list) and data["keywords"]


# --- hooks.json -----------------------------------------------------------

def test_hooks_json_covers_every_event_exactly_once():
    data = json.loads((ROOT / "hooks" / "hooks.json").read_text(encoding="utf-8"))
    hooks = data["hooks"]
    assert set(hooks.keys()) == set(HOOK_EVENTS)
    for event in HOOK_EVENTS:
        entries = hooks[event]
        assert len(entries) == 1, f"{event} must have exactly one hook entry"
        commands = entries[0]["hooks"]
        assert len(commands) == 1, f"{event} must call exactly one command"


def test_hooks_json_command_path_and_timeout():
    data = json.loads((ROOT / "hooks" / "hooks.json").read_text(encoding="utf-8"))
    for event, entries in data["hooks"].items():
        cmd = entries[0]["hooks"][0]
        assert cmd["type"] == "command"
        assert cmd["command"] == 'python3 "${CLAUDE_PLUGIN_ROOT}/sil/hook.py"'
        assert cmd["timeout"] <= 10


def test_hooks_json_matcher_only_on_tool_events():
    data = json.loads((ROOT / "hooks" / "hooks.json").read_text(encoding="utf-8"))
    for event, entries in data["hooks"].items():
        matcher = entries[0].get("matcher")
        if event in ("PreToolUse", "PostToolUse"):
            assert matcher == "*"
        else:
            assert matcher is None


# --- commands/*.md ----------------------------------------------------------

COMMAND_FILES = sorted((ROOT / "commands").glob("*.md"))


@pytest.mark.parametrize("path", COMMAND_FILES, ids=lambda p: p.name)
def test_command_has_description_frontmatter(path):
    meta = _frontmatter(path.read_text(encoding="utf-8"))
    assert meta.get("description")


def test_command_files_present():
    names = {p.stem for p in COMMAND_FILES}
    assert names == {"reflect", "loop", "curriculum", "feedback"}


# --- skill frontmatter ------------------------------------------------------

def test_skill_frontmatter_name_and_description():
    skill_path = ROOT / "skills" / "self-improvement-loop" / "SKILL.md"
    meta = _frontmatter(skill_path.read_text(encoding="utf-8"))
    assert meta["name"] == "self-improvement-loop"
    assert meta["description"].startswith("Use when")


def test_skill_body_line_budget():
    skill_path = ROOT / "skills" / "self-improvement-loop" / "SKILL.md"
    lines = skill_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) <= 120


# --- no long dashes anywhere in plugin-facing text -----------------------

DASH_SCAN_DIRS = ["commands", "skills", "docs", "hooks", ".claude-plugin"]
DASH_SCAN_FILES = ["README.md"]


def _text_files():
    files = []
    for d in DASH_SCAN_DIRS:
        base = ROOT / d
        if not base.exists():
            continue
        for p in base.rglob("*"):
            if p.is_file() and p.suffix in (".md", ".json"):
                files.append(p)
    for name in DASH_SCAN_FILES:
        p = ROOT / name
        if p.exists():
            files.append(p)
    return files


@pytest.mark.parametrize("path", _text_files(), ids=lambda p: str(p.relative_to(ROOT)))
def test_no_em_or_en_dash(path):
    text = path.read_text(encoding="utf-8")
    assert "—" not in text, f"em dash found in {path}"
    assert "–" not in text, f"en dash found in {path}"
