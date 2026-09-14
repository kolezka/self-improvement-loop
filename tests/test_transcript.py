"""Tests for sil.transcript. Also hosts the synthetic transcript fixture
helpers imported by test_critic.py and test_worker.py."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from sil import transcript

SESSION_ID = "sess-fixture-1"


def write_transcript(path: Path, records: list[dict]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for rec in records:
            fh.write(json.dumps(rec) + "\n")
    return path


def _user(uid: str, content, session_id: str = SESSION_ID) -> dict:
    return {
        "type": "user",
        "uuid": uid,
        "isSidechain": False,
        "sessionId": session_id,
        "timestamp": "2026-09-14T10:00:00.000Z",
        "message": {"role": "user", "content": content},
    }


def _assistant(uid: str, content, session_id: str = SESSION_ID) -> dict:
    return {
        "type": "assistant",
        "uuid": uid,
        "isSidechain": False,
        "sessionId": session_id,
        "timestamp": "2026-09-14T10:00:01.000Z",
        "message": {"role": "assistant", "content": content},
    }


def _hook_attachment(hook_name: str, exit_code: str, duration_ms: str, tool_use_id: str) -> dict:
    return {
        "type": "attachment",
        "attachment": {
            "type": "hook_success",
            "hookName": hook_name,
            "toolUseID": tool_use_id,
            "hookEvent": hook_name.split(":")[0],
            "content": "",
            "stdout": "",
            "stderr": "",
            "exitCode": exit_code,
            "command": "true",
            "durationMs": duration_ms,
        },
    }


def sample_records(session_id: str = SESSION_ID) -> list[dict]:
    """One user prompt, a Bash tool_use whose result is_error, a Skill
    tool_use, an Agent tool_use, 2 attachment hook records, an ai-title
    noise line, a system-ish user record, and a final assistant text."""
    return [
        _user("u0", "Fix the bug in foo.py, tests are failing.", session_id),
        _assistant(
            "a0",
            [
                {"type": "text", "text": "Let me run the tests first."},
                {"type": "tool_use", "id": "tool-bash-1", "name": "Bash", "input": {"command": "pytest -q", "description": "run tests"}},
            ],
            session_id,
        ),
        _user(
            "u1",
            [
                {
                    "type": "tool_result",
                    "tool_use_id": "tool-bash-1",
                    "is_error": True,
                    "content": [{"type": "text", "text": "FAILED tests/test_foo.py::test_bar - AssertionError"}],
                }
            ],
            session_id,
        ),
        {"type": "ai-title", "title": "Fix foo.py bug"},
        _assistant(
            "a1",
            [{"type": "tool_use", "id": "tool-skill-1", "name": "Skill", "input": {"skill": "debugging", "args": "foo.py"}}],
            session_id,
        ),
        _user(
            "u2",
            [{"type": "tool_result", "tool_use_id": "tool-skill-1", "is_error": False, "content": "ok"}],
            session_id,
        ),
        _assistant(
            "a2",
            [
                {
                    "type": "tool_use",
                    "id": "tool-agent-1",
                    "name": "Agent",
                    "input": {"subagent_type": "explorer", "model": "sonnet", "description": "explore", "prompt": "find callers"},
                }
            ],
            session_id,
        ),
        _user(
            "u3",
            [{"type": "tool_result", "tool_use_id": "tool-agent-1", "is_error": False, "content": "found 2 callers"}],
            session_id,
        ),
        _hook_attachment("PreToolUse:Bash", "0", "56", "tool-bash-1"),
        _hook_attachment("PostToolUse:Bash", "1", "120", "tool-bash-1"),
        _user("u4", "<system-reminder>ignore this</system-reminder>", session_id),
        _assistant("a3", [{"type": "text", "text": "Fixed the assertion and reran the suite; tests pass now."}], session_id),
    ]


def write_sample_transcript(tmp_path: Path, session_id: str = SESSION_ID) -> Path:
    return write_transcript(tmp_path / "transcript.jsonl", sample_records(session_id))


def set_sil_dirs(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("SIL_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("SIL_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("SIL_DATA_DIR", str(tmp_path / "data"))


# --- count_tool_uses ----------------------------------------------------------

def test_count_tool_uses_counts_all_tool_use_blocks(tmp_path):
    p = write_sample_transcript(tmp_path)
    assert transcript.count_tool_uses(p) == 3  # Bash, Skill, Agent


def test_count_tool_uses_missing_file_is_zero(tmp_path):
    assert transcript.count_tool_uses(tmp_path / "nope.jsonl") == 0


def test_iter_records_tolerates_bad_lines(tmp_path):
    p = tmp_path / "t.jsonl"
    p.write_text('{"type": "user"}\nnot json\n{"type": "assistant"}\n\n', encoding="utf-8")
    recs = list(transcript.iter_records(p))
    assert [r["type"] for r in recs] == ["user", "assistant"]


# --- evidence_pack shapes -------------------------------------------------------

def test_evidence_pack_basic_shape(tmp_path):
    p = write_sample_transcript(tmp_path)
    cwd = tmp_path
    pack = transcript.evidence_pack(p, cwd, git_head_at_start=None)

    assert pack["session_id"] == SESSION_ID
    assert pack["cwd"] == str(cwd)
    assert pack["counts"]["tool_uses"] == 3
    assert pack["counts"]["turns"] == 4  # 4 assistant records
    assert pack["counts"]["attachments"] == 2
    assert pack["skills_used"] == ["debugging"]
    assert pack["agents_used"] == [{"subagent_type": "explorer", "model": "sonnet"}]


def test_evidence_pack_skips_tool_result_only_and_system_ish_prompts(tmp_path):
    p = write_sample_transcript(tmp_path)
    pack = transcript.evidence_pack(p, tmp_path)
    # 3 tool_result-only user records + 1 system-reminder record are excluded;
    # only the real opening prompt remains.
    assert pack["prompts"] == ["Fix the bug in foo.py, tests are failing."]
    assert pack["counts"]["user_prompts"] == 1


def test_evidence_pack_final_assistant_texts_last_three(tmp_path):
    p = write_sample_transcript(tmp_path)
    pack = transcript.evidence_pack(p, tmp_path)
    assert pack["final_assistant_texts"] == [
        "Let me run the tests first.",
        "Fixed the assertion and reran the suite; tests pass now.",
    ]


def test_evidence_pack_bash_and_test_like(tmp_path):
    p = write_sample_transcript(tmp_path)
    pack = transcript.evidence_pack(p, tmp_path)
    assert len(pack["bash"]) == 1
    bash_entry = pack["bash"][0]
    assert bash_entry["command"] == "pytest -q"
    assert bash_entry["is_error"] is True
    assert "AssertionError" in bash_entry["tail"]
    assert pack["test_like"] == pack["bash"]  # "pytest -q" matches the test-like regex


def test_evidence_pack_errors_captured(tmp_path):
    p = write_sample_transcript(tmp_path)
    pack = transcript.evidence_pack(p, tmp_path)
    assert len(pack["errors"]) == 1
    assert "AssertionError" in pack["errors"][0]


def test_evidence_pack_hooks_aggregated(tmp_path):
    p = write_sample_transcript(tmp_path)
    pack = transcript.evidence_pack(p, tmp_path)
    assert pack["hooks"] == {
        "PreToolUse:Bash": {"runs": 1, "errors": 0, "max_ms": 56},
        "PostToolUse:Bash": {"runs": 1, "errors": 1, "max_ms": 120},
    }


def test_evidence_pack_no_git_repo_has_empty_git_info(tmp_path):
    p = write_sample_transcript(tmp_path)
    pack = transcript.evidence_pack(p, tmp_path, git_head_at_start="deadbeef")
    assert pack["git"]["head_now"] is None
    assert pack["git"]["diff_excerpt"] == ""
    assert pack["git"]["files_changed"] == []


def test_evidence_pack_git_repo_reports_diff(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "T"], cwd=repo, check=True)
    (repo / "a.txt").write_text("one\n", encoding="utf-8")
    subprocess.run(["git", "add", "a.txt"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=repo, check=True)
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True).stdout.strip()
    (repo / "a.txt").write_text("one\ntwo\n", encoding="utf-8")

    p = write_sample_transcript(tmp_path)
    pack = transcript.evidence_pack(p, repo, git_head_at_start=head)
    assert pack["git"]["head_at_start"] == head
    assert pack["git"]["head_now"] == head
    assert "a.txt" in pack["git"]["files_changed"]
    assert "two" in pack["git"]["diff_excerpt"]


# --- truncation and caps -------------------------------------------------------

def test_evidence_pack_prompt_truncated_to_400_chars(tmp_path):
    long_prompt = "x" * 500
    records = [_user("u0", long_prompt)]
    p = write_transcript(tmp_path / "t.jsonl", records)
    pack = transcript.evidence_pack(p, tmp_path)
    assert len(pack["prompts"][0]) == 400


def test_evidence_pack_prompts_capped_at_12(tmp_path):
    records = []
    for i in range(20):
        records.append(_user(f"u{i}", f"prompt {i}"))
        records.append(_assistant(f"a{i}", [{"type": "text", "text": f"reply {i}"}]))
    p = write_transcript(tmp_path / "t.jsonl", records)
    pack = transcript.evidence_pack(p, tmp_path)
    assert len(pack["prompts"]) == 12


def test_evidence_pack_tool_calls_capped_first_20_last_60(tmp_path):
    blocks = [{"type": "tool_use", "id": f"t{i}", "name": "Read", "input": {"file_path": f"f{i}.py"}} for i in range(90)]
    records = [_assistant("a0", blocks)]
    p = write_transcript(tmp_path / "t.jsonl", records)
    pack = transcript.evidence_pack(p, tmp_path)
    assert len(pack["tool_calls"]) == 80
    assert pack["tool_calls"][0]["summary"] == "f0.py"
    assert pack["tool_calls"][19]["summary"] == "f19.py"
    assert pack["tool_calls"][20]["summary"] == "f30.py"  # first of the kept "last 60"
    assert pack["tool_calls"][-1]["summary"] == "f89.py"


def test_evidence_pack_bash_capped_at_30(tmp_path):
    records = []
    for i in range(40):
        records.append(
            _assistant(f"a{i}", [{"type": "tool_use", "id": f"b{i}", "name": "Bash", "input": {"command": f"echo {i}"}}])
        )
    p = write_transcript(tmp_path / "t.jsonl", records)
    pack = transcript.evidence_pack(p, tmp_path)
    assert len(pack["bash"]) == 30
    assert pack["bash"][0]["command"] == "echo 10"
    assert pack["bash"][-1]["command"] == "echo 39"


def test_evidence_pack_respects_max_chars_budget(tmp_path):
    records = []
    for i in range(40):
        records.append(
            _assistant(
                f"a{i}",
                [{"type": "tool_use", "id": f"b{i}", "name": "Bash", "input": {"command": f"echo {i}" * 20}}],
            )
        )
        records.append(_user(f"u{i}", [{"type": "tool_result", "tool_use_id": f"b{i}", "is_error": False, "content": "x" * 500}]))
    p = write_transcript(tmp_path / "t.jsonl", records)
    pack = transcript.evidence_pack(p, tmp_path, max_chars=2000)
    assert len(json.dumps(pack, default=str)) < 20_000  # trimmed well below the untrimmed size
