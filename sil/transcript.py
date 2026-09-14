"""Read a Claude Code session transcript (JSONL) and build a compact evidence
pack for the critic. Pure apart from the git subprocess calls in `evidence_pack`.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Iterator

NOISE_TYPES = {"ai-title", "last-prompt", "queue-operation", "atis-latch"}

_TEST_LIKE_RE = re.compile(
    r"pytest|jest|vitest|go test|cargo test|npm test|pnpm test|make test|ruff|eslint|tsc|mypy"
)

# Fields tried in order for a tool_use input's human-readable summary.
_SUMMARY_KEYS = ("command", "file_path", "skill", "subagent_type", "pattern", "path")


def iter_records(path: Path, max_bytes: int = 50_000_000) -> Iterator[dict]:
    """Yield each JSON object line of a transcript, skipping bad lines.

    Stops reading once `max_bytes` of the file have been consumed, so a
    runaway transcript cannot blow up memory or wall time.
    """
    path = Path(path)
    if not path.exists():
        return
    read_bytes = 0
    with path.open("r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            read_bytes += len(line.encode("utf-8", errors="replace"))
            if read_bytes > max_bytes:
                break
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue
            if isinstance(rec, dict):
                yield rec


def count_tool_uses(path: Path) -> int:
    count = 0
    for rec in iter_records(path):
        if rec.get("type") != "assistant":
            continue
        for block in _content_blocks(rec):
            if isinstance(block, dict) and block.get("type") == "tool_use":
                count += 1
    return count


def evidence_pack(
    transcript_path: Path,
    cwd: Path,
    *,
    git_head_at_start: str | None = None,
    max_chars: int = 24_000,
) -> dict:
    transcript_path = Path(transcript_path)
    cwd = Path(cwd)

    session_id: str | None = None
    prompts: list[str] = []
    final_assistant_texts: list[str] = []
    tool_use_entries: list[dict] = []
    tool_result_by_id: dict[str, dict] = {}
    skills_used: list[str] = []
    agents_used: list[dict] = []
    hooks: dict[str, dict] = {}
    errors: list[str] = []
    counts = {"tool_uses": 0, "turns": 0, "user_prompts": 0, "attachments": 0}

    for rec in iter_records(transcript_path):
        rtype = rec.get("type")
        if rtype in NOISE_TYPES:
            continue
        if session_id is None and rec.get("sessionId"):
            session_id = rec["sessionId"]

        if rtype == "attachment":
            counts["attachments"] += 1
            _record_hook(rec, hooks)
            continue

        if rtype == "user":
            _record_user(rec, prompts, counts, tool_result_by_id, errors)
            continue

        if rtype == "assistant":
            counts["turns"] += 1
            text = _record_text(rec)
            if text and text.strip():
                final_assistant_texts.append(text.strip()[:800])
            for block in _content_blocks(rec):
                if not isinstance(block, dict) or block.get("type") != "tool_use":
                    continue
                counts["tool_uses"] += 1
                name = block.get("name", "")
                inp = block.get("input") or {}
                summary = _tool_summary(inp)
                tool_use_entries.append({"id": block.get("id"), "name": name, "summary": summary[:160]})
                if name == "Skill" and inp.get("skill"):
                    skills_used.append(str(inp["skill"]))
                elif name == "Agent":
                    agents_used.append({"subagent_type": inp.get("subagent_type"), "model": inp.get("model")})
            continue
        # any other type is ignored, not noise but not evidence either

    tool_calls_full: list[dict] = []
    bash_full: list[dict] = []
    for t in tool_use_entries:
        res = tool_result_by_id.get(t["id"], {})
        is_error = bool(res.get("is_error", False))
        tool_calls_full.append({"name": t["name"], "summary": t["summary"], "is_error": is_error})
        if t["name"] == "Bash":
            tail = str(res.get("content", ""))[-300:]
            bash_full.append({"command": t["summary"], "is_error": is_error, "tail": tail})

    if len(tool_calls_full) > 80:
        tool_calls = tool_calls_full[:20] + tool_calls_full[-60:]
    else:
        tool_calls = tool_calls_full

    # Most recent bash calls are the ones closest to the session's final state.
    bash = bash_full[-30:]
    test_like = [b for b in bash if _TEST_LIKE_RE.search(b["command"] or "")]

    pack = {
        "session_id": session_id,
        "cwd": str(cwd),
        "prompts": prompts[:12],
        "final_assistant_texts": final_assistant_texts[-3:],
        "tool_calls": tool_calls,
        "bash": bash,
        "test_like": test_like,
        "skills_used": skills_used,
        "agents_used": agents_used,
        "hooks": hooks,
        "errors": errors[:15],
        "counts": counts,
        "git": _git_info(cwd, git_head_at_start),
    }
    return _enforce_budget(pack, max_chars)


def _record_hook(rec: dict, hooks: dict[str, dict]) -> None:
    att = rec.get("attachment") or {}
    if not isinstance(att, dict) or not att.get("hookName"):
        return
    name = str(att["hookName"])
    h = hooks.setdefault(name, {"runs": 0, "errors": 0, "max_ms": 0})
    h["runs"] += 1
    if str(att.get("exitCode", "0")) != "0":
        h["errors"] += 1
    try:
        ms = int(att.get("durationMs") or 0)
    except (TypeError, ValueError):
        ms = 0
    h["max_ms"] = max(h["max_ms"], ms)


def _record_user(rec: dict, prompts: list[str], counts: dict, tool_result_by_id: dict, errors: list[str]) -> None:
    message = rec.get("message") or {}
    content = message.get("content")
    blocks = content if isinstance(content, list) else []
    has_text = isinstance(content, str) or any(
        isinstance(b, dict) and b.get("type") == "text" for b in blocks
    )
    for b in blocks:
        if not isinstance(b, dict) or b.get("type") != "tool_result":
            continue
        tool_use_id = b.get("tool_use_id")
        is_error = bool(b.get("is_error"))
        content_text = _stringify_tool_result_content(b.get("content"))
        if tool_use_id:
            tool_result_by_id[tool_use_id] = {"is_error": is_error, "content": content_text}
        if is_error:
            errors.append(content_text[:300])
    if has_text:
        text = _record_text(rec).strip()
        if text and not text.startswith("<"):
            counts["user_prompts"] += 1
            prompts.append(text[:400])


def _content_blocks(rec: dict) -> list:
    message = rec.get("message") or {}
    content = message.get("content")
    return content if isinstance(content, list) else []


def _record_text(rec: dict) -> str:
    message = rec.get("message") or {}
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
        return "\n".join(parts)
    return ""


def _stringify_tool_result_content(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                parts.append(b.get("text", ""))
            elif isinstance(b, str):
                parts.append(b)
        return "\n".join(parts)
    if content is None:
        return ""
    return str(content)


def _tool_summary(inp: dict) -> str:
    for key in _SUMMARY_KEYS:
        val = inp.get(key)
        if val:
            return str(val)
    return json.dumps(inp, default=str)[:160] if inp else ""


def _git(cwd: Path, *args: str, timeout: float = 5) -> str | None:
    try:
        r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout if r.returncode == 0 else None


def _git_info(cwd: Path, head_at_start: str | None) -> dict:
    info = {
        "head_at_start": head_at_start,
        "head_now": None,
        "diff_stat": "",
        "diff_excerpt": "",
        "files_changed": [],
    }
    if _git(cwd, "rev-parse", "--show-toplevel") is None:
        return info
    head_now = _git(cwd, "rev-parse", "HEAD")
    info["head_now"] = head_now.strip() if head_now else None

    diffs, stats, names = [], [], set()
    if head_at_start:
        diffs.append(_git(cwd, "diff", f"{head_at_start}..HEAD") or "")
        stats.append(_git(cwd, "diff", "--stat", f"{head_at_start}..HEAD") or "")
        for line in (_git(cwd, "diff", "--name-only", f"{head_at_start}..HEAD") or "").splitlines():
            if line.strip():
                names.add(line.strip())
    diffs.append(_git(cwd, "diff") or "")
    stats.append(_git(cwd, "diff", "--stat") or "")
    for line in (_git(cwd, "diff", "--name-only") or "").splitlines():
        if line.strip():
            names.add(line.strip())

    info["diff_excerpt"] = "\n".join(d for d in diffs if d)[:6000]
    info["diff_stat"] = "\n".join(s for s in stats if s).strip()
    info["files_changed"] = sorted(names)
    return info


def _enforce_budget(pack: dict, max_chars: int) -> dict:
    def size() -> int:
        return len(json.dumps(pack, default=str))

    if size() <= max_chars:
        return pack

    git = pack.get("git") or {}
    excerpt = git.get("diff_excerpt", "")
    while excerpt and size() > max_chars:
        excerpt = excerpt[: len(excerpt) // 2]
        git["diff_excerpt"] = excerpt

    while len(pack["tool_calls"]) > 20 and size() > max_chars:
        del pack["tool_calls"][20]

    while size() > max_chars and pack["bash"]:
        longest = max(pack["bash"], key=lambda b: len(b.get("tail", "")))
        if len(longest.get("tail", "")) <= 20:
            break
        longest["tail"] = longest["tail"][: len(longest["tail"]) // 2]

    return pack
