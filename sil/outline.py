"""Optional export of new reflections to Outline. Never a read dependency,
never raises: a failed export is best effort and reported, not fatal."""

from __future__ import annotations

import json
import os
import urllib.request
from pathlib import Path

from sil import paths
from sil.models import Config, World


def export_new(world: World, cfg: Config) -> dict:
    if world.outline is None:
        return {"skipped": "not configured"}

    api_key = os.environ.get(world.outline.api_key_env)
    if not api_key:
        return {"exported": 0, "errors": [f"env var {world.outline.api_key_env} is not set"]}

    marker_path = paths.state_dir() / f"outline-exported-{world.name}.txt"
    exported_ids = _read_marker(marker_path)

    counts = {"exported": 0, "errors": []}
    reflections_dir = paths.reflections_dir(world.name)
    if not reflections_dir.exists():
        return counts

    for p in sorted(reflections_dir.glob("*.md")):
        rid = p.stem
        if rid in exported_ids:
            continue
        try:
            body = p.read_text(encoding="utf-8")
        except OSError as e:
            counts["errors"].append(f"{rid}: {e}")
            continue
        payload = {"title": rid, "text": body, "collectionId": world.outline.collection_id, "publish": True}
        if world.outline.parent_document_id:
            payload["parentDocumentId"] = world.outline.parent_document_id
        try:
            _post(world.outline.base_url, api_key, payload)
        except Exception as e:
            counts["errors"].append(f"{rid}: {type(e).__name__}: {e}")
            continue
        _append_marker(marker_path, rid)
        exported_ids.add(rid)
        counts["exported"] += 1
    return counts


def _post(base_url: str, api_key: str, payload: dict) -> None:
    url = base_url.rstrip("/") + "/api/documents.create"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        resp.read()


def _read_marker(path: Path) -> set[str]:
    if not path.exists():
        return set()
    try:
        return {line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()}
    except OSError:
        return set()


def _append_marker(path: Path, rid: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(rid + "\n")
