"""Per-artifact scorecards: usage, nudge fires, critic votes and human
feedback folded into one record the planner and web UI read."""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sil import config, critic, paths, store
from sil.models import Config, HumanFeedback, Ledger, Scorecard, World


def record_human(fb: HumanFeedback) -> Path:
    p = paths.human_feedback_file()
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a", encoding="utf-8") as fh:
        fh.write(fb.model_dump_json() + "\n")
    return p


def scorecards(world: World, cfg: Config, *, now: datetime | None = None, window_days: int = 30) -> list[Scorecard]:
    now = now or datetime.now(timezone.utc)
    window_start = now - timedelta(days=window_days)
    retire_cutoff = now - timedelta(days=cfg.promotion.retire_after_days)

    ledger = _load_ledger(world)
    refs: set[str] = set(critic.installed_artifacts(world, cfg))

    uses_by_ref: dict[str, int] = defaultdict(int)
    fires_by_ref: dict[str, int] = defaultdict(int)
    helpful_by_ref: dict[str, int] = defaultdict(int)
    misfired_by_ref: dict[str, int] = defaultdict(int)
    human_good_by_ref: dict[str, int] = defaultdict(int)
    human_bad_by_ref: dict[str, int] = defaultdict(int)
    last_ts_by_ref: dict[str, str] = {}

    def note_ts(ref: str, ts) -> None:
        if not ts:
            return
        if ref not in last_ts_by_ref or str(ts) > last_ts_by_ref[ref]:
            last_ts_by_ref[ref] = str(ts)

    for ev in _read_jsonl(paths.usage_events_file()):
        if ev.get("world") != world.name or ev.get("kind") not in ("skill", "agent"):
            continue
        ref = ev.get("ref")
        if not ref:
            continue
        refs.add(ref)
        note_ts(ref, ev.get("ts"))
        if _within(ev.get("ts"), window_start, now):
            uses_by_ref[ref] += 1

    for line in _read_jsonl(paths.nudge_fires_file()):
        pattern = line.get("pattern")
        if not pattern:
            continue
        ref = f"hook:{pattern}"
        refs.add(ref)
        note_ts(ref, line.get("ts"))
        if _within(line.get("ts"), window_start, now):
            fires_by_ref[ref] += 1

    for ev in _read_jsonl(paths.critic_feedback_file()):
        if ev.get("world") != world.name:
            continue
        ref = ev.get("ref")
        if not ref:
            continue
        refs.add(ref)
        note_ts(ref, ev.get("ts"))
        if ev.get("verdict") == "helpful":
            helpful_by_ref[ref] += 1
        elif ev.get("verdict") == "misfired":
            misfired_by_ref[ref] += 1

    for ev in _read_jsonl(paths.human_feedback_file()):
        if ev.get("world") != world.name:
            continue
        ref = ev.get("ref")
        if not ref:
            continue
        refs.add(ref)
        note_ts(ref, ev.get("ts"))
        if ev.get("vote") == "good":
            human_good_by_ref[ref] += 1
        elif ev.get("vote") == "bad":
            human_bad_by_ref[ref] += 1

    out = []
    for ref in sorted(refs):
        atype, _, name = ref.partition(":")
        uses = uses_by_ref.get(ref, 0)
        fires = fires_by_ref.get(ref, 0)
        helpful = helpful_by_ref.get(ref, 0)
        misfired = misfired_by_ref.get(ref, 0)
        human_good = human_good_by_ref.get(ref, 0)
        human_bad = human_bad_by_ref.get(ref, 0)
        last_used = last_ts_by_ref.get(ref)
        entry = ledger.entries.get(name)
        proposal, reason = _propose(
            entry, uses, fires, helpful, misfired, human_good, human_bad, last_used, now, retire_cutoff, cfg.promotion.retire_after_days
        )
        out.append(
            Scorecard(
                ref=ref,
                type=atype,
                name=name,
                uses_30d=uses,
                fires_30d=fires,
                helpful=helpful,
                misfired=misfired,
                human_good=human_good,
                human_bad=human_bad,
                last_used=last_used,
                proposal=proposal,
                reason=reason,
            )
        )
    return out


def _propose(entry, uses, fires, helpful, misfired, human_good, human_bad, last_used, now, retire_cutoff, retire_days):
    if entry is not None:
        updated = _parse_ts(entry.last_updated)
        if updated is not None and updated >= now - timedelta(days=7):
            return "new", f"promoted {(now - updated).days}d ago, within the 7 day new window"

    if entry is not None and entry.status == "promoted" and uses + fires == 0 and human_good == 0:
        last_dt = _parse_ts(last_used)
        stale = last_dt is None or last_dt < retire_cutoff
        if stale:
            return "retire-candidate", f"no uses or fires in the last window, last_used={last_used or 'never'}, older than {retire_days}d"

    if (misfired + human_bad) >= 2 and (misfired + human_bad) > (helpful + human_good):
        return "refine", f"misfired+human_bad={misfired + human_bad} exceeds helpful+human_good={helpful + human_good}"

    return "keep", "no signal strong enough to change"


def rebuild(world: World, cfg: Config) -> Path:
    cards = scorecards(world, cfg)
    path = paths.world_dir(world.name) / "scorecards.json"
    store.atomic_write(path, json.dumps([c.model_dump(mode="json") for c in cards], indent=2, default=str) + "\n")
    return path


def load(world: World) -> list[Scorecard]:
    path = paths.world_dir(world.name) / "scorecards.json"
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    out = []
    for item in raw if isinstance(raw, list) else []:
        try:
            out.append(Scorecard.model_validate(item))
        except Exception:
            continue
    return out


def _load_ledger(world: World) -> Ledger:
    try:
        return store.load_ledger(config.ledger_path(world))
    except Exception:
        return Ledger()


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(obj, dict):
            out.append(obj)
    return out


def _parse_ts(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return None


def _within(ts, start: datetime, end: datetime) -> bool:
    t = _parse_ts(ts)
    return t is not None and start <= t <= end
