"""Tests for sil/cli.py.

Backend modules owned by other groups (sil.worker, sil.review, sil.providers,
sil.feedback) may not exist yet, so tests that need them install a fake module
into sys.modules rather than importing the real thing. See
`install_fake_module` below (same pattern as tests/test_ops.py).
"""

from __future__ import annotations

import importlib
import json
import sys
import types

import pytest

from sil import cli, config


def install_fake_module(monkeypatch, name: str, **attrs):
    """Inject a throwaway module at `name` (e.g. "sil.review") so a lazy
    `from sil import review` inside a cli function resolves to it."""
    mod = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    monkeypatch.setitem(sys.modules, name, mod)
    parent_name, _, attr = name.rpartition(".")
    if parent_name:
        parent = importlib.import_module(parent_name)
        monkeypatch.setattr(parent, attr, mod, raising=False)
    return mod


@pytest.fixture(autouse=True)
def isolated_dirs(monkeypatch, tmp_path):
    """Every test gets its own config/state/data dirs, never the real ones."""
    monkeypatch.setenv("SIL_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("SIL_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("SIL_DATA_DIR", str(tmp_path / "data"))


# --- init -----------------------------------------------------------------

def test_init_is_idempotent_and_creates_files():
    from sil import paths

    from sil.consts import HOOK_SNAPSHOT

    rc1 = cli.main(["init"])
    assert rc1 == 0
    assert paths.config_file().is_file()
    assert paths.llm_file().is_file()
    assert (paths.state_dir() / HOOK_SNAPSHOT).is_file()
    assert paths.reflections_dir("default").is_dir()
    assert paths.inbox_dir("default").is_dir()
    assert paths.queue_dir("pending").is_dir()

    cfg_after_first = config.load_config()
    assert [w.name for w in cfg_after_first.worlds] == ["default"]

    rc2 = cli.main(["init"])
    assert rc2 == 0
    cfg_after_second = config.load_config()
    assert [w.name for w in cfg_after_second.worlds] == ["default"]


# --- status -----------------------------------------------------------------

def test_status_json_with_fakes(monkeypatch, capsys):
    fake_worker = install_fake_module(
        monkeypatch,
        "sil.worker",
        status=lambda: {"running": True, "pid": 123},
        queue_list=lambda bucket: [] if bucket != "pending" else ["a", "b"],
    )
    install_fake_module(
        monkeypatch,
        "sil.review",
        queue=lambda world, cfg: [],
        inventory=lambda world, cfg: [],
    )
    install_fake_module(
        monkeypatch,
        "sil.providers",
        status=lambda world, llm=None: {"endpoint": "litellm", "reachable": True, "error": None},
    )

    rc = cli.main(["status", "--json"])
    assert rc == 0
    out = capsys.readouterr().out
    payload = json.loads(out)
    assert payload["worker"] == {"running": True, "pid": 123}
    assert payload["queue"]["pending"] == 2
    assert payload["queue"]["done"] == 0
    assert len(payload["worlds"]) == 1
    world_info = payload["worlds"][0]
    assert world_info["world"] == "default"
    assert world_info["provider"]["endpoint"] == "litellm"
    assert fake_worker.status() == {"running": True, "pid": 123}


# --- feedback add -------------------------------------------------------------

def test_feedback_add_writes_human_feedback(monkeypatch, capsys):
    recorded = []
    install_fake_module(monkeypatch, "sil.feedback", record_human=lambda fb: recorded.append(fb))

    rc = cli.main(["feedback", "add", "skill:foo", "good", "--note", "worked well"])
    assert rc == 0
    assert len(recorded) == 1
    fb = recorded[0]
    assert fb.world == "default"
    assert fb.ref == "skill:foo"
    assert fb.vote == "good"
    assert fb.note == "worked well"
    out = capsys.readouterr().out
    assert "skill:foo" in out


# --- worlds add ---------------------------------------------------------------

def test_worlds_add_v1_layout_writes_v1_paths(tmp_path):
    repo = tmp_path / "somerepo"
    repo.mkdir()
    rc = cli.main(["worlds", "add", "legacy", "--layout", "v1", "--repos", str(repo)])
    assert rc == 0

    cfg = config.load_config()
    names = [w.name for w in cfg.worlds]
    assert "default" in names
    assert "legacy" in names
    legacy = config.world_named(cfg, "legacy")
    assert legacy.layout.skills_dir == "claude/skills"
    assert legacy.layout.nudges_dir == "claude/hooks/nudges"
    assert legacy.layout.agents_dir == "claude/agents"
    assert legacy.layout.rules_file == "global.CLAUDE.md"
    assert legacy.layout.ledger == "claude/skills/promotions.json"


def test_worlds_add_duplicate_name_is_config_error(capsys):
    rc = cli.main(["worlds", "add", "default"])
    assert rc == 2
    err = capsys.readouterr().err
    assert "already exists" in err
    assert "Traceback" not in err


# --- ConfigError handling -----------------------------------------------------

def test_unknown_world_exits_2_without_traceback(capsys):
    rc = cli.main(["reflections", "show", "some-id", "--world", "doesnotexist"])
    assert rc == 2
    err = capsys.readouterr().err
    assert err.startswith("error:")
    assert "unknown world" in err
    assert "Traceback" not in err


# --- review accept --------------------------------------------------------

def test_review_accept_requires_reviewed_state():
    with pytest.raises(SystemExit) as exc_info:
        cli.main(["review", "accept", "foo-bar", "--world", "default"])
    assert exc_info.value.code == 2


def test_review_accept_calls_backend(monkeypatch, capsys):
    calls = []
    install_fake_module(
        monkeypatch,
        "sil.review",
        accept=lambda world, cfg, pattern, reviewed_state: calls.append((world, pattern, reviewed_state)),
    )
    rc = cli.main(["review", "accept", "foo-bar", "--world", "default", "--reviewed-state", "a" * 64])
    assert rc == 0
    assert len(calls) == 1
    called_world, called_pattern, called_state = calls[0]
    assert called_world.name == "default"
    assert called_pattern == "foo-bar"
    assert called_state == "a" * 64


# --- reflect ------------------------------------------------------------------

def test_reflect_marks_pending_entry_ended_by_cwd(tmp_path):
    from sil import paths
    from sil.models import QueueEntry

    cwd = tmp_path / "proj"
    cwd.mkdir()
    entry = QueueEntry(
        session_id="sess-1",
        transcript_path=tmp_path / "t.jsonl",
        cwd=cwd,
        world="default",
        first_stop="2026-01-01T00:00:00.000Z",
        last_stop="2026-01-01T00:00:00.000Z",
    )
    pending_dir = paths.queue_dir("pending")
    pending_dir.mkdir(parents=True)
    entry_path = pending_dir / "sess-1.json"
    entry_path.write_text(entry.model_dump_json(indent=2), encoding="utf-8")

    rc = cli.main(["reflect", "--cwd", str(cwd)])
    assert rc == 0

    updated = QueueEntry.model_validate_json(entry_path.read_text(encoding="utf-8"))
    assert updated.ended is True


def test_reflect_without_session_or_cwd_errors(capsys):
    rc = cli.main(["reflect"])
    assert rc == 2
    assert "needs --session or --cwd" in capsys.readouterr().err


# --- no subcommand ----------------------------------------------------------

def test_no_command_prints_help_and_returns_1(capsys):
    rc = cli.main([])
    assert rc == 1
    assert "usage" in capsys.readouterr().out.lower()
