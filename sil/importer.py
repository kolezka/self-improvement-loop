"""Import V1 data into the v2 layout: worlds.yaml, reflection mirrors, ledgers.

V1 (`dotfiles-next`) kept worlds in a manifest read by `kb list`, reflections in
a flat markdown mirror, and one ledger per repo. This module is the one-time
bridge from that shape into `sil`'s config and data dirs. It never runs on a
schedule and never deletes the V1 source.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import yaml

from sil import paths, store
from sil.config import ledger_path
from sil.models import Config, World


def import_worlds_yaml(path: Path) -> list[World]:
    """Read a V1 `kb list` manifest and return one sil World per V1 world.

    Each V1 project's `repo` becomes a `repos` prefix. No `target` is set: an
    imported world writes artifacts into the built-in `learned/` repo until an
    operator points it at a real target with `sil worlds add --target`.
    """
    raw = yaml.safe_load(Path(path).expanduser().read_text(encoding="utf-8")) or {}
    worlds: list[World] = []
    for w in raw.get("worlds") or []:
        repos = [Path(p["repo"]).expanduser() for p in (w.get("projects") or []) if p.get("repo")]
        worlds.append(World(name=w["name"], llm=w.get("llm", "cloud"), repos=repos))
    return worlds


def merge_worlds(cfg: Config, worlds: list[World]) -> tuple[Config, int]:
    """Add imported worlds not already present by name. Returns (cfg, added count)."""
    existing = {w.name for w in cfg.worlds}
    added = 0
    for w in worlds:
        if w.name not in existing:
            cfg.worlds.append(w)
            existing.add(w.name)
            added += 1
    return cfg, added


def import_reflections(src_dir: Path, world: str) -> dict[str, int]:
    """Copy V1 mirror reflection docs into the world's reflections dir.

    A file counts as a reflection when it has a `Pattern:` line
    (`store.reflection_pattern`). Filenames are kept; a file already present at
    the destination is skipped rather than overwritten (reflections are
    append-only).
    """
    src = Path(src_dir).expanduser()
    dest = paths.reflections_dir(world)
    dest.mkdir(parents=True, exist_ok=True)
    copied = skipped_duplicate = skipped_non_reflection = 0
    for p in sorted(src.rglob("*.md")):
        text = p.read_text(encoding="utf-8", errors="ignore")
        if not store.reflection_pattern(text):
            skipped_non_reflection += 1
            continue
        target = dest / p.name
        if target.exists():
            skipped_duplicate += 1
            continue
        shutil.copy2(p, target)
        copied += 1
    return {
        "copied": copied,
        "skipped_duplicate": skipped_duplicate,
        "skipped_non_reflection": skipped_non_reflection,
    }


def import_ledger(src_path: Path, world: World) -> int:
    """Map a V1 `promotions.json` (list or dict shaped) into the world's ledger.

    `store.load_ledger` already understands the V1 list shape
    (`{"entries": [...]}` or a bare list), so this just reads at the source
    path and writes at the world's own ledger path. Returns the entry count.
    """
    ledger = store.load_ledger(Path(src_path).expanduser())
    dest = ledger_path(world)
    store.save_ledger(dest, ledger)
    return len(ledger.entries)
