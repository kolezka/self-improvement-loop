"""Background worker: reflect, curriculum, feedback, outline export. Runs
under a single-instance lock; a queue entry's failure never stops the run."""

from __future__ import annotations

import fcntl
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from sil import config, critic, feedback, outline, paths, store, transcript
from sil.models import Config, QueueEntry, now_iso


class LockHeld(RuntimeError):
    pass


class Lock:
    """Single-instance guard on `paths.worker_lock_file()`. Non-blocking
    `flock`; a lock file whose recorded pid is no longer alive is reclaimed."""

    def __init__(self, path: Path | None = None):
        self.path = path or paths.worker_lock_file()
        self._fh = None

    def __enter__(self) -> "Lock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fh = open(self.path, "a+")
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            fh.close()
            if self._reclaim_if_stale():
                return self.__enter__()
            raise LockHeld(f"worker lock held: {self.path}")
        fh.seek(0)
        fh.truncate()
        fh.write(str(os.getpid()))
        fh.flush()
        self._fh = fh
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        if self._fh:
            try:
                fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
            self._fh.close()
            self._fh = None
        return False

    def _reclaim_if_stale(self) -> bool:
        pid = _read_pid(self.path)
        if pid is None or _pid_alive(pid):
            return False
        try:
            self.path.unlink()
        except OSError:
            pass
        return True

    @classmethod
    def held(cls) -> bool:
        pid = _read_pid(paths.worker_lock_file())
        return pid is not None and _pid_alive(pid)


def _read_pid(path: Path) -> int | None:
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    try:
        return int(text)
    except ValueError:
        return None


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, owned by someone else
    except OSError:
        return False
    return True


# --- queue -------------------------------------------------------------------

def queue_list(bucket: str) -> list[QueueEntry]:
    d = paths.queue_dir(bucket)
    if not d.exists():
        return []
    out = []
    for p in sorted(d.glob("*.json")):
        try:
            out.append(QueueEntry.model_validate_json(p.read_text(encoding="utf-8")))
        except Exception:
            continue
    return out


def load_entry(bucket: str, session_id: str) -> QueueEntry | None:
    p = paths.queue_dir(bucket) / f"{session_id}.json"
    if not p.exists():
        return None
    try:
        return QueueEntry.model_validate_json(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def move_entry(entry: QueueEntry, from_bucket: str, to_bucket: str, result: str | None = None) -> Path:
    if result is not None:
        entry = entry.model_copy(update={"result": result})
    dest = paths.queue_dir(to_bucket) / f"{entry.session_id}.json"
    store.atomic_write(dest, entry.model_dump_json(indent=2) + "\n")
    src = paths.queue_dir(from_bucket) / f"{entry.session_id}.json"
    if src.exists() and src != dest:
        try:
            src.unlink()
        except OSError:
            pass
    return dest


def skip_session(session_id: str) -> bool:
    entry = load_entry("pending", session_id)
    if entry is None:
        return False
    move_entry(entry, "pending", "done", result="skipped by operator")
    return True


def eligible(entry: QueueEntry, cfg: Config, now: datetime) -> tuple[bool, str]:
    tp = Path(entry.transcript_path)
    if not tp.exists():
        return False, "failed: transcript missing"

    idle_ok = entry.ended
    if not idle_ok:
        try:
            mtime = datetime.fromtimestamp(tp.stat().st_mtime, tz=timezone.utc)
        except OSError:
            return False, "failed: transcript missing"
        idle_ok = (now - mtime).total_seconds() / 60 >= cfg.worker.idle_minutes
    if not idle_ok:
        return False, "not idle"

    tool_uses = entry.tool_uses or transcript.count_tool_uses(tp)
    if tool_uses < cfg.worker.min_tool_uses:
        return False, "below min_tool_uses"
    return True, "eligible"


# --- run ------------------------------------------------------------------------

def run_once(
    cfg: Config | None = None,
    *,
    world_name: str | None = None,
    reflect: bool = True,
    curriculum: bool = True,
    chat=None,
) -> dict:
    cfg = cfg or config.load_config()
    started = time.monotonic()
    summary: dict = {"reflected": [], "failed": [], "skipped": [], "curriculum": {}, "duration_s": 0.0}
    try:
        with Lock():
            config.write_hook_snapshot(cfg)
            now = datetime.now(timezone.utc)
            worlds = [w for w in cfg.worlds if world_name is None or w.name == world_name]
            world_by_name = {w.name: w for w in cfg.worlds}

            if reflect:
                _reflect_pending(cfg, world_by_name, world_name, now, chat, summary)

            for world in worlds:
                _run_curriculum_if_due(world, cfg, curriculum, now, summary)
                try:
                    feedback.rebuild(world, cfg)
                except Exception as e:
                    _log({"action": "feedback", "world": world.name, "result": f"failed: {e}"})
                if world.outline:
                    try:
                        outline.export_new(world, cfg)
                    except Exception as e:
                        _log({"action": "outline", "world": world.name, "result": f"failed: {e}"})

            summary["duration_s"] = round(time.monotonic() - started, 3)
            store.atomic_write(
                paths.state_dir() / "worker-status.json",
                json.dumps({"last_run": now_iso(), "last_summary": summary}, indent=2, default=str) + "\n",
            )
    except LockHeld:
        return {"skipped": "locked"}
    return summary


def _reflect_pending(cfg: Config, world_by_name: dict, world_name: str | None, now: datetime, chat, summary: dict) -> None:
    for entry in queue_list("pending"):
        if world_name is not None and entry.world != world_name:
            continue
        world = world_by_name.get(entry.world)
        if world is None:
            reason = f"failed: unknown world {entry.world!r}"
            move_entry(entry, "pending", "failed", result=reason)
            summary["failed"].append(entry.session_id)
            _log({"action": "reflect", "session_id": entry.session_id, "result": reason})
            continue

        ok, reason = eligible(entry, cfg, now)
        if not ok:
            if reason.startswith("failed"):
                move_entry(entry, "pending", "failed", result=reason)
                summary["failed"].append(entry.session_id)
            else:
                summary["skipped"].append(entry.session_id)
            _log({"action": "reflect", "session_id": entry.session_id, "result": reason})
            continue

        try:
            result = critic.reflect_session(entry, cfg=cfg, world=world, chat=chat)
            outcome = f"recorded:{result['pattern']}" if result["recorded"] else (result.get("reason") or "not recorded")
            move_entry(entry, "pending", "done", result=outcome)
            summary["reflected"].append(entry.session_id)
            _log({"action": "reflect", "session_id": entry.session_id, "result": "done"})
        except Exception as e:
            reason = f"failed: {type(e).__name__}: {e}"[:300]
            move_entry(entry, "pending", "failed", result=reason)
            summary["failed"].append(entry.session_id)
            _log({"action": "reflect", "session_id": entry.session_id, "result": reason})


def _run_curriculum_if_due(world, cfg: Config, curriculum: bool, now: datetime, summary: dict) -> None:
    marker = paths.state_dir() / f"last-curriculum-{world.name}"
    if not curriculum or not _curriculum_due(marker, cfg.worker.curriculum_interval_minutes, now):
        return
    try:
        from sil import run as curriculum_run

        report = curriculum_run.run(world, cfg, apply=True)
        summary["curriculum"][world.name] = report.model_dump(mode="json") if hasattr(report, "model_dump") else report
    except ImportError as e:
        summary["curriculum"][world.name] = {"error": f"curriculum module unavailable: {e}"}
    except Exception as e:
        summary["curriculum"][world.name] = {"error": str(e)}
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(now.isoformat(), encoding="utf-8")


def _curriculum_due(marker: Path, interval_minutes: int, now: datetime) -> bool:
    if not marker.exists():
        return True
    try:
        mtime = datetime.fromtimestamp(marker.stat().st_mtime, tz=timezone.utc)
    except OSError:
        return True
    return (now - mtime).total_seconds() / 60 >= interval_minutes


def _log(payload: dict) -> None:
    line = {"ts": now_iso(), **payload}
    p = paths.log_file("worker")
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(line, default=str) + "\n")


def status() -> dict:
    last_run = None
    last_summary = None
    p = paths.state_dir() / "worker-status.json"
    if p.exists():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            last_run = data.get("last_run")
            last_summary = data.get("last_summary")
        except (OSError, json.JSONDecodeError):
            pass

    last_curriculum: dict = {}
    d = paths.state_dir()
    if d.exists():
        for m in d.glob("last-curriculum-*"):
            world = m.name[len("last-curriculum-") :]
            try:
                last_curriculum[world] = datetime.fromtimestamp(m.stat().st_mtime, tz=timezone.utc).isoformat()
            except OSError:
                continue

    return {
        "lock_held": Lock.held(),
        "lock_pid": _read_pid(paths.worker_lock_file()),
        "pending": len(queue_list("pending")),
        "done": len(queue_list("done")),
        "failed": len(queue_list("failed")),
        "last_run": last_run,
        "last_summary": last_summary,
        "last_curriculum": last_curriculum,
    }


def loop(cfg: Config, interval_s: int) -> None:
    while True:
        run_once(cfg)
        time.sleep(interval_s)
