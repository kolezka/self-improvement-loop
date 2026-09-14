"""Reflection store, aliases, ledger, inbox. Plain files, world-scoped.

`reflection_pattern()` is the one definition of "this file is a reflection";
the critic writer, the clustering step and the web UI all use it.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import yaml
from pydantic import ValidationError

from sil import paths
from sil.models import Ledger, Lesson, PromotionEntry, Reflection

PATTERN_RE = re.compile(r"^Pattern:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*$", re.MULTILINE)
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
SECTIONS = ("## What worked", "## What failed & why", "## Reusable lesson", "## Verification", "## Not verified")


def is_slug(s: str) -> bool:
    return bool(SLUG_RE.match(s)) and len(s) <= 64


def reflection_pattern(text: str) -> str | None:
    m = PATTERN_RE.search(text)
    return m.group(1) if m else None


def split_front_matter(text: str) -> tuple[dict, str]:
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end != -1:
            try:
                meta = yaml.safe_load(text[4:end]) or {}
            except yaml.YAMLError:
                meta = {}
            return (meta if isinstance(meta, dict) else {}), text[end + 5:]
    return {}, text


def section(body: str, heading: str) -> str:
    """Text under a `## heading` up to the next `## `."""
    idx = body.find(heading)
    if idx == -1:
        return ""
    rest = body[idx + len(heading):]
    nxt = rest.find("\n## ")
    return (rest if nxt == -1 else rest[:nxt]).strip()


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=path.suffix)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


# --- reflections ------------------------------------------------------------

def parse_reflection(path: Path, world: str) -> Reflection | None:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    meta, body = split_front_matter(text)
    pattern = reflection_pattern(body) or reflection_pattern(text)
    if not pattern:
        return None
    created = str(meta.get("created") or datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).date())
    return Reflection(
        id=str(meta.get("id") or path.stem),
        world=str(meta.get("world") or world),
        pattern=pattern,
        path=path,
        created=created,
        session_id=meta.get("session_id"),
        cwd=meta.get("cwd"),
        revision=meta.get("revision"),
        model=meta.get("model"),
        artifacts_used=list(meta.get("artifacts_used") or []),
        artifacts_helpful=list(meta.get("artifacts_helpful") or []),
        artifacts_misfired=list(meta.get("artifacts_misfired") or []),
        lesson=section(body, "## Reusable lesson"),
        body=body,
    )


def list_reflections(world: str, extra_dirs: list[Path] | None = None) -> list[Reflection]:
    """All reflections of a world, newest first. `extra_dirs` lets a world read a
    V1 mirror tree read-only (import without copying)."""
    out: list[Reflection] = []
    dirs = [paths.reflections_dir(world), *(extra_dirs or [])]
    for d in dirs:
        if not d.exists():
            continue
        for p in sorted(d.rglob("*.md")):
            if any(part.startswith(".") or part in ("graphify-out", "vec-index") for part in p.relative_to(d).parts):
                continue
            r = parse_reflection(p, world)
            if r and r.world == world:
                out.append(r)
    out.sort(key=lambda r: (r.created, r.id), reverse=True)
    return out


def new_reflection_id(pattern: str, when: datetime | None = None) -> str:
    d = (when or datetime.now(timezone.utc)).strftime("%Y-%m-%d")
    return f"{d}-{pattern}-{secrets.token_hex(2)}"


def write_reflection(world: str, meta: dict, body: str) -> Path:
    """Append-only: a new file per occurrence, never overwrite."""
    pattern = reflection_pattern(body)
    if not pattern:
        raise ValueError("reflection body has no `Pattern: <slug>` line")
    rid = meta.get("id") or new_reflection_id(pattern)
    meta = {"id": rid, "world": world, "pattern": pattern, "created": meta.get("created") or datetime.now(timezone.utc).strftime("%Y-%m-%d"), **meta}
    path = paths.reflections_dir(world) / f"{rid}.md"
    if path.exists():
        raise FileExistsError(path)
    front = yaml.safe_dump({k: (str(v) if isinstance(v, Path) else v) for k, v in meta.items()}, sort_keys=False).strip()
    atomic_write(path, f"---\n{front}\n---\n{body.rstrip()}\n")
    return path


def pattern_counts(world: str, extra_dirs: list[Path] | None = None) -> dict[str, int]:
    counts: dict[str, int] = {}
    aliases = load_aliases(world)
    for r in list_reflections(world, extra_dirs):
        p = aliases.get(r.pattern, r.pattern)
        counts[p] = counts.get(p, 0) + 1
    return counts


# --- aliases ----------------------------------------------------------------

def load_aliases(world: str) -> dict[str, str]:
    """pattern -> canonical pattern. One hop only, on purpose."""
    p = paths.aliases_file(world)
    if not p.exists():
        return {}
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return {str(k): str(v) for k, v in (raw or {}).items() if is_slug(str(k)) and is_slug(str(v))}


def save_aliases(world: str, aliases: dict[str, str]) -> Path:
    p = paths.aliases_file(world)
    atomic_write(p, json.dumps(dict(sorted(aliases.items())), indent=2) + "\n")
    return p


# --- ledger -----------------------------------------------------------------

def load_ledger(path: Path) -> Ledger:
    """The ledger at `path`, or an empty one when there is no file.

    A corrupt ledger raises a ValueError naming the file. The raw
    JSONDecodeError named only a line and column, and the four call sites read
    four different paths, so the operator was told a ledger was broken without
    being told which one.
    """
    if not path.exists():
        return Ledger()
    try:
        raw = json.loads(path.read_text(encoding="utf-8") or "{}")
        if isinstance(raw, list):  # V1 shape: a bare list of entries
            raw = {"version": 1, "entries": {e["pattern"]: e for e in raw}}
        elif isinstance(raw, dict) and "entries" not in raw and all(isinstance(v, dict) for v in raw.values()):
            raw = {"version": 1, "entries": raw}
        return Ledger.model_validate(raw)
    except (ValueError, TypeError, KeyError) as e:
        raise ValueError(f"unreadable ledger {path}: {e}") from None


def save_ledger(path: Path, ledger: Ledger) -> Path:
    atomic_write(path, json.dumps(ledger.model_dump(mode="json", exclude_none=True), indent=2, sort_keys=True) + "\n")
    return path


def upsert_entry(ledger: Ledger, entry: PromotionEntry) -> Ledger:
    ledger.entries[entry.pattern] = entry
    return ledger


# --- inbox ------------------------------------------------------------------

def put_lesson(lesson: Lesson) -> Path:
    p = paths.inbox_dir(lesson.world) / f"{lesson.id}.json"
    atomic_write(p, lesson.model_dump_json(indent=2) + "\n")
    return p


def list_lessons(world: str) -> list[Lesson]:
    d = paths.inbox_dir(world)
    if not d.exists():
        return []
    out = []
    for p in sorted(d.glob("*.json")):
        try:
            out.append(Lesson.model_validate_json(p.read_text(encoding="utf-8")))
        except (OSError, ValueError, ValidationError):
            # One unreadable or off-schema inbox file is skipped; a bug in this
            # loop is not, so the catch names what a bad file can throw.
            continue
    out.sort(key=lambda l: l.created, reverse=True)
    return out
