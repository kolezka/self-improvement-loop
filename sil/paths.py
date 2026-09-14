"""Filesystem layout. Stdlib only: the hook fast path imports this.

Every path the engine touches is derived here from three roots so tests can
point all of them at a temp dir via environment variables.
"""

from __future__ import annotations

import os
from pathlib import Path


def _env_path(name: str, default: Path) -> Path:
    raw = os.environ.get(name)
    return Path(raw).expanduser() if raw else default


def config_dir() -> Path:
    return _env_path(
        "SIL_CONFIG_DIR",
        _env_path("XDG_CONFIG_HOME", Path.home() / ".config") / "self-improvement-loop",
    )


def state_dir() -> Path:
    return _env_path(
        "SIL_STATE_DIR",
        _env_path("XDG_STATE_HOME", Path.home() / ".local" / "state") / "self-improvement-loop",
    )


def data_dir() -> Path:
    return _env_path(
        "SIL_DATA_DIR",
        _env_path("XDG_DATA_HOME", Path.home() / ".local" / "share") / "self-improvement-loop",
    )


def plugin_root() -> Path:
    """The installed plugin directory.

    Claude Code sets CLAUDE_PLUGIN_ROOT for hooks and commands. Outside a hook
    (worker started by systemd, tests) fall back to this package's parent.
    """
    raw = os.environ.get("CLAUDE_PLUGIN_ROOT")
    if raw:
        return Path(raw)
    return Path(__file__).resolve().parent.parent


def claude_config_dir() -> Path:
    return _env_path("CLAUDE_CONFIG_DIR", Path.home() / ".claude")


# --- config -----------------------------------------------------------------

def config_file() -> Path:
    return config_dir() / "config.yaml"


def llm_file() -> Path:
    return config_dir() / "llm.yaml"


# --- state ------------------------------------------------------------------

def queue_dir(bucket: str) -> Path:
    """bucket is one of pending, done, failed."""
    return state_dir() / "queue" / bucket


def usage_events_file() -> Path:
    return state_dir() / "usage" / "events.jsonl"


def nudge_fires_file() -> Path:
    return state_dir() / "usage" / "nudge-fires.jsonl"


def human_feedback_file() -> Path:
    return state_dir() / "feedback" / "human.jsonl"


def critic_feedback_file() -> Path:
    return state_dir() / "feedback" / "critic.jsonl"


def inbox_dir(world: str) -> Path:
    return state_dir() / "inbox" / world


def session_dir(session_id: str) -> Path:
    return state_dir() / "sessions" / _safe(session_id)


def worker_lock_file() -> Path:
    return state_dir() / "worker.lock"


def log_file(name: str) -> Path:
    """name is one of hook, worker, web, curriculum."""
    return state_dir() / "logs" / f"{name}.log"


LOG_NAMES = ("hook", "worker", "web", "curriculum")


# --- data -------------------------------------------------------------------

def world_dir(world: str) -> Path:
    return data_dir() / "worlds" / _safe(world)


def reflections_dir(world: str) -> Path:
    return world_dir(world) / "reflections"


def aliases_file(world: str) -> Path:
    return world_dir(world) / "aliases.json"


def default_target(world: str) -> Path:
    return world_dir(world) / "learned"


def builtin_nudges_dir() -> Path:
    return plugin_root() / "nudges"


def _safe(name: str) -> str:
    """Path component from an identifier: no separators, no traversal."""
    cleaned = "".join(c if c.isalnum() or c in "-_." else "_" for c in name)
    if cleaned in ("", ".", ".."):
        return "_"
    return cleaned
