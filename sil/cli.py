"""`sil` command line entry point.

Every subcommand imports its backend module lazily, inside the function body,
so a broken or not-yet-built module only breaks the one subcommand that needs
it rather than the whole CLI. `sil.config.ConfigError` is caught once, in
`main()`, and printed as a one-line message: configuration problems never show
a traceback.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from sil.consts import ARTIFACT_TYPES


# --- small shared helpers ----------------------------------------------------

def _resolve_world(cfg, name: str | None):
    from sil.config import world_for_cwd, world_named

    if name:
        return world_named(cfg, name)
    return world_for_cwd(cfg, Path.cwd())


def _ensure_learned_repo(path: Path) -> None:
    """Make sure a world's built-in `learned/` target repo exists and is a git
    repo. Prefers sil.gitutil (module C); falls back to a plain `git init`."""
    try:
        from sil import gitutil

        gitutil.ensure_repo(path)
        return
    except ModuleNotFoundError:
        pass
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)
    if not (path / ".git").exists():
        subprocess.run(["git", "init", "-b", "main", str(path)], check=True, capture_output=True)


# --- init ---------------------------------------------------------------------

def cmd_init(args: argparse.Namespace) -> int:
    from sil import paths
    from sil.config import load_config, load_llm, save_config, save_llm, write_hook_snapshot
    from sil.models import Config, Endpoint, LlmConfig, World

    cfg_path = paths.config_file()
    if cfg_path.exists():
        cfg = load_config()
        print(f"config.yaml already exists at {cfg_path}, leaving it as is")
    else:
        world = World(name=args.world or "default")
        if args.target:
            world.target = Path(args.target).expanduser()
        cfg = Config(worlds=[world])
        save_config(cfg)
        print(f"wrote {cfg_path}")

    llm_path = paths.llm_file()
    if llm_path.exists():
        print(f"llm.yaml already exists at {llm_path}, leaving it as is")
    else:
        endpoints = [
            Endpoint(
                name="litellm",
                kind="openai",
                base_url=args.llm_base_url or "http://127.0.0.1:4000",
                api_key_env=args.api_key_env or "LITELLM_API_KEY",
            ),
            Endpoint(name="claude", kind="claude-cli"),
        ]
        models = {}
        if args.model:
            models = {"critic": args.model, "drafter": args.model, "judge": args.model}
        llm = LlmConfig(endpoints=endpoints, active="litellm", models=models)
        save_llm(llm)
        print(f"wrote {llm_path}")
        if not models:
            print(
                "llm.yaml has no models set. Edit it and set models.critic, "
                "models.drafter and models.judge before running the worker, "
                "e.g. anthropic/claude-sonnet-5."
            )

    for world in cfg.worlds:
        if world.target is None:
            _ensure_learned_repo(paths.default_target(world.name))
        paths.reflections_dir(world.name).mkdir(parents=True, exist_ok=True)
        paths.inbox_dir(world.name).mkdir(parents=True, exist_ok=True)

    for bucket in ("pending", "done", "failed"):
        paths.queue_dir(bucket).mkdir(parents=True, exist_ok=True)
    for sub in ("logs", "sessions", "usage", "feedback"):
        (paths.state_dir() / sub).mkdir(parents=True, exist_ok=True)

    snap = write_hook_snapshot(cfg)
    print(f"wrote hook snapshot at {snap}")
    print()
    print("Next steps:")
    print("  sil status                              check worker and provider status")
    print("  sil web                                 open the review UI")
    print("  sil schedule install --systemd --web    run the worker and web UI on a schedule")
    return 0


# --- status ---------------------------------------------------------------

def cmd_status(args: argparse.Namespace) -> int:
    from sil.config import load_config

    cfg = load_config()

    worker_status: dict = {}
    queue_counts = {"pending": 0, "done": 0, "failed": 0}
    try:
        from sil import worker as workermod

        worker_status = workermod.status()
        for bucket in queue_counts:
            queue_counts[bucket] = len(workermod.queue_list(bucket))
    except ModuleNotFoundError:
        pass

    worlds_info = []
    for w in cfg.worlds:
        info = {
            "world": w.name,
            "llm": w.llm,
            "reflections": 0,
            "staged": 0,
            "artifacts": 0,
            "provider": {"endpoint": None, "reachable": None, "error": "unknown"},
        }
        try:
            from sil import store

            info["reflections"] = len(store.list_reflections(w.name))
        except ModuleNotFoundError:
            pass
        try:
            from sil import review

            info["staged"] = len(review.queue(w, cfg))
            info["artifacts"] = len(review.inventory(w, cfg))
        except ModuleNotFoundError:
            pass
        try:
            from sil import providers

            info["provider"] = providers.status(w)
        except ModuleNotFoundError:
            pass
        worlds_info.append(info)

    payload = {"worker": worker_status, "queue": queue_counts, "worlds": worlds_info}
    if args.json:
        print(json.dumps(payload, indent=2, default=str))
        return 0

    print(f"worker: {worker_status if worker_status else '(worker module not available)'}")
    print(
        f"queue: pending={queue_counts['pending']} "
        f"done={queue_counts['done']} failed={queue_counts['failed']}"
    )
    print()
    print(f"{'world':<16} {'llm':<6} {'reflections':>11} {'staged':>7} {'artifacts':>9}  provider")
    for info in worlds_info:
        prov = info["provider"]
        if prov.get("error"):
            prov_str = f"{prov.get('endpoint') or '?'} error: {prov['error']}"
        else:
            prov_str = f"{prov.get('endpoint')} reachable={prov.get('reachable')}"
        print(
            f"{info['world']:<16} {info['llm']:<6} {info['reflections']:>11} "
            f"{info['staged']:>7} {info['artifacts']:>9}  {prov_str}"
        )
    return 0


# --- reflect ----------------------------------------------------------------

def cmd_reflect(args: argparse.Namespace) -> int:
    from sil import paths
    from sil.models import QueueEntry
    from sil.store import atomic_write

    if not args.session and not args.cwd:
        print("error: sil reflect needs --session or --cwd", file=sys.stderr)
        return 2

    pending_dir = paths.queue_dir("pending")
    entry_path = None

    if args.session:
        # Same sanitization as sil.hook._safe_component: alnum, -, _, . only.
        safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in args.session)
        safe = safe if safe not in ("", ".", "..") else "_"
        candidate = pending_dir / f"{safe}.json"
        if candidate.exists():
            entry_path = candidate

    if entry_path is None and args.cwd:
        cwd = str(Path(args.cwd).expanduser().resolve())
        best = None
        if pending_dir.exists():
            for p in sorted(pending_dir.glob("*.json")):
                try:
                    entry = QueueEntry.model_validate_json(p.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                if str(entry.cwd) == cwd and not entry.ended:
                    if best is None or entry.last_stop > best[1]:
                        best = (p, entry.last_stop)
        if best:
            entry_path = best[0]

    if entry_path is None:
        print("no matching pending queue entry found", file=sys.stderr)
        return 2

    entry = QueueEntry.model_validate_json(entry_path.read_text(encoding="utf-8"))
    entry.ended = True
    atomic_write(entry_path, entry.model_dump_json(indent=2) + "\n")
    print(f"marked {entry.session_id} ended")

    if args.now:
        from sil.config import load_config
        from sil import worker as workermod

        cfg = load_config()
        result = workermod.run_once(cfg, world_name=entry.world, reflect=True, curriculum=False)
        print(f"worker ran: {result}")
    return 0


# --- worker -------------------------------------------------------------------

def cmd_worker(args: argparse.Namespace) -> int:
    from sil.config import load_config
    from sil import worker as workermod

    cfg = load_config()
    if args.loop:
        workermod.loop(cfg, args.interval_s)
        return 0
    result = workermod.run_once(
        cfg, world_name=args.world, reflect=True, curriculum=not args.no_curriculum
    )
    print(json.dumps(result, indent=2, default=str) if isinstance(result, dict) else str(result))
    return 0


# --- curriculum ---------------------------------------------------------------

def cmd_curriculum_plan(args: argparse.Namespace) -> int:
    from sil.config import load_config
    from sil import curriculum

    cfg = load_config()
    world = _resolve_world(cfg, args.world)
    report = curriculum.plan(world, cfg)
    if args.json:
        print(report.model_dump_json(indent=2))
        return 0
    print(f"world: {report.world}  threshold: {report.threshold}")
    for a in report.actions:
        print(f"  {a.pattern:<30} count={a.count:<3} watermark={a.watermark:<3} action={a.action:<16} {a.reason}")
    if not report.actions:
        print("  nothing to report")
    return 0


def cmd_curriculum_run(args: argparse.Namespace) -> int:
    from sil.config import load_config
    from sil import run as runmod

    from sil.worker import Lock, LockHeld

    cfg = load_config()
    world = _resolve_world(cfg, args.world)
    if not args.apply:
        report = runmod.run(world, cfg, apply=False)
    else:
        # Same lock as the worker and the accept path: two writers on the
        # target repo at once is how an unreviewed branch gets merged.
        try:
            with Lock():
                report = runmod.run(world, cfg, apply=True)
        except LockHeld:
            print("error: the worker holds the lock; retry in a moment", file=sys.stderr)
            return 2
    if args.json:
        print(report.model_dump_json(indent=2))
        return 0
    print(f"world: {report.world}  dry_run: {report.dry_run}")
    print(f"staged: {report.staged}")
    print(f"merged: {report.merged}")
    if report.gated_out:
        print("gated out:")
        for pattern, reason in report.gated_out.items():
            print(f"  {pattern}: {reason}")
    if report.error:
        print(f"error: {report.error}", file=sys.stderr)
    return 0


# --- review -------------------------------------------------------------------

def cmd_review_list(args: argparse.Namespace) -> int:
    from sil.config import load_config
    from sil import review as reviewmod

    cfg = load_config()
    world = _resolve_world(cfg, args.world)
    items = reviewmod.queue(world, cfg)
    if not items:
        print(f"no staged reviews for world {world.name}")
        return 0
    for it in items:
        print(f"{it.pattern:<30} {it.artifact_type.value:<6} count={it.count:<3} branch={it.branch}")
    return 0


def cmd_review_show(args: argparse.Namespace) -> int:
    from sil.config import load_config
    from sil import review as reviewmod

    cfg = load_config()
    world = _resolve_world(cfg, args.world)
    if args.diff:
        d = reviewmod.diff(world, cfg, args.pattern)
        print(d.diff)
        print(f"\nreviewed_state: {d.reviewed_state}")
        return 0
    detail = reviewmod.detail(world, cfg, args.pattern)
    print(f"pattern: {detail.pattern}")
    print(f"type: {detail.artifact_type.value}  path: {detail.artifact_path}")
    print(f"branch: {detail.branch}  count: {detail.count}")
    print(f"reviewed_state: {detail.reviewed_state}")
    if detail.accept_blocked:
        print(f"accept blocked: {detail.accept_blocked}")
    print()
    print(detail.body)
    return 0


def cmd_review_accept(args: argparse.Namespace) -> int:
    from sil.config import load_config, world_named
    from sil import review as reviewmod

    cfg = load_config()
    world = world_named(cfg, args.world)
    reviewmod.accept(world, cfg, args.pattern, args.reviewed_state)
    print(f"accepted {args.pattern} in world {world.name}")
    return 0


def cmd_review_reject(args: argparse.Namespace) -> int:
    from sil.config import load_config, world_named
    from sil import review as reviewmod

    cfg = load_config()
    world = world_named(cfg, args.world)
    reviewmod.reject(world, cfg, args.pattern)
    print(f"rejected {args.pattern} in world {world.name}")
    return 0


def cmd_review_rehome(args: argparse.Namespace) -> int:
    from sil.config import load_config, world_named
    from sil import review as reviewmod

    cfg = load_config()
    world = world_named(cfg, args.world)
    reviewmod.rehome(world, cfg, args.pattern, args.type)
    print(f"rehomed {args.pattern} to {args.type} in world {world.name}")
    return 0


def cmd_review_retire(args: argparse.Namespace) -> int:
    if not args.yes:
        print("error: sil review retire needs --yes to confirm", file=sys.stderr)
        return 2
    from sil.config import load_config, world_named
    from sil import review as reviewmod

    cfg = load_config()
    world = world_named(cfg, args.world)
    reviewmod.retire(world, cfg, args.pattern)
    print(f"retired {args.pattern} in world {world.name}")
    return 0


# --- reflections ----------------------------------------------------------

def cmd_reflections_list(args: argparse.Namespace) -> int:
    from sil.config import load_config
    from sil import store

    cfg = load_config()
    world = _resolve_world(cfg, args.world)
    items = store.list_reflections(world.name)
    if args.pattern:
        items = [r for r in items if r.pattern == args.pattern]
    if args.limit:
        items = items[: args.limit]
    if not items:
        print(f"no reflections for world {world.name}")
        return 0
    for r in items:
        print(f"{r.id:<40} {r.pattern:<24} {r.created}")
    return 0


def cmd_reflections_show(args: argparse.Namespace) -> int:
    from sil.config import load_config, world_named
    from sil import store

    cfg = load_config()
    world = world_named(cfg, args.world)
    match = next((r for r in store.list_reflections(world.name) if r.id == args.id), None)
    if not match:
        print(f"no reflection {args.id!r} in world {world.name}", file=sys.stderr)
        return 2
    print(match.body)
    return 0


# --- artifacts ------------------------------------------------------------

def cmd_artifacts(args: argparse.Namespace) -> int:
    from sil.config import load_config

    cfg = load_config()
    world = _resolve_world(cfg, args.world)

    if args.action == "rebuild":
        if not args.world:
            print("error: sil artifacts rebuild needs --world", file=sys.stderr)
            return 2
        from sil import feedback

        feedback.rebuild(world, cfg)
        print(f"rebuilt scorecards for world {world.name}")
        return 0

    from sil import feedback, review

    inventory = review.inventory(world, cfg)
    cards = feedback.scorecards(world, cfg)
    if args.json:
        payload = {
            "inventory": [row.model_dump(mode="json") for row in inventory],
            "scorecards": [c.model_dump(mode="json") for c in cards],
        }
        print(json.dumps(payload, indent=2, default=str))
        return 0
    if not inventory:
        print(f"no artifacts for world {world.name}")
        return 0
    for row in inventory:
        print(f"{row.pattern:<30} {row.artifact_type.value:<6} served_by={row.served_by} status={row.status}")
    return 0


# --- feedback ---------------------------------------------------------------

def cmd_feedback_add(args: argparse.Namespace) -> int:
    from sil.config import load_config
    from sil.models import HumanFeedback
    from sil import feedback as feedbackmod

    cfg = load_config()
    world = _resolve_world(cfg, args.world)
    fb = HumanFeedback(world=world.name, ref=args.ref, vote=args.vote, note=args.note or "")
    feedbackmod.record_human(fb)
    print(f"recorded {args.vote} vote for {args.ref} in world {world.name}")
    return 0


def cmd_feedback_list(args: argparse.Namespace) -> int:
    from sil.config import load_config
    from sil import feedback as feedbackmod

    cfg = load_config()
    for w in cfg.worlds:
        for e in feedbackmod.load(w):
            print(f"{e.ts}  {w.name:<16} {e.ref:<30} {e.vote:<4} {e.note}")
    return 0


# --- lessons ------------------------------------------------------------------

def cmd_lessons(args: argparse.Namespace) -> int:
    from sil.config import load_config
    from sil import store

    cfg = load_config()
    world = _resolve_world(cfg, args.world)
    items = store.list_lessons(world.name)
    if not items:
        print(f"no pending lessons for world {world.name}")
        return 0
    for lesson in items:
        print(f"{lesson.id}  {lesson.pattern}")
        print(f"  {lesson.text}")
    return 0


# --- web ------------------------------------------------------------------

def cmd_web(args: argparse.Namespace) -> int:
    from sil.config import load_config
    from sil.web import server

    cfg = load_config()
    port = args.port or cfg.web.port
    server.serve(args.host, port, token=not args.no_token, open_browser=args.open)
    return 0


# --- worlds -----------------------------------------------------------------

def cmd_worlds_list(args: argparse.Namespace) -> int:
    from sil.config import load_config

    cfg = load_config()
    if not cfg.worlds:
        print("no worlds configured")
        return 0
    for w in cfg.worlds:
        repos = ", ".join(str(r) for r in w.repos) or "(catch-all)"
        target = str(w.target) if w.target else "(learned/)"
        print(f"{w.name:<16} llm={w.llm:<6} remote={w.remote:<5} target={target}  repos={repos}")
    return 0


def cmd_worlds_add(args: argparse.Namespace) -> int:
    from sil.config import ConfigError, load_config, save_config, write_hook_snapshot
    from sil.models import Layout, World

    cfg = load_config()
    if any(w.name == args.name for w in cfg.worlds):
        raise ConfigError(f"world {args.name!r} already exists")

    if args.layout == "v1":
        layout = Layout(
            skills_dir="claude/skills",
            nudges_dir="claude/hooks/nudges",
            agents_dir="claude/agents",
            rules_file="global.CLAUDE.md",
            ledger="claude/skills/promotions.json",
        )
    else:
        layout = Layout()

    world = World(
        name=args.name,
        llm=args.llm or "cloud",
        repos=[Path(p).expanduser() for p in (args.repos or [])],
        target=Path(args.target).expanduser() if args.target else None,
        layout=layout,
    )
    cfg.worlds.append(world)
    save_config(cfg)
    write_hook_snapshot(cfg)
    print(f"added world {args.name} (layout: {args.layout})")
    return 0


def cmd_worlds_import_kb(args: argparse.Namespace) -> int:
    from sil.config import load_config, save_config, write_hook_snapshot
    from sil import importer

    cfg = load_config()
    imported = importer.import_worlds_yaml(args.path)
    cfg, added = importer.merge_worlds(cfg, imported)
    save_config(cfg)
    write_hook_snapshot(cfg)
    print(f"read {len(imported)} world(s) from {args.path}, added {added} new")
    return 0


# --- import -----------------------------------------------------------------

def cmd_import_reflections(args: argparse.Namespace) -> int:
    from sil.config import load_config, world_named
    from sil import importer

    cfg = load_config()
    world = world_named(cfg, args.world)
    result = importer.import_reflections(args.dir, world.name)
    print(
        f"copied {result['copied']}, skipped {result['skipped_duplicate']} duplicate, "
        f"{result['skipped_non_reflection']} non-reflection"
    )
    return 0


def cmd_import_ledger(args: argparse.Namespace) -> int:
    from sil.config import load_config, world_named
    from sil import importer

    cfg = load_config()
    world = world_named(cfg, args.world)
    count = importer.import_ledger(args.path, world)
    print(f"imported {count} ledger entries for world {world.name}")
    return 0


# --- schedule -----------------------------------------------------------------

def cmd_schedule_install(args: argparse.Namespace) -> int:
    from sil import schedule

    kind = "systemd" if args.systemd else "launchd"
    written = schedule.install(kind, interval_min=args.interval_min, web=args.web)
    for p in written:
        print(f"wrote {p}")
    return 0


def cmd_schedule_uninstall(args: argparse.Namespace) -> int:
    from sil import schedule

    removed = []
    for kind in ("systemd", "launchd"):
        removed.extend(schedule.uninstall(kind))
    if not removed:
        print("nothing installed")
        return 0
    for p in removed:
        print(f"removed {p}")
    return 0


def cmd_schedule_show(args: argparse.Namespace) -> int:
    from sil import schedule

    info = schedule.show()
    for kind, names in info.items():
        print(f"{kind}:")
        if not names:
            print("  (none installed)")
        for name in names:
            print(f"  {name}")
    return 0


# --- logs -----------------------------------------------------------------

def cmd_logs(args: argparse.Namespace) -> int:
    from sil import paths

    if args.name not in paths.LOG_NAMES:
        print(f"error: unknown log {args.name!r}, choose from {', '.join(paths.LOG_NAMES)}", file=sys.stderr)
        return 2
    p = paths.log_file(args.name)
    if not p.exists():
        print(f"no log file at {p}")
        return 0
    lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
    for line in lines[-args.lines :]:
        print(line)
    return 0


# --- hook-snapshot --------------------------------------------------------

def cmd_hook_snapshot(args: argparse.Namespace) -> int:
    from sil.config import load_config, write_hook_snapshot

    cfg = load_config()
    p = write_hook_snapshot(cfg)
    print(f"wrote {p}")
    return 0


# --- parser -------------------------------------------------------------------

def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="sil", description="self-improvement-loop engine")
    sub = parser.add_subparsers(dest="command")

    p = sub.add_parser("init", help="write config.yaml and llm.yaml templates")
    p.add_argument("--world")
    p.add_argument("--target")
    p.add_argument("--llm-base-url")
    p.add_argument("--api-key-env")
    p.add_argument("--model")
    p.set_defaults(func=cmd_init)

    p = sub.add_parser("status", help="worker, queue and world status")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("reflect", help="mark a session ended and optionally reflect now")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--session")
    g.add_argument("--cwd")
    p.add_argument("--now", action="store_true")
    p.set_defaults(func=cmd_reflect)

    p = sub.add_parser("worker", help="run the worker once or on a loop")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--once", action="store_true")
    g.add_argument("--loop", action="store_true")
    p.add_argument("--interval-s", type=int, default=300)
    p.add_argument("--world")
    p.add_argument("--no-curriculum", action="store_true")
    p.set_defaults(func=cmd_worker)

    curriculum = sub.add_parser("curriculum", help="preview or run promotion")
    curriculum_sub = curriculum.add_subparsers(dest="curriculum_command")

    p = curriculum_sub.add_parser("plan", help="dry-run preview, no model calls")
    p.add_argument("--world")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_curriculum_plan)

    p = curriculum_sub.add_parser("run", help="draft, gate and stage branches")
    p.add_argument("--world")
    p.add_argument("--apply", action="store_true")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_curriculum_run)

    review = sub.add_parser("review", help="staged artifact review")
    review_sub = review.add_subparsers(dest="review_command")

    p = review_sub.add_parser("list", help="list staged reviews")
    p.add_argument("--world")
    p.set_defaults(func=cmd_review_list)

    p = review_sub.add_parser("show", help="show one staged artifact")
    p.add_argument("pattern")
    p.add_argument("--world")
    p.add_argument("--diff", action="store_true")
    p.set_defaults(func=cmd_review_show)

    p = review_sub.add_parser("accept", help="accept a staged artifact")
    p.add_argument("pattern")
    p.add_argument("--world", required=True)
    p.add_argument("--reviewed-state", required=True)
    p.set_defaults(func=cmd_review_accept)

    p = review_sub.add_parser("reject", help="reject a staged artifact")
    p.add_argument("pattern")
    p.add_argument("--world", required=True)
    p.set_defaults(func=cmd_review_reject)

    p = review_sub.add_parser("rehome", help="change a staged artifact's type")
    p.add_argument("pattern")
    p.add_argument("--type", required=True, choices=list(ARTIFACT_TYPES))
    p.add_argument("--world", required=True)
    p.set_defaults(func=cmd_review_rehome)

    p = review_sub.add_parser("retire", help="retire a pattern")
    p.add_argument("pattern")
    p.add_argument("--world", required=True)
    p.add_argument("--yes", action="store_true")
    p.set_defaults(func=cmd_review_retire)

    reflections = sub.add_parser("reflections", help="read the reflection store")
    reflections_sub = reflections.add_subparsers(dest="reflections_command")

    p = reflections_sub.add_parser("list", help="list reflections")
    p.add_argument("--world")
    p.add_argument("--pattern")
    p.add_argument("--limit", type=int)
    p.set_defaults(func=cmd_reflections_list)

    p = reflections_sub.add_parser("show", help="print one reflection body")
    p.add_argument("id")
    p.add_argument("--world", required=True)
    p.set_defaults(func=cmd_reflections_show)

    p = sub.add_parser("artifacts", help="artifact inventory and scorecards")
    p.add_argument("action", nargs="?", choices=["rebuild"], default=None)
    p.add_argument("--world")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_artifacts)

    feedback = sub.add_parser("feedback", help="human votes on artifacts")
    feedback_sub = feedback.add_subparsers(dest="feedback_command")

    p = feedback_sub.add_parser("add", help="record a good/bad vote")
    p.add_argument("ref")
    p.add_argument("vote", choices=["good", "bad"])
    p.add_argument("--note")
    p.add_argument("--world")
    p.set_defaults(func=cmd_feedback_add)

    p = feedback_sub.add_parser("list", help="list recorded votes")
    p.set_defaults(func=cmd_feedback_list)

    p = sub.add_parser("lessons", help="show the inbox for a world")
    p.add_argument("--world")
    p.set_defaults(func=cmd_lessons)

    p = sub.add_parser("web", help="run the local review UI")
    p.add_argument("--port", type=int)
    p.add_argument("--no-token", action="store_true")
    p.add_argument("--open", action="store_true")
    p.add_argument("--host", default="127.0.0.1")
    p.set_defaults(func=cmd_web)

    worlds = sub.add_parser("worlds", help="manage worlds")
    worlds_sub = worlds.add_subparsers(dest="worlds_command")

    p = worlds_sub.add_parser("list", help="list configured worlds")
    p.set_defaults(func=cmd_worlds_list)

    p = worlds_sub.add_parser("add", help="add a world")
    p.add_argument("name")
    p.add_argument("--repos", nargs="*", default=[])
    p.add_argument("--target")
    p.add_argument("--llm", choices=["local", "cloud"])
    p.add_argument("--layout", choices=["v1", "default"], default="default")
    p.set_defaults(func=cmd_worlds_add)

    p = worlds_sub.add_parser("import-kb", help="import a V1 kb worlds.yaml manifest")
    p.add_argument("path")
    p.set_defaults(func=cmd_worlds_import_kb)

    imp = sub.add_parser("import", help="import V1 data")
    imp_sub = imp.add_subparsers(dest="import_command")

    p = imp_sub.add_parser("reflections", help="copy a V1 reflection mirror dir")
    p.add_argument("dir")
    p.add_argument("--world", required=True)
    p.set_defaults(func=cmd_import_reflections)

    p = imp_sub.add_parser("ledger", help="import a V1 promotions.json ledger")
    p.add_argument("path")
    p.add_argument("--world", required=True)
    p.set_defaults(func=cmd_import_ledger)

    schedule = sub.add_parser("schedule", help="systemd/launchd worker and web schedule")
    schedule_sub = schedule.add_subparsers(dest="schedule_command")

    p = schedule_sub.add_parser("install", help="install the schedule")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--systemd", action="store_true")
    g.add_argument("--launchd", action="store_true")
    p.add_argument("--web", action="store_true")
    p.add_argument("--interval-min", type=int, default=60)
    p.set_defaults(func=cmd_schedule_install)

    p = schedule_sub.add_parser("uninstall", help="remove the schedule")
    p.set_defaults(func=cmd_schedule_uninstall)

    p = schedule_sub.add_parser("show", help="show what is installed")
    p.set_defaults(func=cmd_schedule_show)

    p = sub.add_parser("logs", help="tail a log file")
    p.add_argument("name")
    p.add_argument("--lines", type=int, default=50)
    p.set_defaults(func=cmd_logs)

    p = sub.add_parser("hook-snapshot", help="rewrite the hook config snapshot")
    p.set_defaults(func=cmd_hook_snapshot)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    func = getattr(args, "func", None)
    if func is None:
        parser.print_help()
        return 1

    from sil.config import ConfigError

    try:
        result = func(args)
    except ConfigError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    except (ValueError, RuntimeError) as e:
        # ReviewError, GitError, ProviderError and friends: one line, no trace.
        print(f"error: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    return result if isinstance(result, int) else 0


if __name__ == "__main__":
    raise SystemExit(main())
