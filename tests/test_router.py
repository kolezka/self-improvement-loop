"""The artifact-type decision: total, evidence-bound, and gate-executing."""

from __future__ import annotations

import json
import signal
import threading
from pathlib import Path

import pytest

from sil import router
from sil.router import RouteAnswer, RouteResult
from tests.curriculum_fixtures import install_fake_nudge

FIXTURES = Path(__file__).parent / "fixtures" / "hook-payloads"
PAYLOADS = [json.loads(p.read_text()) for p in sorted(FIXTURES.glob("*.json"))]

SOURCES = (
    "I went looking for a way to query the dependency graph and could not find one.\n"
    "Then I claimed the fix was safe without running anything.\n"
)
CONTEXT_QUOTE = "went looking for a way to query the dependency graph and could not find one"
CAPABILITY_QUOTE = "claimed the fix was safe without running anything"
WORKABLE_GATE = {"command_matches": "git (commit|push)"}


@pytest.fixture(autouse=True)
def _nudge(monkeypatch):
    install_fake_nudge(monkeypatch)


def test_the_recorded_corpus_is_present():
    # The gate rule below is only meaningful against real payloads.
    assert len(PAYLOADS) >= 20


# --- hook: the claim is executed, not read -----------------------------------

def test_a_workable_gate_routes_to_hook():
    result = router.route(
        RouteAnswer(trigger_event="PreToolUse:Bash", gate=WORKABLE_GATE),
        SOURCES, PAYLOADS)
    assert result.artifact_type == "hook", result.reason


def test_a_gate_that_matches_nothing_in_the_corpus_is_not_a_hook():
    result = router.route(
        RouteAnswer(trigger_event="PreToolUse:Bash",
                    gate={"command_matches": "zzz-never-appears"}),
        SOURCES, PAYLOADS)
    assert result.artifact_type != "hook"
    assert "matched nothing" in result.reason


def test_a_gate_that_fires_on_everything_is_a_broadcast_not_a_hook():
    # Once merged a hook runs unattended on every session of the machine. A gate
    # that cannot tell the corpus apart will not tell production apart either.
    result = router.route(
        RouteAnswer(trigger_event="PreToolUse:Bash", gate={"always": True}),
        SOURCES, PAYLOADS)
    assert result.artifact_type != "hook"
    assert "broadcast" in result.reason


def test_a_gate_that_raises_is_not_a_hook():
    result = router.route(
        RouteAnswer(trigger_event="PreToolUse:Bash", gate={"tool_is": "Bash"}),
        SOURCES, PAYLOADS)
    assert result.artifact_type != "hook"
    assert "gate" in result.reason


def test_an_unsupported_event_is_not_a_hook():
    result = router.route(
        RouteAnswer(trigger_event="PreToolFly:Bash", gate=WORKABLE_GATE),
        SOURCES, PAYLOADS)
    assert result.artifact_type != "hook"
    assert "unsupported" in result.reason


def test_an_empty_corpus_cannot_prove_a_hook():
    result = router.route(
        RouteAnswer(trigger_event="PreToolUse:Bash", gate=WORKABLE_GATE), SOURCES, [])
    assert result.artifact_type != "hook"


@pytest.mark.skipif(not hasattr(signal, "setitimer"),
                    reason="signal.setitimer is not available here")
def test_a_catastrophically_backtracking_gate_does_not_hang():
    # try/except cannot catch a hang; only the signal deadline can. Without the
    # deadline this test does not return.
    payload = {"session_id": "f", "hook_event_name": "PreToolUse",
               "tool_name": "Bash", "tool_input": {"command": "a" * 28 + "!"}}
    result = router.route(
        RouteAnswer(trigger_event="PreToolUse:Bash", gate={"command_matches": "(a+)+$"}),
        SOURCES, [payload])
    assert result.artifact_type != "hook"
    assert "timed out" in result.reason, (
        "the dispatcher is a total function, so an ordinary exception raised by "
        "the alarm is swallowed and reported as a clean non-match")


@pytest.mark.skipif(not hasattr(signal, "setitimer"),
                    reason="signal.setitimer is not available here")
def test_the_deadline_is_not_spent_on_the_first_payload_alone():
    # setitimer is one-shot. If the dispatcher swallows the first timeout, no
    # alarm is pending for payload two and the corpus walk runs unbounded.
    evil = "a" * 28 + "!"
    payloads = [{"session_id": str(i), "hook_event_name": "PreToolUse",
                 "tool_name": "Bash", "tool_input": {"command": evil}}
                for i in range(5)]
    result = router.route(
        RouteAnswer(trigger_event="PreToolUse:Bash", gate={"command_matches": "(a+)+$"}),
        SOURCES, payloads)
    assert result.artifact_type != "hook"
    assert "timed out" in result.reason


# --- evidence has to be verbatim ---------------------------------------------

def test_a_quoted_own_context_need_routes_to_agent():
    result = router.route(
        RouteAnswer(needs_own_context=True, context_evidence=CONTEXT_QUOTE),
        SOURCES, PAYLOADS)
    assert result.artifact_type == "agent", result.reason


def test_an_unevidenced_boolean_does_not_buy_an_agent():
    result = router.route(RouteAnswer(needs_own_context=True), SOURCES, PAYLOADS)
    assert result.artifact_type == "rule"
    assert "unevidenced" in result.reason


def test_a_fabricated_own_context_quote_does_not_buy_an_agent():
    result = router.route(
        RouteAnswer(needs_own_context=True,
                    context_evidence="this obviously needs its own budget"),
        SOURCES, PAYLOADS)
    assert result.artifact_type == "rule"
    assert "context_evidence is not verbatim" in result.reason


def test_quoted_capability_evidence_routes_to_skill():
    result = router.route(
        RouteAnswer(capability_evidence=CAPABILITY_QUOTE), SOURCES, PAYLOADS)
    assert result.artifact_type == "skill", result.reason


def test_unquotable_capability_evidence_downgrades_to_rule():
    result = router.route(
        RouteAnswer(capability_evidence="the agent wanted this badly"),
        SOURCES, PAYLOADS)
    assert result.artifact_type == "rule"
    assert "verbatim" in result.reason


def test_a_rewrapped_quote_still_counts():
    # The drafter re-wraps what it copied, so the compare is whitespace
    # insensitive and nothing else.
    rewrapped = CAPABILITY_QUOTE.replace(" safe ", "\n   safe\n")
    result = router.route(RouteAnswer(capability_evidence=rewrapped), SOURCES, PAYLOADS)
    assert result.artifact_type == "skill", result.reason


def test_a_discipline_with_no_evidence_falls_through_to_rule():
    assert router.route(RouteAnswer(), SOURCES, PAYLOADS).artifact_type == "rule"


# --- precedence: the order the checks run in is the contract ------------------

def test_a_parse_error_outranks_an_explicit_decline():
    result = router.route(
        RouteAnswer(parse_error="reply is not a JSON object", declined=True),
        SOURCES, PAYLOADS)
    assert result.artifact_type == "none"
    assert "unreadable" in result.reason, (
        f"a broken transport was reported as a considered verdict: {result.reason}")


def test_a_decline_outranks_an_otherwise_workable_gate():
    result = router.route(
        RouteAnswer(declined=True, trigger_event="PreToolUse:Bash", gate=WORKABLE_GATE),
        SOURCES, PAYLOADS)
    assert result.artifact_type == "none"
    assert "declined" in result.reason


def test_a_workable_gate_outranks_a_fully_evidenced_agent():
    result = router.route(
        RouteAnswer(trigger_event="PreToolUse:Bash", gate=WORKABLE_GATE,
                    needs_own_context=True, context_evidence=CONTEXT_QUOTE),
        SOURCES, PAYLOADS)
    assert result.artifact_type == "hook", result.reason


def test_a_quoted_own_context_need_outranks_quoted_capability_evidence():
    result = router.route(
        RouteAnswer(needs_own_context=True, context_evidence=CONTEXT_QUOTE,
                    capability_evidence=CAPABILITY_QUOTE),
        SOURCES, PAYLOADS)
    assert result.artifact_type == "agent", result.reason


def test_an_unevidenced_need_costs_the_skill_it_would_have_earned():
    # The sharp edge of the ordering: the needs_own_context branch returns, so a
    # perfectly good capability quote in the same answer is never read.
    result = router.route(
        RouteAnswer(needs_own_context=True, capability_evidence=CAPABILITY_QUOTE),
        SOURCES, PAYLOADS)
    assert result.artifact_type == "rule"
    assert "unevidenced" in result.reason


# --- totality ----------------------------------------------------------------

@pytest.mark.parametrize("answer,sources,payloads", [
    (RouteAnswer(trigger_event="PreToolUse:Bash", gate={"all": "not a list"}), "", []),
    (RouteAnswer(), None, PAYLOADS),
    (RouteAnswer(trigger_event="PreToolUse:Bash", gate=WORKABLE_GATE), SOURCES, 42),
    (RouteAnswer(trigger_event="", gate={}), SOURCES, PAYLOADS),
])
def test_route_never_raises(answer, sources, payloads):
    result = router.route(answer, sources, payloads)
    assert isinstance(result, RouteResult)
    assert result.artifact_type in {"skill", "hook", "rule", "agent", "none"}


def test_route_still_works_off_the_main_thread():
    # A web handler runs in a worker threadpool where signal.signal raises.
    # Degrading to an unbounded evaluation is correct; raising is not.
    out = {}
    thread = threading.Thread(target=lambda: out.update(
        r=router.route(RouteAnswer(trigger_event="PreToolUse:Bash", gate=WORKABLE_GATE),
                       SOURCES, PAYLOADS)))
    thread.start()
    thread.join()
    assert out["r"].artifact_type == "hook"


@pytest.mark.skipif(not hasattr(signal, "setitimer"),
                    reason="signal.setitimer is not available here")
def test_the_deadline_installs_no_handler_off_the_main_thread():
    seen = {}

    def probe():
        with router._deadline(0.25):
            seen["armed"] = signal.getitimer(signal.ITIMER_REAL)[0]

    thread = threading.Thread(target=probe)
    thread.start()
    thread.join()
    assert seen["armed"] == 0.0


def test_a_missing_dispatcher_refuses_the_hook_rather_than_crashing(monkeypatch):
    import sys
    monkeypatch.setitem(sys.modules, "sil.nudge", None)
    result = router.route(
        RouteAnswer(trigger_event="PreToolUse:Bash", gate=WORKABLE_GATE),
        SOURCES, PAYLOADS)
    assert result.artifact_type == "rule"


def test_split_trigger_rejects_a_matcher_on_an_event_that_takes_none():
    assert router.split_trigger("PreToolUse:Bash") == ("PreToolUse", "Bash")
    assert router.split_trigger("PreToolUse") == ("PreToolUse", None)
    assert router.split_trigger("Stop:Bash") is None
    assert router.split_trigger("PreToolUse:Telepathy") is None
    assert router.split_trigger("Nope") is None
