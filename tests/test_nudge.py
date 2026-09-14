"""Tests for sil/nudge.py: gate evaluation, lint, load, and dispatch."""

from __future__ import annotations

import json
import time

import pytest

from sil import nudge

BASH_COMMIT = {
    "session_id": "s1", "hook_event_name": "PreToolUse", "tool_name": "Bash",
    "tool_input": {"command": "git commit -m x"},
}


def make_nudge(pattern="p", event="PreToolUse", matcher="Bash",
               gate=None, once_per="session", text="hint"):
    obj = {
        "pattern": pattern, "event": event,
        "gate": gate if gate is not None else {"command_matches": "git commit"},
        "once_per": once_per, "text": text,
    }
    if matcher is not None:
        obj["matcher"] = matcher
    return obj


# --- evaluate ----------------------------------------------------------

def test_evaluate_always_true():
    assert nudge.evaluate({"always": True}, {}) is True


def test_evaluate_tool_is():
    assert nudge.evaluate({"tool_is": ["Bash"]}, {"tool_name": "Bash"})
    assert not nudge.evaluate({"tool_is": ["Edit"]}, {"tool_name": "Bash"})


def test_evaluate_command_matches():
    payload = {"tool_input": {"command": "git commit -m x"}}
    assert nudge.evaluate({"command_matches": "git commit"}, payload)
    assert not nudge.evaluate({"command_matches": "git push"}, payload)


def test_evaluate_file_path_matches():
    payload = {"tool_input": {"file_path": "/repo/kb/router.py"}}
    assert nudge.evaluate({"file_path_matches": "*.py"}, payload)
    assert not nudge.evaluate({"file_path_matches": "*.md"}, payload)


def test_evaluate_prompt_matches():
    assert nudge.evaluate({"prompt_matches": "push"}, {"prompt": "push this"})
    assert not nudge.evaluate({"prompt_matches": "push"}, {"prompt": "commit this"})


def test_evaluate_all_any_not():
    payload = {"tool_name": "Bash", "tool_input": {"command": "git commit"}}
    gate = {"all": [{"tool_is": ["Bash"]}, {"command_matches": "commit"}]}
    assert nudge.evaluate(gate, payload)
    assert nudge.evaluate({"any": [{"tool_is": ["Edit"]}, {"tool_is": ["Bash"]}]}, payload)
    assert nudge.evaluate({"not": {"tool_is": ["Edit"]}}, payload)
    assert not nudge.evaluate({"not": {"tool_is": ["Bash"]}}, payload)


def test_evaluate_never_raises_on_bad_gate():
    assert nudge.evaluate({}, {}) is False
    assert nudge.evaluate({"a": 1, "b": 2}, {}) is False
    assert nudge.evaluate({"bogus_predicate": 1}, {}) is False
    assert nudge.evaluate({"tool_is": "not-a-list"}, {"tool_name": "x"}) is False
    assert nudge.evaluate({"command_matches": 5}, {"tool_input": {"command": "x"}}) is False
    assert nudge.evaluate({"command_matches": "("}, {"tool_input": {"command": "x"}}) is False
    assert nudge.evaluate(None, {}) is False
    assert nudge.evaluate("not-a-dict", {}) is False
    assert nudge.evaluate({"all": "not-a-list"}, {}) is False


def test_search_bounds_text_length():
    """A pathological pattern or a huge string must never grow evaluate()'s
    cost unboundedly: the matched text is capped at MAX_MATCH_LEN."""
    text = "a" * nudge.MAX_MATCH_LEN + "END"
    assert not nudge.evaluate({"command_matches": "END$"}, {"tool_input": {"command": text}})
    short = "a" * 10 + "END"
    assert nudge.evaluate({"command_matches": "END$"}, {"tool_input": {"command": short}})


def test_split_trigger_variants():
    assert nudge.split_trigger("PreToolUse:Bash") == ("PreToolUse", "Bash")
    assert nudge.split_trigger("PreToolUse") == ("PreToolUse", None)
    assert nudge.split_trigger("PreToolUse:Skill") == ("PreToolUse", "Skill")
    assert nudge.split_trigger("Stop:Bash") is None
    assert nudge.split_trigger("Bogus") is None
    assert nudge.split_trigger("PreToolUse:Bogus") is None
    assert nudge.split_trigger("SessionStart") == ("SessionStart", None)


# --- validate_gate / gate_truth -----------------------------------------

def test_validate_gate_reports_unknown_predicate():
    problems = nudge.validate_gate({"nope": 1})
    assert problems and "unknown predicate" in problems[0]


def test_validate_gate_reports_bad_regex():
    problems = nudge.validate_gate({"command_matches": "("})
    assert any("bad regex" in p for p in problems)


def test_validate_gate_recurses_into_all_children():
    problems = nudge.validate_gate({"all": [{"command_matches": "("}, {"nope": 1}]})
    assert len(problems) == 2


def test_gate_truth_always_is_true():
    assert nudge.gate_truth({"always": True}) is True


def test_gate_truth_payload_dependent_is_none():
    assert nudge.gate_truth({"tool_is": ["Bash"]}) is None
    assert nudge.gate_truth({"command_matches": "git commit"}) is None
    assert nudge.gate_truth({"file_path_matches": "*"}) is None


def test_gate_truth_empty_tool_is_is_false():
    assert nudge.gate_truth({"tool_is": []}) is False


def test_gate_truth_all_any_composition():
    assert nudge.gate_truth({"all": [{"always": True}, {"always": True}]}) is True
    assert nudge.gate_truth({"all": [{"always": True}, {"tool_is": []}]}) is False
    assert nudge.gate_truth({"any": [{"tool_is": []}, {"tool_is": ["Bash"]}]}) is None
    assert nudge.gate_truth({"any": [{"tool_is": []}, {"always": True}]}) is True
    assert nudge.gate_truth({"not": {"always": True}}) is False


# --- lint_nudge ----------------------------------------------------------

def test_lint_nudge_clean_document_has_no_problems():
    assert nudge.lint_nudge(make_nudge()) == []


def test_lint_rejects_missing_fields():
    problems = nudge.lint_nudge({"pattern": "p"})
    assert any("event" in p for p in problems)


def test_lint_rejects_non_slug_pattern():
    problems = nudge.lint_nudge(make_nudge(pattern="Not A Slug"))
    assert any("slug" in p for p in problems)


def test_lint_rejects_text_over_400_chars():
    problems = nudge.lint_nudge(make_nudge(text="x" * 401))
    assert any("400" in p for p in problems)
    assert nudge.lint_nudge(make_nudge(text="x" * 400)) == []


def test_lint_rejects_unsupported_event_matcher():
    problems = nudge.lint_nudge(make_nudge(event="Stop", matcher="Bash"))
    assert any("unsupported event/matcher" in p for p in problems)


def test_lint_rejects_bad_once_per():
    problems = nudge.lint_nudge(make_nudge(once_per="forever"))
    assert any("once_per" in p for p in problems)


def test_lint_rejects_unbounded_broadcast_on_high_frequency_event():
    obj = make_nudge(event="Stop", matcher=None, gate={"always": True}, once_per="always")
    problems = nudge.lint_nudge(obj)
    assert any("degenerate gate" in p for p in problems)


def test_lint_allows_always_gate_bounded_by_once_per_session():
    obj = make_nudge(event="Stop", matcher=None, gate={"always": True}, once_per="session")
    assert nudge.lint_nudge(obj) == []


def test_lint_allows_always_gate_on_low_frequency_event():
    obj = make_nudge(event="SessionStart", matcher=None, gate={"always": True}, once_per="always")
    assert nudge.lint_nudge(obj) == []


def test_unbounded_broadcast_rule_mentions_once_per_and_low_frequency_events():
    text = nudge.unbounded_broadcast_rule()
    assert "once_per" in text
    for event in nudge.LOW_FREQUENCY_EVENTS:
        assert event in text


# --- load_nudges ----------------------------------------------------------

def test_load_nudges_sorted_and_skips_invalid_json(tmp_path):
    d = tmp_path / "nudges"
    d.mkdir()
    (d / "b.json").write_text(json.dumps(make_nudge(pattern="b")))
    (d / "a.json").write_text(json.dumps(make_nudge(pattern="a")))
    (d / "broken.json").write_text("{not json")
    (d / "not-an-object.json").write_text("[1, 2]")
    loaded = nudge.load_nudges([d])
    assert [n["pattern"] for n in loaded] == ["a", "b"]


def test_load_nudges_multiple_dirs_in_order(tmp_path):
    d1 = tmp_path / "world"
    d2 = tmp_path / "builtin"
    d1.mkdir()
    d2.mkdir()
    (d1 / "z.json").write_text(json.dumps(make_nudge(pattern="world-nudge")))
    (d2 / "a.json").write_text(json.dumps(make_nudge(pattern="builtin-nudge")))
    loaded = nudge.load_nudges([d1, d2])
    assert [n["pattern"] for n in loaded] == ["world-nudge", "builtin-nudge"]


def test_load_nudges_missing_dir_is_skipped(tmp_path):
    assert nudge.load_nudges([tmp_path / "nope"]) == []


# --- dispatch ----------------------------------------------------------

def test_dispatch_returns_text_and_logs_fire(tmp_path):
    n = make_nudge(pattern="fires", gate={"command_matches": "commit"})
    session_dir = tmp_path / "session"
    fire_log = tmp_path / "state" / "nudge-fires.jsonl"
    text = nudge.dispatch(BASH_COMMIT, [n], session_dir=session_dir, fire_log=fire_log)
    assert text == "hint"
    lines = fire_log.read_text().splitlines()
    assert len(lines) == 1
    record = json.loads(lines[0])
    assert record["pattern"] == "fires"
    assert record["session_id"] == "s1"
    assert record["event"] == "PreToolUse"
    assert set(record) == {"ts", "pattern", "session_id", "event"}


def test_dispatch_no_match_returns_none(tmp_path):
    n = make_nudge(gate={"command_matches": "push"})
    text = nudge.dispatch(BASH_COMMIT, [n], session_dir=tmp_path / "s", fire_log=tmp_path / "f.jsonl")
    assert text is None


def test_dispatch_event_mismatch_and_matcher_mismatch_are_skipped(tmp_path):
    wrong_event = make_nudge(event="PostToolUse", gate={"always": True})
    wrong_matcher = make_nudge(matcher="Edit", gate={"always": True})
    text = nudge.dispatch(BASH_COMMIT, [wrong_event, wrong_matcher],
                           session_dir=tmp_path / "s", fire_log=tmp_path / "f.jsonl")
    assert text is None


def test_dispatch_return_type_is_text_or_none_never_a_dict(tmp_path):
    n = make_nudge(gate={"always": True})
    result = nudge.dispatch(BASH_COMMIT, [n], session_dir=tmp_path / "s", fire_log=tmp_path / "f.jsonl")
    assert result is None or isinstance(result, str)
    assert not isinstance(result, dict)


def test_dispatch_once_per_session_claims_marker_only_for_winner(tmp_path):
    session_dir = tmp_path / "session"
    fire_log = tmp_path / "fires.jsonl"
    a = make_nudge(pattern="nudge-a", gate={"always": True})
    b = make_nudge(pattern="nudge-b", gate={"always": True})

    first = nudge.dispatch(BASH_COMMIT, [a, b], session_dir=session_dir, fire_log=fire_log)
    assert first == "hint"

    markers_dir = session_dir / "nudge-markers"
    assert list(markers_dir.glob("nudge-nudge-a-*"))
    assert not list(markers_dir.glob("nudge-nudge-b-*"))  # loser's slot untouched

    second = nudge.dispatch(BASH_COMMIT, [a, b], session_dir=session_dir, fire_log=fire_log)
    assert second == "hint"  # b now wins, a's slot is spent

    lines = [json.loads(l) for l in fire_log.read_text().splitlines()]
    assert [l["pattern"] for l in lines] == ["nudge-a", "nudge-b"]

    third = nudge.dispatch(BASH_COMMIT, [a, b], session_dir=session_dir, fire_log=fire_log)
    assert third is None  # both slots spent now


def test_dispatch_once_per_always_fires_every_call(tmp_path):
    n = make_nudge(pattern="repeat", gate={"always": True}, once_per="always")
    session_dir = tmp_path / "session"
    fire_log = tmp_path / "fires.jsonl"
    assert nudge.dispatch(BASH_COMMIT, [n], session_dir=session_dir, fire_log=fire_log) == "hint"
    assert nudge.dispatch(BASH_COMMIT, [n], session_dir=session_dir, fire_log=fire_log) == "hint"
    lines = fire_log.read_text().splitlines()
    assert len(lines) == 2


def test_dispatch_never_raises_on_malformed_nudges(tmp_path):
    bad = [{"event": "PreToolUse"}, "not-a-dict", None, {"pattern": "p", "event": "PreToolUse",
            "matcher": "Bash", "gate": {"bogus": 1}, "once_per": "session", "text": "x"}]
    result = nudge.dispatch(BASH_COMMIT, bad, session_dir=tmp_path / "s", fire_log=tmp_path / "f.jsonl")
    assert result is None


def test_dispatch_gate_timeout_skips_catastrophic_regex_within_budget(tmp_path):
    evil = make_nudge(pattern="evil", gate={"command_matches": r"(a+)+$"})
    payload = {
        "session_id": "s-evil", "hook_event_name": "PreToolUse", "tool_name": "Bash",
        "tool_input": {"command": "a" * 32 + "!"},
    }
    started = time.monotonic()
    result = nudge.dispatch(payload, [evil], session_dir=tmp_path / "s", fire_log=tmp_path / "f.jsonl",
                             budget_s=0.2, gate_timeout_s=0.1)
    elapsed = time.monotonic() - started
    assert result is None
    assert elapsed < 2.0, f"gate deadline did not bound evaluation: took {elapsed:.2f}s"


def test_dispatch_writes_gate_budget_exhausted_breadcrumb(tmp_path):
    evil = make_nudge(pattern="evil", gate={"command_matches": r"(a+)+$"})
    harmless = make_nudge(pattern="harmless", gate={"always": True})
    payload = {
        "session_id": "s-budget", "hook_event_name": "PreToolUse", "tool_name": "Bash",
        "tool_input": {"command": "a" * 30 + "!"},
    }
    fire_log = tmp_path / "fires.jsonl"
    result = nudge.dispatch(payload, [evil, harmless], session_dir=tmp_path / "session", fire_log=fire_log,
                             budget_s=0.05, gate_timeout_s=0.05)
    assert result is None  # budget spent on `evil`; `harmless` never reached
    records = [json.loads(l) for l in fire_log.read_text().splitlines()]
    kinds = [r.get("kind") for r in records]
    assert "gate_budget_exhausted" in kinds


def test_write_breadcrumb_capped_once_per_session_event(tmp_path):
    fire_log = tmp_path / "fires.jsonl"
    session_dir = tmp_path / "session"
    nudge.write_breadcrumb(fire_log, session_dir, "gate_budget_exhausted", "s1", "PreToolUse", scanned=3)
    nudge.write_breadcrumb(fire_log, session_dir, "gate_budget_exhausted", "s1", "PreToolUse", scanned=9)
    lines = fire_log.read_text().splitlines()
    assert len(lines) == 1
    record = json.loads(lines[0])
    assert record["kind"] == "gate_budget_exhausted"
    assert record["scanned"] == 3


def test_fire_log_rotates_at_10mb_keeping_last_5000_lines(tmp_path):
    fire_log = tmp_path / "fires.jsonl"
    line = "x" * 48 + "\n"
    lines_needed = (nudge.ROTATE_AT_BYTES // len(line)) + 100
    fire_log.write_text(line * lines_needed, encoding="utf-8")
    assert fire_log.stat().st_size > nudge.ROTATE_AT_BYTES

    nudge._append_log_line(fire_log, "tail-marker\n")

    content_lines = fire_log.read_text(encoding="utf-8").splitlines()
    assert len(content_lines) == nudge.ROTATE_KEEP_LINES + 1
    assert content_lines[-1] == "tail-marker"
    assert fire_log.stat().st_size < nudge.ROTATE_AT_BYTES
