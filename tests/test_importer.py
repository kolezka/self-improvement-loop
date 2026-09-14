"""Tests for sil/importer.py: V1 -> V2 bridge (worlds.yaml, reflection
mirrors, promotions.json ledgers)."""

from __future__ import annotations

import json

import pytest
import yaml

from sil import importer
from sil.models import Config, World


@pytest.fixture(autouse=True)
def isolated_dirs(monkeypatch, tmp_path):
    monkeypatch.setenv("SIL_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("SIL_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("SIL_DATA_DIR", str(tmp_path / "data"))


# --- import_worlds_yaml -----------------------------------------------------

def test_import_worlds_yaml_reads_v1_manifest(tmp_path):
    manifest = tmp_path / "worlds.yaml"
    manifest.write_text(
        yaml.safe_dump(
            {
                "worlds": [
                    {
                        "name": "raqz",
                        "llm": "cloud",
                        "projects": [{"name": "dotfiles", "repo": str(tmp_path / "dotfiles")}],
                    },
                    {"name": "client-a", "projects": [{"repo": str(tmp_path / "client-a")}]},
                ]
            }
        ),
        encoding="utf-8",
    )

    worlds = importer.import_worlds_yaml(manifest)
    assert [w.name for w in worlds] == ["raqz", "client-a"]
    assert worlds[0].llm == "cloud"
    assert worlds[0].repos == [(tmp_path / "dotfiles")]
    assert worlds[1].llm == "cloud"  # default when V1 world has no llm field


def test_merge_worlds_adds_only_new_names():
    cfg = Config(worlds=[World(name="default")])
    imported = [World(name="default"), World(name="raqz")]
    cfg, added = importer.merge_worlds(cfg, imported)
    assert added == 1
    assert {w.name for w in cfg.worlds} == {"default", "raqz"}


# --- import_reflections ---------------------------------------------------

def test_import_reflections_copies_only_real_reflections(tmp_path):
    src = tmp_path / "mirror"
    src.mkdir()
    (src / "one.md").write_text("---\nid: one\n---\nPattern: foo-bar\n\nbody\n", encoding="utf-8")
    (src / "two.md").write_text("Pattern: baz-qux\n\nanother body\n", encoding="utf-8")
    (src / "README.md").write_text("# not a reflection, no pattern line\n", encoding="utf-8")

    result = importer.import_reflections(src, "default")
    assert result == {"copied": 2, "skipped_duplicate": 0, "skipped_non_reflection": 1}

    from sil import paths

    dest_files = sorted(p.name for p in paths.reflections_dir("default").glob("*.md"))
    assert dest_files == ["one.md", "two.md"]


def test_import_reflections_skips_duplicates_on_rerun(tmp_path):
    src = tmp_path / "mirror"
    src.mkdir()
    (src / "one.md").write_text("Pattern: foo-bar\n\nbody\n", encoding="utf-8")

    first = importer.import_reflections(src, "default")
    second = importer.import_reflections(src, "default")
    assert first["copied"] == 1
    assert second["copied"] == 0
    assert second["skipped_duplicate"] == 1


# --- import_ledger ----------------------------------------------------------

def test_import_ledger_maps_v1_list_shape(tmp_path):
    src = tmp_path / "promotions.json"
    src.write_text(
        json.dumps(
            [
                {"pattern": "foo-bar", "promoted_at_count": 3, "status": "promoted"},
                {"pattern": "baz-qux", "status": "staged"},
            ]
        ),
        encoding="utf-8",
    )
    world = World(name="default", target=tmp_path / "target")

    count = importer.import_ledger(src, world)
    assert count == 2

    from sil.config import ledger_path
    from sil.store import load_ledger

    ledger = load_ledger(ledger_path(world))
    assert set(ledger.entries) == {"foo-bar", "baz-qux"}
    assert ledger.entries["foo-bar"].promoted_at_count == 3
    assert ledger.entries["foo-bar"].status == "promoted"
