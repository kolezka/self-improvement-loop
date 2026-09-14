"""The ops registry: the only surface the web UI (and, later, the CLI) may
invoke to read or mutate loop state.

A caller names an op and supplies a payload dict. The op's `args_model`
validates the payload; the op's `fn` receives the validated args and returns
JSON-serialisable data (plain values, dicts, lists, or pydantic models, which
`invoke()` dumps to plain JSON). No caller builds a path, a branch name or a
shell command directly: every op function does that internally, so a bad slug
or a wrong reviewed_state digest fails at validation, before anything runs.

Every backend function this module calls (`sil.config`, `sil.store`,
`sil.worker`, `sil.feedback`, `sil.providers`, `sil.review`, `sil.run`,
`sil.paths`) is imported lazily inside the op function that needs it, never at
module level. Those modules are built by other groups in parallel; importing
them at module load time would make `import sil.ops` fail before they exist.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Literal

from pydantic import BaseModel, Field, field_validator

# A pattern or reflection id becomes a filesystem path or a git ref elsewhere in
# the engine. Enforced here too, at the HTTP boundary, rather than trusted from
# callers: git and the filesystem both accept characters that would be a path
# traversal or a shell metacharacter.
SLUG_RE = r"^[a-z0-9]+(?:-[a-z0-9]+)*$"
REVIEWED_STATE_RE = r"^[0-9a-f]{64}$"
FEEDBACK_REF_RE = r"^(skill|hook|rule|agent):[a-z0-9-]+$"


# --- tiers and gates ---------------------------------------------------------

class Tier(str, Enum):
    READ = "read"      # no writes
    LOCAL = "local"     # writes only this machine
    REMOTE = "remote"   # can push, open a PR, or otherwise leave this machine


class Gate(str, Enum):
    NONE = "none"
    REVIEWED_STATE = "reviewed_state"  # payload must carry the exact digest reviewed
    CONFIRM = "confirm"                # payload must carry confirm: true


@dataclass(frozen=True)
class Op:
    name: str               # "area.verb"
    tier: Tier
    args_model: type[BaseModel]
    fn: Callable[[BaseModel], Any]
    gate: Gate = Gate.NONE
    doc: str = ""


REGISTRY: dict[str, Op] = {}


def register(op: Op) -> Op:
    """Add an op to the registry, refusing one that understates its own risk."""
    if op.name in REGISTRY:
        raise ValueError(f"duplicate op name: {op.name!r}")
    if op.tier == Tier.REMOTE and op.gate == Gate.NONE:
        raise ValueError(f"{op.name}: a REMOTE op must declare a gate other than NONE")
    if ("accept" in op.name or "push" in op.name) and op.tier != Tier.REMOTE:
        raise ValueError(f"{op.name}: name implies a remote write; must be tier REMOTE")
    REGISTRY[op.name] = op
    return op


def _jsonable(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, Path):
        return str(value)
    return value


def invoke(name: str, payload: dict) -> Any:
    op = REGISTRY.get(name)
    if op is None:
        raise ValueError(f"unknown op: {name!r}")
    args = op.args_model.model_validate(payload or {})
    return _jsonable(op.fn(args))


def list_ops() -> list[dict]:
    """Meta listing for `GET /api/ops`: enough for the UI to render buttons."""
    return [
        {"name": op.name, "tier": op.tier.value, "gate": op.gate.value, "doc": op.doc}
        for op in sorted(REGISTRY.values(), key=lambda o: o.name)
    ]


def _spawn_detached(cmd: list[str], log_name: str) -> dict:
    """Start a background process outside the request/response cycle. Its
    output goes to the named engine log; the caller gets the pid back so the
    UI can say "started" without waiting for it to finish."""
    from sil import paths

    log_path = paths.log_file(log_name)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "ab") as log_fh:
        proc = subprocess.Popen(
            cmd,
            stdout=log_fh,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    return {"pid": proc.pid, "log": str(log_path)}


# --- argument models ----------------------------------------------------------

class NoArgs(BaseModel):
    pass


class WorldArgs(BaseModel):
    world: str = Field(min_length=1)


class PatternArgs(WorldArgs):
    pattern: str = Field(pattern=SLUG_RE, max_length=64)


class AcceptArgs(PatternArgs):
    reviewed_state: str = Field(pattern=REVIEWED_STATE_RE)


class RehomeArgs(PatternArgs):
    artifact_type: Literal["skill", "hook", "rule", "agent", "none"]


class RetireArgs(PatternArgs):
    confirm: Literal[True]


class SessionArgs(BaseModel):
    session_id: str = Field(min_length=1)


class FeedbackArgs(BaseModel):
    world: str = Field(min_length=1)
    ref: str = Field(pattern=FEEDBACK_REF_RE)
    vote: Literal["good", "bad"]
    note: str = ""


class LogArgs(BaseModel):
    name: str
    lines: int = Field(default=200, ge=1, le=2000)

    @field_validator("name")
    @classmethod
    def _known_log(cls, v: str) -> str:
        from sil.paths import LOG_NAMES

        if v not in LOG_NAMES:
            raise ValueError(f"unknown log {v!r}; must be one of {LOG_NAMES}")
        return v


class LlmArgs(BaseModel):
    llm: dict


class ConfigArgs(BaseModel):
    config: dict


class AliasArgs(BaseModel):
    world: str = Field(min_length=1)
    aliases: dict[str, str]

    @field_validator("aliases")
    @classmethod
    def _slug_map(cls, v: dict[str, str]) -> dict[str, str]:
        import re

        rx = re.compile(SLUG_RE)
        for k, val in v.items():
            if not rx.match(k) or not rx.match(val):
                raise ValueError(f"alias entries must be slugs: {k!r} -> {val!r}")
        return v


class ReflectionArgs(WorldArgs):
    id: str = Field(pattern=SLUG_RE, max_length=128)


class ReflectionListArgs(WorldArgs):
    pattern: str | None = Field(default=None, pattern=SLUG_RE, max_length=64)
    limit: int | None = Field(default=None, ge=1, le=2000)


def _cfg_world(name: str):
    """Resolve a world name from the request into (Config, World)."""
    from sil import config as config_mod

    cfg = config_mod.load_config()
    return cfg, config_mod.world_named(cfg, name)


# --- health / worlds / config -------------------------------------------------

def _health_report(args: NoArgs) -> dict:
    from sil import config as config_mod
    from sil import paths

    cfg = config_mod.load_config()
    providers_status: dict[str, Any] = {}
    for w in cfg.worlds:
        try:
            from sil import providers as providers_mod

            providers_status[w.name] = providers_mod.status(w.name)
        except Exception as e:
            providers_status[w.name] = {"error": f"{type(e).__name__}: {e}"}
    try:
        from sil import worker as worker_mod

        worker_status = worker_mod.status()
    except Exception as e:
        worker_status = {"error": f"{type(e).__name__}: {e}"}
    return {
        "worlds": [w.name for w in cfg.worlds],
        "config_file": str(paths.config_file()),
        "llm_file": str(paths.llm_file()),
        "state_dir": str(paths.state_dir()),
        "data_dir": str(paths.data_dir()),
        "plugin_root": str(paths.plugin_root()),
        "providers": providers_status,
        "worker": worker_status,
        "versions": {"sil": __import__("sil").__version__},
    }


def _worlds_list(args: NoArgs) -> list:
    from sil import config as config_mod

    return config_mod.load_config().worlds


def _config_get(args: NoArgs) -> Any:
    from sil import config as config_mod

    return config_mod.load_config()


def _config_set(args: ConfigArgs) -> Any:
    from sil import config as config_mod
    from sil.models import Config

    cfg = Config.model_validate(args.config)
    config_mod.save_config(cfg)
    config_mod.write_hook_snapshot(cfg)
    return cfg


# --- llm ----------------------------------------------------------------------

def _llm_get(args: NoArgs) -> Any:
    from sil import config as config_mod

    return config_mod.load_llm()


def _llm_set(args: LlmArgs) -> Any:
    from sil import config as config_mod
    from sil.models import LlmConfig

    llm = LlmConfig.model_validate(args.llm)
    config_mod.save_llm(llm)
    return llm


def _llm_status(args: WorldArgs) -> dict:
    from sil import providers as providers_mod

    _cfg, world = _cfg_world(args.world)
    return providers_mod.status(world)


# --- queue / worker -------------------------------------------------------

def _queue_list(args: NoArgs) -> dict:
    from sil import worker as worker_mod

    return {
        "pending": worker_mod.queue_list("pending"),
        "done": worker_mod.queue_list("done"),
        "failed": worker_mod.queue_list("failed"),
    }


def _queue_skip(args: SessionArgs) -> dict:
    from sil import worker as worker_mod

    return {"session_id": args.session_id, "skipped": worker_mod.skip_session(args.session_id)}


def _worker_status(args: NoArgs) -> dict:
    from sil import worker as worker_mod

    return worker_mod.status()


def _loop_run(args: WorldArgs) -> dict:
    from sil import paths

    cmd = ["uv", "run", "--project", str(paths.plugin_root()), "sil", "worker", "--once"]
    if args.world:
        cmd += ["--world", args.world]
    return _spawn_detached(cmd, "worker")


# --- curriculum -----------------------------------------------------------

def _curriculum_plan(args: WorldArgs) -> Any:
    from sil import curriculum as curriculum_mod

    cfg, world = _cfg_world(args.world)
    return curriculum_mod.plan(world, cfg)


def _curriculum_run(args: WorldArgs) -> dict:
    return _spawn_detached(["sil", "curriculum", "run", "--apply", "--world", args.world], "curriculum")


# --- reflections ------------------------------------------------------------

def _reflections_list(args: ReflectionListArgs) -> list[dict]:
    from sil import store

    refs = store.list_reflections(args.world)
    if args.pattern:
        refs = [r for r in refs if r.pattern == args.pattern]
    if args.limit:
        refs = refs[: args.limit]
    return [
        {
            "id": r.id,
            "pattern": r.pattern,
            "created": r.created,
            "lesson": r.lesson,
            "artifacts_used": r.artifacts_used,
            "artifacts_helpful": r.artifacts_helpful,
            "artifacts_misfired": r.artifacts_misfired,
        }
        for r in refs
    ]


def _reflections_get(args: ReflectionArgs) -> Any:
    from sil import paths, store

    path = paths.reflections_dir(args.world) / f"{args.id}.md"
    r = store.parse_reflection(path, args.world)
    if r is None:
        raise ValueError(f"no reflection {args.id!r} in world {args.world!r}")
    return r


# --- aliases ------------------------------------------------------------------

def _aliases_get(args: WorldArgs) -> dict:
    from sil import store

    return store.load_aliases(args.world)


def _aliases_set(args: AliasArgs) -> dict:
    from sil import store

    store.save_aliases(args.world, args.aliases)
    return store.load_aliases(args.world)


# --- review -------------------------------------------------------------------

def _review_queue(args: WorldArgs) -> Any:
    from sil import review as review_mod

    cfg, world = _cfg_world(args.world)
    return review_mod.queue(world, cfg)


def _review_detail(args: PatternArgs) -> Any:
    from sil import review as review_mod

    cfg, world = _cfg_world(args.world)
    return review_mod.detail(world, cfg, args.pattern)


def _review_diff(args: PatternArgs) -> Any:
    from sil import review as review_mod

    cfg, world = _cfg_world(args.world)
    return review_mod.diff(world, cfg, args.pattern)


def _skill_accept(args: AcceptArgs) -> Any:
    from sil import review as review_mod

    cfg, world = _cfg_world(args.world)
    return review_mod.accept(world, cfg, args.pattern, args.reviewed_state)


def _skill_reject(args: PatternArgs) -> Any:
    from sil import review as review_mod

    cfg, world = _cfg_world(args.world)
    return review_mod.reject(world, cfg, args.pattern)


def _router_rehome(args: RehomeArgs) -> Any:
    from sil import review as review_mod

    cfg, world = _cfg_world(args.world)
    return review_mod.rehome(world, cfg, args.pattern, args.artifact_type)


def _router_retire(args: RetireArgs) -> Any:
    from sil import review as review_mod

    cfg, world = _cfg_world(args.world)
    return review_mod.retire(world, cfg, args.pattern)


def _router_inventory(args: WorldArgs) -> Any:
    from sil import review as review_mod

    cfg, world = _cfg_world(args.world)
    return review_mod.inventory(world, cfg)


# --- artifacts / feedback -------------------------------------------------

def _artifacts_scorecards(args: WorldArgs) -> Any:
    from sil import feedback as feedback_mod

    _cfg, world = _cfg_world(args.world)
    return feedback_mod.load(world)


def _artifacts_rebuild(args: WorldArgs) -> dict:
    from sil import feedback as feedback_mod

    cfg, world = _cfg_world(args.world)
    path = feedback_mod.rebuild(world, cfg)
    return {"world": args.world, "path": str(path)}


def _feedback_add(args: FeedbackArgs) -> Any:
    from sil import feedback as feedback_mod
    from sil.models import HumanFeedback

    hf = HumanFeedback(world=args.world, ref=args.ref, vote=args.vote, note=args.note)
    path = feedback_mod.record_human(hf)
    return {"path": str(path), "feedback": hf}


def _lessons_list(args: WorldArgs) -> Any:
    from sil import store

    return store.list_lessons(args.world)


# --- logs -----------------------------------------------------------------

def _tail_lines(path: Path, n: int) -> list[str]:
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8", errors="replace")
    return text.splitlines()[-n:]


def _logs_tail(args: LogArgs) -> dict:
    from sil import paths

    path = paths.log_file(args.name)
    return {"name": args.name, "path": str(path), "lines": _tail_lines(path, args.lines)}


# --- registration ---------------------------------------------------------

register(Op("health.report", Tier.READ, NoArgs, _health_report,
            doc="Config paths, per-world provider status, worker status, versions."))
register(Op("worlds.list", Tier.READ, NoArgs, _worlds_list, doc="List configured worlds."))
register(Op("config.get", Tier.READ, NoArgs, _config_get, doc="Read config.yaml."))
register(Op("config.set", Tier.LOCAL, ConfigArgs, _config_set,
            doc="Validate and write config.yaml; refresh the hook snapshot."))
register(Op("llm.get", Tier.READ, NoArgs, _llm_get,
            doc="Read llm.yaml. Never includes secret values, only env var names."))
register(Op("llm.set", Tier.LOCAL, LlmArgs, _llm_set, doc="Validate and write llm.yaml."))
register(Op("llm.status", Tier.READ, WorldArgs, _llm_status, doc="Provider reachability for a world."))
register(Op("queue.list", Tier.READ, NoArgs, _queue_list, doc="Pending, done and failed queue entries."))
register(Op("queue.skip", Tier.LOCAL, SessionArgs, _queue_skip, doc="Skip a pending session."))
register(Op("worker.status", Tier.READ, NoArgs, _worker_status, doc="Worker lock/last-run status."))
register(Op("loop.run", Tier.LOCAL, WorldArgs, _loop_run, doc="Spawn a detached worker --once run."))
register(Op("curriculum.plan", Tier.READ, WorldArgs, _curriculum_plan, doc="Dry-run curriculum plan for a world."))
register(Op("curriculum.run", Tier.LOCAL, WorldArgs, _curriculum_run,
            doc="Spawn a detached curriculum run --apply for a world."))
register(Op("reflections.list", Tier.READ, ReflectionListArgs, _reflections_list,
            doc="List reflections, newest first, filterable by pattern."))
register(Op("reflections.get", Tier.READ, ReflectionArgs, _reflections_get, doc="Full body of one reflection."))
register(Op("aliases.get", Tier.READ, WorldArgs, _aliases_get, doc="Pattern alias map for a world."))
register(Op("aliases.set", Tier.LOCAL, AliasArgs, _aliases_set, doc="Replace the alias map for a world."))
register(Op("review.queue", Tier.READ, WorldArgs, _review_queue, doc="Staged proposals waiting for review."))
register(Op("review.detail", Tier.READ, PatternArgs, _review_detail, doc="Body and reviewed_state of one proposal."))
register(Op("review.diff", Tier.READ, PatternArgs, _review_diff, doc="Diff of one staged proposal."))
register(Op("skill.accept", Tier.REMOTE, AcceptArgs, _skill_accept, gate=Gate.REVIEWED_STATE,
            doc="Accept a staged proposal; reviewed_state must match exactly what was reviewed."))
register(Op("skill.reject", Tier.LOCAL, PatternArgs, _skill_reject, doc="Reject a staged proposal; delete its branch."))
register(Op("router.rehome", Tier.LOCAL, RehomeArgs, _router_rehome, doc="Re-route a pattern to a different artifact type."))
register(Op("router.retire", Tier.LOCAL, RetireArgs, _router_retire, gate=Gate.CONFIRM,
            doc="Retire an artifact; requires confirm: true."))
register(Op("router.inventory", Tier.READ, WorldArgs, _router_inventory, doc="Router state joined with scorecards."))
register(Op("artifacts.scorecards", Tier.READ, WorldArgs, _artifacts_scorecards, doc="Per-artifact usage scorecards."))
register(Op("artifacts.rebuild", Tier.LOCAL, WorldArgs, _artifacts_rebuild, doc="Recompute scorecards for a world."))
register(Op("feedback.add", Tier.LOCAL, FeedbackArgs, _feedback_add, doc="Record a human good/bad vote on an artifact."))
register(Op("lessons.list", Tier.READ, WorldArgs, _lessons_list, doc="Inbox lessons for a world."))
register(Op("logs.tail", Tier.READ, LogArgs, _logs_tail, doc="Last N lines of one engine log."))
