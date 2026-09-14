"""Deterministic clustering and planning core of the loop.

Reflections are grouped by their alias-resolved `Pattern:` slug. A pattern seen
`threshold` times past its watermark is promotable; everything else is reported
rather than silently capped, so a run's output always accounts for every pattern.

New in V2: the plan reads artifact scorecards, so a promoted artifact whose
misfires outnumber its helpful votes comes back as `refine`, and one nobody has
used comes back as `retire-candidate`. Both are proposals. `run()` executes the
first and never the second.
"""

from __future__ import annotations

import importlib
import json
from pathlib import Path

from sil import config, paths, store
from sil.models import (
    Config, Ledger, PlanAction, PlanReport, Reflection, Scorecard, World,
)


def reflections(world: World, extra_dirs: list[Path] | None = None) -> list[Reflection]:
    """This world's reflections with operator-approved aliases already applied.

    World filtering happened in the store; alias resolution happens here, because
    the alias map is a property of the world's own knowledge and one hop only.
    """
    aliases = store.load_aliases(world.name)
    out: list[Reflection] = []
    for reflection in store.list_reflections(world.name, extra_dirs):
        canonical = aliases.get(reflection.pattern, reflection.pattern)
        out.append(reflection if canonical == reflection.pattern
                   else reflection.model_copy(update={"pattern": canonical}))
    return out


def cluster(items: list[Reflection]) -> dict[str, list[Reflection]]:
    """pattern -> its reflections, oldest first.

    Oldest first because the drafter's source window is filled from the newest
    end; handing it a list in the other order drops the lessons that correct the
    discipline rather than the ones it started from.
    """
    groups: dict[str, list[Reflection]] = {}
    for reflection in items:
        groups.setdefault(reflection.pattern, []).append(reflection)
    for group in groups.values():
        group.sort(key=lambda r: (r.created, r.id))
    return groups


def lesson_texts(items: list[Reflection]) -> list[str]:
    """The reusable lesson of each reflection, or its whole body when it has none."""
    return [(r.lesson or r.body or "").strip() for r in items]


def sources_text(items: list[Reflection]) -> str:
    """Every source reflection in full, for the deterministic grounding lint.

    Deliberately not the prompt's bounded view: an artifact must be grounded in
    all of its sources, not only the ones that fitted in the drafting context.
    """
    return "\n\n".join((r.body or "") for r in items)


def load_ledger(world: World) -> Ledger:
    return store.load_ledger(config.ledger_path(world))


def parse_ledger(text: str) -> Ledger:
    """A ledger read out of a git blob rather than the worktree.

    Mid-merge the file on disk can still carry conflict markers, and a staged
    branch's ledger is never checked out at all, so every branch-side read goes
    through here.
    """
    raw = json.loads(text or "{}")
    if isinstance(raw, list):  # V1 shape: a bare list of entries
        raw = {"version": 1, "entries": {e["pattern"]: e for e in raw}}
    elif isinstance(raw, dict) and "entries" not in raw and all(
            isinstance(v, dict) for v in raw.values()):
        raw = {"version": 1, "entries": raw}
    return Ledger.model_validate(raw)


def load_payload_corpus(world: World | None = None) -> list[dict]:
    """Recorded hook payloads the router executes a proposed gate against.

    The plugin's own corpus is always included: payloads are recorded shapes of
    Claude Code's own events, a property of the agent and not of whichever repo
    is being written into. Requiring every world to record its own made `hook`
    unreachable in all but one of them, and every hook-worthy pattern silently
    downgraded to `rule`.

    A world's target repo may add to it. A payload that exists but does not parse
    is loud: raising out of a bare comprehension named no file and took down a
    scheduled run that had nothing else wrong with it.
    """
    roots = [paths.plugin_root()]
    if world is not None:
        roots.append(config.target_root(world))
    out: list[dict] = []
    seen: set[Path] = set()
    for root in roots:
        directory = Path(root) / "tests" / "fixtures" / "hook-payloads"
        if directory in seen or not directory.is_dir():
            continue
        seen.add(directory)
        for path in sorted(directory.glob("*.json")):
            try:
                out.append(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError, ValueError) as e:
                raise ValueError(f"unreadable hook payload {path}: {e}") from None
    return out


def scorecards(world: World) -> list[Scorecard]:
    """Artifact scorecards, or none when the feedback half is not installed."""
    try:
        return list(importlib.import_module("sil.feedback").load(world))
    except Exception:  # noqa: BLE001 - a missing scorecard is no proposal, not a crash
        return []


def _scorecard_by_pattern(cards: list[Scorecard]) -> dict[str, Scorecard]:
    out: dict[str, Scorecard] = {}
    for card in cards:
        name = card.name or (card.ref.split(":", 1)[-1] if card.ref else "")
        if name:
            out.setdefault(name, card)
    return out


def watermark(ledger: Ledger, pattern: str) -> int:
    """The evidence level this pattern has to beat to be proposed again.

    The higher of the two marks. Promotion and rejection cost the same: a refused
    proposal needs `threshold` new reflections before it comes back, exactly as a
    promoted one does. Reading only the promotion mark is what made rejecting a
    treadmill in V1: three artifacts refused at 13:00 were re-staged
    byte-identical by 15:05.
    """
    entry = ledger.entries.get(pattern)
    if entry is None:
        return 0
    return max(entry.promoted_at_count, entry.rejected_at_count)


def plan(world: World, cfg: Config, *, extra_dirs: list[Path] | None = None,
         cards: list[Scorecard] | None = None,
         items: list[Reflection] | None = None) -> PlanReport:
    """What this world would do next, deterministic and sorted by pattern.

    Actions:
      promote          new evidence past the watermark, inside the per-run cap
      refine           a promoted artifact its scorecard says is misfiring
      over-cap         actionable, but the per-run budget is spent
      below-threshold  not enough evidence yet, and never promoted
      done             in the ledger, no new evidence since its watermark
      retire-candidate promoted and unused; surfaced for a human, never executed
    """
    threshold = cfg.promotion.threshold
    cap = cfg.promotion.per_run_cap
    ledger = load_ledger(world)
    groups = cluster(items if items is not None else reflections(world, extra_dirs))
    by_pattern = _scorecard_by_pattern(cards if cards is not None else scorecards(world))

    actions: list[PlanAction] = []
    for pattern in sorted(groups):
        group = groups[pattern]
        count = len(group)
        mark = watermark(ledger, pattern)
        entry = ledger.entries.get(pattern)
        card = by_pattern.get(pattern)
        sources = [r.id for r in group]

        action, reason = "below-threshold", ""
        if count - mark >= threshold:
            action = "promote"
            reason = f"{count - mark} new reflection(s) past the watermark {mark}"
        elif entry is not None and entry.status == "promoted" and card is not None:
            if card.proposal == "refine":
                action = "refine"
                reason = card.reason or "scorecard proposes a refine"
            elif card.proposal == "retire-candidate":
                action = "retire-candidate"
                reason = card.reason or "scorecard proposes retirement"
            else:
                action, reason = "done", f"watermark {mark}, {count} reflection(s)"
        elif entry is not None:
            action, reason = "done", f"watermark {mark}, {count} reflection(s)"
        else:
            reason = f"{count} reflection(s); the threshold is {threshold}"

        actions.append(PlanAction(pattern=pattern, count=count, watermark=mark,
                                  action=action, sources=sources, reason=reason))

    # Only actionable work spends the budget, in sorted-pattern order, so a run
    # is reproducible. `retire-candidate` is informational and costs nothing.
    budget = cap
    for item in actions:
        if item.action in ("promote", "refine"):
            if budget > 0:
                budget -= 1
            else:
                item.action = "over-cap"
                item.reason = f"over the per-run cap of {cap}"

    return PlanReport(world=world.name, threshold=threshold, actions=actions)
