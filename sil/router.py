"""The artifact-type decision. Total: every input yields a RouteResult.

Why this module exists: the loop could only ever emit a SKILL.md, and a skill is
agent-invoked. Measured in V1 across 2997 transcripts, the five promoted skills
were invoked 0/1/0/0/0 times while being listed in 1301 sessions. The trigger
condition for a discipline is invisible from inside the context that would have
to act on it, so no description rewrite reaches it.

The order below is deliberate. `hook` is first because it is the only type that
does not depend on the agent recognising its own failure, and because its claim
is the only one that can be tested by running it. `skill` is last among the real
types and has to be paid for with a verbatim quote, inverting the old default in
which everything became a skill because skill was the fallback.

Gate timeout: a regex is not interruptible from Python and a gate is model
authored. An innocuous `(a+)+` backtracks exponentially and pegs a core forever;
try/except cannot catch a hang, only a signal deadline can. The deadline degrades
to a no-op off the main thread, because `route()` has to work in a web worker
thread too.
"""

from __future__ import annotations

import importlib
import signal
import threading
from contextlib import contextmanager

from pydantic import BaseModel

# A gate that cannot be evaluated inside the deadline does not route to hook.
GATE_TIMEOUT_S = 0.25


class GateTimeout(Exception):
    """Gate evaluation exceeded the wall-clock deadline."""


class RouteAnswer(BaseModel):
    """What the drafter returns instead of choosing a type in prose."""

    trigger_event: str = "none"
    gate: dict | None = None
    needs_own_context: bool = False
    # The quote that makes `needs_own_context` checkable, exactly as
    # capability_evidence does for `skill`. A bare bool was the one signal
    # nothing could falsify, and that is precisely where the measured routing
    # variance sat: same pattern, same prompt, rule on one run and agent on the
    # next.
    context_evidence: str | None = None
    capability_evidence: str | None = None
    # The drafter's own "no artifact is warranted here". A field, not a caller
    # keyword: a pattern recurring 149 times may mean the discipline is inherent,
    # and the drafter is the only party that can say so.
    declined: bool = False
    # Why the reply could not be read. Distinct from `declined`: a broken
    # transport and a considered refusal both used to print the same line, so an
    # unattended operator could not tell a dead provider from a working one with
    # nothing to say.
    parse_error: str = ""


class RouteResult(BaseModel):
    artifact_type: str
    reason: str


def _nudge():
    """The dispatcher module, resolved through sys.modules so a test can inject
    a fake before the hook half of the plugin exists."""
    return importlib.import_module("sil.nudge")


def split_trigger(trigger: str) -> tuple[str, str | None] | None:
    """`"PreToolUse:Bash"` -> `("PreToolUse", "Bash")`. None if unsupported.

    None covers every rejection (unknown event, a matcher on an event that takes
    none, a matcher the dispatcher does not handle) so the caller checks one
    thing rather than four.
    """
    try:
        events = _nudge().EVENTS
    except Exception:  # noqa: BLE001 - a missing dispatcher is a refusal, not a crash
        return None
    event, _, matcher = str(trigger or "").partition(":")
    if event not in events:
        return None
    allowed = events[event]
    if not matcher:
        # Every supported event is valid bare: "PreToolUse" means all matchers.
        return event, None
    if allowed is None or matcher not in allowed:
        return None
    return event, matcher


def _can_arm() -> bool:
    """Whether a signal deadline can be armed. False off the main thread or on a
    platform without setitimer, where a no-op is correct and raising is not."""
    return (hasattr(signal, "setitimer")
            and hasattr(signal, "SIGALRM")
            and threading.current_thread() is threading.main_thread())


@contextmanager
def _deadline(seconds: float):
    """Wall-clock deadline around gate evaluation, best effort.

    Degrading costs an unbounded regex hang in a web worker thread; raising costs
    the whole request. The model judge and human review are what narrow the input
    on that path, and this deadline is what makes the scheduled loop safe.

    ITIMER_REAL is one timer per process, so nesting would cancel an outer
    caller's alarm. Nothing nests today; do not build a timer stack for a hazard
    with no caller.
    """
    if not _can_arm():
        yield
        return

    def _fire(_signum, _frame):
        raise GateTimeout(f"gate evaluation exceeded {seconds}s")

    previous = signal.signal(signal.SIGALRM, _fire)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        # Cancel first, then restore. The other order leaves a live SIGALRM that
        # lands in the previous handler and kills an unrelated caller.
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def _normalise(text: str) -> str:
    """Whitespace-insensitive compare. The drafter re-wraps a quote it copied out
    of a reflection, so an exact `in` rejects genuine evidence over a newline.
    Case is kept: a quote is a quote."""
    return " ".join(text.split())


def route(answer: RouteAnswer, sources_text: str, payloads: list[dict]) -> RouteResult:
    """Which artifact this pattern should become, and why.

    Total. Callers gate on `artifact_type == "none"`, never on an exception: a
    router that raised would take a whole curriculum run down for one malformed
    drafter answer. Inputs are coerced rather than asserted, because a caller
    handing None from a failed file read must cost a routing decision, not a crash.
    """
    sources_text = sources_text if isinstance(sources_text, str) else ""
    payloads = list(payloads) if isinstance(payloads, (list, tuple)) else []

    # Before `declined`, and reported differently: an unreadable reply is a
    # provider problem someone has to fix, while a decline is the drafter working
    # correctly and saying no.
    if answer.parse_error:
        return RouteResult(artifact_type="none",
                           reason=f"unreadable drafter reply: {answer.parse_error}")

    # First among the model's own signals, so an explicit decline is not
    # overridden by a gate that happens to fire. Otherwise the churn relocates
    # from skills to hooks.
    if answer.declined:
        return RouteResult(artifact_type="none",
                           reason="drafter declined: no artifact warranted")

    hook_reason = _why_not_hook(answer, payloads)
    if hook_reason is None:
        return RouteResult(
            artifact_type="hook",
            reason=f"gate fires on the payload corpus at {answer.trigger_event}")

    # `agent` is earned, not asserted, at the same bar `skill` clears below.
    if answer.needs_own_context:
        note = (answer.context_evidence or "").strip()
        if not note:
            return RouteResult(
                artifact_type="rule",
                reason="needs_own_context asserted with no context_evidence; an "
                       "unevidenced boolean does not buy an agent")
        if _normalise(note) not in _normalise(sources_text):
            return RouteResult(
                artifact_type="rule",
                reason="context_evidence is not verbatim in any source reflection; "
                       "treated as a discipline")
        return RouteResult(artifact_type="agent",
                           reason="own-context need quoted verbatim from a source")

    quote = (answer.capability_evidence or "").strip()
    if quote:
        if _normalise(quote) in _normalise(sources_text):
            return RouteResult(artifact_type="skill",
                               reason="capability evidence quoted verbatim from a source")
        return RouteResult(
            artifact_type="rule",
            reason="capability_evidence is not verbatim in any source reflection; "
                   "treated as a discipline")

    return RouteResult(
        artifact_type="rule",
        reason=f"no workable gate ({hook_reason}), no own-context need, no "
               f"capability evidence")


def _why_not_hook(answer: RouteAnswer, payloads: list[dict]) -> str | None:
    """None when the answer is a workable hook, otherwise why it is not.

    The gate is executed against the recorded payload corpus rather than read.
    "This is mechanically detectable" is a claim the drafter makes, and the point
    of this module is that such claims get tested.
    """
    if answer.trigger_event == "none" or not answer.gate:
        return "no trigger event proposed"
    if split_trigger(answer.trigger_event) is None:
        return f"unsupported event/matcher {answer.trigger_event!r}"
    if not payloads:
        return "no recorded payloads to test the gate against"
    try:
        nudge = _nudge()
    except Exception as e:  # noqa: BLE001 - no dispatcher, so nothing can be proven
        return f"nudge dispatcher unavailable: {type(e).__name__}"
    gate_error = getattr(nudge, "NudgeError", ValueError)

    fired = False
    fires_on_everything = True
    try:
        with _deadline(GATE_TIMEOUT_S):
            for payload in payloads:
                try:
                    hit = bool(nudge.evaluate(answer.gate, payload))
                except GateTimeout:
                    raise
                except gate_error as e:
                    return f"gate rejected: {e}"
                except Exception as e:  # noqa: BLE001 - total; any gate bug is a refusal
                    return f"gate raised {type(e).__name__}"
                fired = fired or hit
                fires_on_everything = fires_on_everything and hit
    except GateTimeout:
        return f"gate evaluation timed out after {GATE_TIMEOUT_S}s"
    if not fired:
        return "gate matched nothing in the payload corpus"
    if fires_on_everything and len(payloads) > 1:
        # A gate that fires on every recorded payload is a broadcast, not a
        # nudge: it would inject on every matching tool call of every session.
        return "gate fires on every payload in the corpus; that is a broadcast"
    return None
