"""Load and save config.yaml and llm.yaml. Resolve worlds and model roles."""

from __future__ import annotations

import os
from pathlib import Path

import yaml

from sil import paths
from sil.models import ROLES, Config, Endpoint, LlmConfig, World


class ConfigError(RuntimeError):
    pass


class ModelNotConfigured(ConfigError):
    pass


class LocalityViolation(ConfigError):
    pass


# --- config.yaml ------------------------------------------------------------

def load_config(path: Path | None = None) -> Config:
    p = path or paths.config_file()
    if not p.exists():
        return Config()
    raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    return Config.model_validate(raw)


def save_config(cfg: Config, path: Path | None = None) -> Path:
    p = path or paths.config_file()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(yaml.safe_dump(cfg.model_dump(mode="json"), sort_keys=False), encoding="utf-8")
    return p


def world_named(cfg: Config, name: str) -> World:
    for w in cfg.worlds:
        if w.name == name:
            return w
    raise ConfigError(f"unknown world: {name!r}")


def world_for_cwd(cfg: Config, cwd: Path | str) -> World:
    """Longest `repos` prefix match; the first world with empty repos is the
    catch-all. Raises when nothing matches and no catch-all exists."""
    cwd_r = Path(cwd).resolve()
    best: tuple[int, World] | None = None
    fallback: World | None = None
    for w in cfg.worlds:
        if not w.repos and fallback is None:
            fallback = w
        for repo in w.repos:
            r = repo.expanduser().resolve()
            if cwd_r == r or r in cwd_r.parents:
                score = len(r.parts)
                if best is None or score > best[0]:
                    best = (score, w)
    if best:
        return best[1]
    if fallback:
        return fallback
    raise ConfigError(f"no world owns {cwd_r} and no catch-all world exists")


def target_root(world: World) -> Path:
    return (world.target or paths.default_target(world.name)).expanduser()


def ledger_path(world: World) -> Path:
    return target_root(world) / world.layout.ledger


# --- llm.yaml ---------------------------------------------------------------

def load_llm(world: World | None = None, path: Path | None = None) -> LlmConfig:
    p = path or (world.llm_config if world and world.llm_config else None) or paths.llm_file()
    p = Path(p).expanduser()
    if not p.exists():
        return LlmConfig()
    raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    return LlmConfig.model_validate(raw)


def save_llm(llm: LlmConfig, path: Path | None = None) -> Path:
    p = path or paths.llm_file()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(yaml.safe_dump(llm.model_dump(mode="json"), sort_keys=False), encoding="utf-8")
    return p


def active_endpoint(llm: LlmConfig) -> Endpoint:
    if not llm.endpoints:
        raise ModelNotConfigured("llm.yaml has no endpoints; run `sil init` or edit it")
    name = llm.active or llm.endpoints[0].name
    for e in llm.endpoints:
        if e.name == name:
            return e
    raise ModelNotConfigured(f"llm.yaml active endpoint {name!r} is not defined")


def model_for(llm: LlmConfig, role: str, world: World | None = None) -> str:
    """The model name for a role. Never defaults. Enforces locality."""
    if role not in ROLES:
        raise ConfigError(f"unknown model role {role!r}; roles are {ROLES}")
    model = llm.models.get(role)
    if not model:
        raise ModelNotConfigured(f"llm.yaml models.{role} is not set")
    if world and world.llm == "local" and model not in llm.local_models:
        raise LocalityViolation(
            f"world {world.name!r} is llm: local but models.{role}={model!r} is not in local_models"
        )
    return model


def api_key(endpoint: Endpoint) -> str | None:
    """The credential for an endpoint, or None when the endpoint needs none.
    Raises when a declared env var is unset: no placeholder keys."""
    if endpoint.kind == "claude-cli":
        return None
    if not endpoint.api_key_env:
        return None
    value = os.environ.get(endpoint.api_key_env)
    if not value:
        raise ModelNotConfigured(f"env var {endpoint.api_key_env} (api_key_env) is not set")
    return value


# --- hook snapshot ----------------------------------------------------------

def write_hook_snapshot(cfg: Config | None = None) -> Path:
    """Plain-JSON view of config for the stdlib hook path (no yaml there).

    Called by every engine entry point (init, worker, web, cli) so the hook
    never reads a stale world map for long.
    """
    import json

    from sil.consts import HOOK_SNAPSHOT

    cfg = cfg or load_config()
    worlds = []
    for w in cfg.worlds:
        root = target_root(w)
        worlds.append({
            "name": w.name,
            "repos": [str(Path(r).expanduser().resolve()) for r in w.repos],
            "nudges_dir": str(root / w.layout.nudges_dir),
            "rules_file": str(root / w.layout.rules_file),
            "rules_inject": w.rules_inject,
        })
    snap = {
        "version": 1,
        "worlds": worlds,
        "worker": cfg.worker.model_dump(mode="json"),
        "plugin_root": str(paths.plugin_root()),
    }
    p = paths.state_dir() / HOOK_SNAPSHOT
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(snap, indent=2) + "\n", encoding="utf-8")
    tmp.replace(p)
    return p
