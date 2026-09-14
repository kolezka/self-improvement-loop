"""The one critic implementation: one model call per session, reporter not
fixer. Builds a reflection from the transcript evidence pack, never debugs or
fixes anything itself."""

from __future__ import annotations

import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from sil import config, paths, providers, store, transcript
from sil.models import Config, Lesson, LlmConfig, QueueEntry, World, now_iso

# `evidence-level-overclaim` is closed: reuse it only when the mechanism
# matches exactly. Never coin an evidence-grade sibling (overclaimed-*,
# unverified-*, insufficient-evidence-*); name the mechanism instead
# (stale-cached-env, relayed-subagent-claim, absence-from-filtered-view).
CLOSED_PATTERNS = {"evidence-level-overclaim"}


# --- installed artifacts ------------------------------------------------------

def installed_artifacts(world: World, cfg: Config) -> list[str]:
    """Every artifact ref this world currently has installed, from the
    ledger's promoted entries and a scan of the target repo's layout dirs.
    Never raises: a missing dir or file just contributes nothing."""
    refs: set[str] = set()
    try:
        ledger = store.load_ledger(config.ledger_path(world))
        for entry in ledger.entries.values():
            if entry.status == "promoted":
                refs.add(f"{entry.artifact_type.value}:{entry.pattern}")
    except Exception:
        pass

    try:
        root = config.target_root(world)
    except Exception:
        return sorted(refs)

    skills_dir = root / world.layout.skills_dir
    if skills_dir.is_dir():
        for p in skills_dir.iterdir():
            if p.is_dir():
                refs.add(f"skill:{p.name}")

    nudges_dir = root / world.layout.nudges_dir
    if nudges_dir.is_dir():
        for p in nudges_dir.glob("*.json"):
            refs.add(f"hook:{_nudge_pattern(p)}")

    agents_dir = root / world.layout.agents_dir
    if agents_dir.is_dir():
        for p in agents_dir.glob("*.md"):
            refs.add(f"agent:{p.stem}")

    rules_file = root / world.layout.rules_file
    if rules_file.is_file():
        try:
            text = rules_file.read_text(encoding="utf-8")
        except OSError:
            text = ""
        for m in re.finditer(r"<!--rule:([a-z0-9-]+)-->", text):
            refs.add(f"rule:{m.group(1)}")

    return sorted(refs)


def _nudge_pattern(p: Path) -> str:
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return p.stem
    if isinstance(data, dict) and data.get("pattern"):
        return str(data["pattern"])
    return p.stem


# --- prompt --------------------------------------------------------------------

def build_messages(
    pack: dict,
    *,
    world: World,
    existing_patterns: dict[str, int],
    installed_artifacts: list[str],
    recent_titles: list[str],
) -> list[dict]:
    system = (
        "You are a reporter, not a fixer. Audit the claims in this evidence pack "
        "against the recorded tool calls and their results, not the assistant's "
        "prose alone. Output STRICT JSON only, no prose, no code fence, with "
        "exactly these keys: record (bool), pattern (kebab-case slug or null), "
        "what_worked (string), what_failed (string), lesson (string, one "
        "concrete imperative rule, <= 300 chars), verification (string: what "
        "the evidence shows, commands and exit codes), not_verified (list of "
        "strings), lesson_short (string <= 200 chars for a future session, or "
        "null), confidence (number 0..1), artifacts_used (list of strings), "
        "artifacts_helpful (list of strings), artifacts_misfired (list of "
        '{"ref": string, "reason": string}), rules_relevant (list of strings). '
        "artifacts_used/artifacts_helpful/artifacts_misfired/rules_relevant "
        "must only reference refs from the installed artifacts list, or ones "
        "derivable from the pack's skills_used/agents_used/hooks fields. Set "
        "record false and pattern null when there is no concrete reusable "
        "lesson.\n\n"
        f"The slug(s) {sorted(CLOSED_PATTERNS)} are CLOSED: reuse one only when "
        "the mechanism matches exactly, never coin a sibling like overclaimed-*, "
        "unverified-* or insufficient-evidence-*. Name the mechanism (e.g. "
        "stale-cached-env, relayed-subagent-claim, absence-from-filtered-view), "
        "never the evidence grade. Reuse an existing pattern slug below when its "
        "mechanism matches this occurrence rather than coining a near-duplicate."
    )
    existing_desc = ", ".join(f"{p} ({n})" for p, n in sorted(existing_patterns.items())) or "none yet"
    user = {
        "world": world.name,
        "existing_patterns": existing_patterns,
        "installed_artifacts": installed_artifacts,
        "recent_reflection_ids": recent_titles,
        "evidence": pack,
    }
    return [
        {"role": "system", "content": system},
        {
            "role": "user",
            "content": (
                f"Existing pattern slugs and occurrence counts for world "
                f"{world.name!r}: {existing_desc}. Reuse one when the mechanism "
                "matches this occurrence.\n\nEvidence pack (JSON):\n"
                + json.dumps(user, default=str)
            ),
        },
    ]


# --- answer parsing --------------------------------------------------------------

_FENCE_RE = re.compile(r"\A```[a-zA-Z]*\s*\n(.*?)\n?```\s*\Z", re.DOTALL)


def parse_answer(text: str) -> dict:
    cleaned = (text or "").strip()
    m = _FENCE_RE.match(cleaned)
    if m:
        cleaned = m.group(1).strip()

    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1 or end < start:
        return _rejected("no JSON object found in critic reply")

    try:
        data = json.loads(cleaned[start : end + 1])
    except (json.JSONDecodeError, ValueError) as e:
        return _rejected(f"unparseable critic reply: {e}")
    if not isinstance(data, dict):
        return _rejected("critic reply JSON is not an object")
    return _validated(data)


def _rejected(reason: str) -> dict:
    return {
        "record": False,
        "pattern": None,
        "what_worked": "",
        "what_failed": "",
        "lesson": "",
        "verification": "",
        "not_verified": [reason],
        "lesson_short": None,
        "confidence": 0.0,
        "artifacts_used": [],
        "artifacts_helpful": [],
        "artifacts_misfired": [],
        "rules_relevant": [],
        "reason": reason,
    }


def _validated(data: dict) -> dict:
    record = bool(data.get("record"))
    pattern = data.get("pattern")
    if pattern is not None:
        pattern = re.sub(r"-+", "-", str(pattern).strip().lower().replace(" ", "-"))
    if record and (not pattern or not store.is_slug(pattern)):
        return _rejected(f"record is true but pattern {pattern!r} is not a valid slug")

    try:
        confidence = max(0.0, min(1.0, float(data.get("confidence", 0.0))))
    except (TypeError, ValueError):
        confidence = 0.0

    lesson_short = data.get("lesson_short")
    return {
        "record": record,
        "pattern": pattern if record else None,
        "what_worked": str(data.get("what_worked") or ""),
        "what_failed": str(data.get("what_failed") or ""),
        "lesson": str(data.get("lesson") or "")[:300],
        "verification": str(data.get("verification") or ""),
        "not_verified": _str_list(data.get("not_verified")),
        "lesson_short": str(lesson_short)[:200] if lesson_short else None,
        "confidence": confidence,
        "artifacts_used": _str_list(data.get("artifacts_used")),
        "artifacts_helpful": _str_list(data.get("artifacts_helpful")),
        "artifacts_misfired": _misfired_list(data.get("artifacts_misfired")),
        "rules_relevant": _str_list(data.get("rules_relevant")),
        "reason": None,
    }


def _str_list(val) -> list[str]:
    return [str(x) for x in val] if isinstance(val, list) else []


def _misfired_list(val) -> list[dict]:
    if not isinstance(val, list):
        return []
    out = []
    for item in val:
        if isinstance(item, dict) and item.get("ref"):
            out.append({"ref": str(item["ref"]), "reason": str(item.get("reason") or "")})
        elif isinstance(item, str) and item:
            out.append({"ref": item, "reason": ""})
    return out


# --- reflect ---------------------------------------------------------------------

def reflect_session(
    entry: QueueEntry,
    *,
    cfg: Config,
    world: World,
    llm: LlmConfig | None = None,
    chat=None,
) -> dict:
    chat_fn = chat or providers.chat
    llm_cfg = llm if llm is not None else config.load_llm(world)
    model = config.model_for(llm_cfg, "critic", world)  # raises on misconfig; enforces locality

    pack = transcript.evidence_pack(Path(entry.transcript_path), Path(entry.cwd), git_head_at_start=entry.git_head)
    existing_patterns = store.pattern_counts(world.name)
    recent_titles = [r.id for r in store.list_reflections(world.name)[:25]]
    artifacts = installed_artifacts(world, cfg)

    messages = build_messages(
        pack,
        world=world,
        existing_patterns=existing_patterns,
        installed_artifacts=artifacts,
        recent_titles=recent_titles,
    )
    raw = chat_fn("critic", messages, world=world, cfg_llm=llm_cfg, json_mode=True)
    answer = parse_answer(raw)

    if not answer["record"] or not answer["pattern"]:
        return {
            "recorded": False,
            "reflection_id": None,
            "pattern": None,
            "path": None,
            "reason": answer.get("reason") or "not-recorded: no reusable lesson found",
        }

    pattern = answer["pattern"]
    body = _render_body(pattern, answer)
    head_now = pack.get("git", {}).get("head_now")
    revision = f"{entry.git_head}..{head_now}" if entry.git_head and head_now else None
    meta = {
        "session_id": entry.session_id,
        "cwd": str(entry.cwd),
        "revision": revision,
        "model": model,
        "artifacts_used": answer["artifacts_used"],
        "artifacts_helpful": answer["artifacts_helpful"],
        "artifacts_misfired": [m["ref"] for m in answer["artifacts_misfired"]],
        "confidence": answer["confidence"],
    }
    path = store.write_reflection(world.name, meta, body)
    reflection_id = path.stem

    ts = now_iso()
    _append_feedback_events(world.name, reflection_id, answer, ts)

    if answer["lesson_short"] and answer["confidence"] >= 0.5:
        store.put_lesson(
            Lesson(
                id=reflection_id,
                world=world.name,
                pattern=pattern,
                text=answer["lesson_short"],
                reflection_id=reflection_id,
                repo=_git_toplevel(entry.cwd),
            )
        )

    return {"recorded": True, "reflection_id": reflection_id, "pattern": pattern, "path": str(path), "reason": None}


def _render_body(pattern: str, answer: dict) -> str:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    not_verified = answer["not_verified"]
    not_verified_text = (
        "\n".join(f"- {x}" for x in not_verified)
        if not_verified
        else "none, checked scope: transcript evidence pack and repo diff"
    )
    return (
        f"Last updated: {today}\n\n"
        f"Pattern: {pattern}\n\n"
        "## What worked\n"
        f"{answer['what_worked'] or 'n/a'}\n"
        "## What failed & why\n"
        f"{answer['what_failed'] or 'n/a'}\n"
        "## Reusable lesson\n"
        f"{answer['lesson'] or 'n/a'}\n"
        "## Verification\n"
        f"{answer['verification'] or 'n/a'}\n"
        "## Not verified\n"
        f"{not_verified_text}\n"
    )


def _append_feedback_events(world: str, reflection_id: str, answer: dict, ts: str) -> None:
    lines = []
    for ref in answer["artifacts_used"]:
        lines.append({"ref": ref, "verdict": "used", "reflection_id": reflection_id, "ts": ts, "world": world})
    for ref in answer["artifacts_helpful"]:
        lines.append({"ref": ref, "verdict": "helpful", "reflection_id": reflection_id, "ts": ts, "world": world})
    for m in answer["artifacts_misfired"]:
        lines.append(
            {
                "ref": m["ref"],
                "verdict": "misfired",
                "reflection_id": reflection_id,
                "ts": ts,
                "world": world,
                "reason": m.get("reason", ""),
            }
        )
    for ref in answer["rules_relevant"]:
        lines.append({"ref": ref, "verdict": "relevant", "reflection_id": reflection_id, "ts": ts, "world": world})
    if not lines:
        return
    path = paths.critic_feedback_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        for line in lines:
            fh.write(json.dumps(line) + "\n")


def _git_toplevel(cwd) -> Path | None:
    try:
        r = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=str(cwd), capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    out = r.stdout.strip()
    return Path(out) if out else None
