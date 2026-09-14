"""Drafter and judge prompts, and the parsers for their replies.

Both roles run through `sil.providers.chat(..., json_mode=True)`, so the reply is
one JSON object rather than V1's fenced blocks. The parsers live beside the
prompts on purpose: they are two halves of one contract, and V1 paid for letting
them drift into different modules.

The artifact shapes are described in prose, never templated. Two V1 shapes failed
by being copied: an angle-bracket placeholder was emitted verbatim as a
description, and a filled-in worked example was reproduced as the body along with
the instructions, passing both lint and the judge. Describing the shape risks only
a malformed delimiter, which lint catches reliably. Prefer the failure mode the
gates catch.
"""

from __future__ import annotations

import importlib
import json
import re

# Bound the evidence handed to a model, and never truncate it silently. The
# omission note stays in the prompt and says which end was dropped: a model that
# can see it was handed a window can hedge, one silently fed a fifth of the
# evidence writes with false confidence.
MAX_SOURCE_CHARS = 200_000

_FENCE_RE = re.compile(r"\A```[A-Za-z]*\s*\n(.*?)\n?```\s*\Z", re.DOTALL)
_THINK_RE = re.compile(r"^\s*<think>.*?</think>\s*", re.DOTALL | re.IGNORECASE)


def bounded_sources(lessons: list[str]) -> str:
    """Lesson text for a prompt, newest first for selection and date order to read.

    `lessons` arrives oldest first. Filling the budget from that end drops the
    newest, which is the exact reverse of what a maturing pattern needs: the most
    recent lessons are the ones that correct it.
    """
    kept: list[str] = []
    total = 0
    for text in reversed(lessons):
        text = (text or "").strip()
        if total + len(text) > MAX_SOURCE_CHARS and kept:
            break
        kept.append(text)
        total += len(text)
    kept.reverse()
    if len(kept) < len(lessons):
        kept.insert(0, f"[{len(lessons) - len(kept)} older reflection(s) omitted to "
                       f"fit the drafting context; the {len(kept)} most recent of "
                       f"{len(lessons)} are included]")
    return "\n\n---\n\n".join(kept)


# --- artifact shapes ---------------------------------------------------------

def skill_shape(pattern: str) -> str:
    return (
        "A markdown file. Line 1 is three hyphens alone. Then a line 'name:' "
        f"followed by exactly {pattern}. Then a line 'description:' followed by "
        "'Use when ' and one specific trigger situation drawn from the lessons "
        "below, at most two sentences. Then three hyphens alone on their own "
        "line. Then a markdown '## ' heading naming the action to take, then the "
        "guidance: imperative, specific, over 80 characters, naming the actual "
        "commands, fields or checks the lessons name.")


def agent_shape(pattern: str) -> str:
    return (
        "The same file shape as a skill: three hyphens alone, a line 'name:' "
        f"followed by exactly {pattern}, a line 'description:' followed by 'Use "
        "when ' and one specific trigger situation, then three hyphens alone. "
        "Then a markdown '## ' heading, then the sub-agent's brief: what it "
        "investigates, what it must read, what it reports back. Over 80 "
        "characters, naming the actual commands, fields or checks the lessons name.")


def rule_shape(_pattern: str) -> str:
    return (
        "Exactly one line, starting with '- ', under 300 characters. No heading, "
        "no frontmatter, no second line: the single imperative the agent must "
        "follow, naming the actual command or check the lessons name.")


# Predicate -> what it takes, in the drafter's own words. Prose, never a JSON
# template: one V1 template was an angle-bracket example and the drafter emitted
# it verbatim. A drafter asked for a gate with no vocabulary in front of it
# invents one; four consecutive forced drafts produced four made-up predicates.
GATE_VOCABULARY = {
    "always": "taking true, which fires on every matching call",
    "tool_is": "taking a list of tool names",
    "command_matches": "taking a regex string, matched against the Bash command",
    "file_path_matches": "taking a glob string, matched against the file path",
    "prompt_matches": "taking a regex string, matched against the user's prompt",
    "all": "taking a list of predicates, true when every one of them is true",
    "any": "taking a list of predicates, true when at least one is true",
    "not": "taking a single predicate and inverting it",
}


def _events() -> tuple[str, str]:
    """(event list, matcher list) from the dispatcher, so the prompt cannot drift
    away from the interpreter that has to execute what it asks for."""
    try:
        events = importlib.import_module("sil.nudge").EVENTS
    except Exception:  # noqa: BLE001 - prompt text degrades, it does not crash
        return ("PreToolUse, PostToolUse, Stop, SessionStart, UserPromptSubmit",
                "Bash, Edit, Write, Read, Grep, Glob, Agent")
    matchers = sorted(set().union(*(m for m in events.values() if m is not None)))
    return ", ".join(sorted(events)), ", ".join(matchers)


def hook_shape(pattern: str) -> str:
    """Self-contained: it names the gate vocabulary itself, because the forced
    (re-home) prompt carries nothing else that would."""
    events, matchers = _events()
    vocab = "; ".join(f"'{name}' {how}" for name, how in sorted(GATE_VOCABULARY.items()))
    return (
        "A JSON object. Its keys: "
        f"'pattern', exactly {pattern}; "
        f"'event', exactly one of: {events}; "
        f"'matcher', only meaningful for PreToolUse and PostToolUse, one of: "
        f"{matchers}; omit the key entirely to match every tool; "
        "'gate', an object holding exactly ONE predicate, named only from this "
        f"closed vocabulary and never invented or substituted: {vocab}. "
        "No predicate can read your own reply, so gate on the tool call that comes "
        "before the mistake, not on the sentence that states it. The gate must be "
        "narrow: one that fires on every tool call is a broadcast and is refused. "
        "'once_per', either 'session' or 'always'; "
        "'text', the nudge shown to the agent: imperative, specific, under 400 "
        "characters, naming the actual commands or checks the lessons name.")


SHAPES = {"skill": skill_shape, "agent": agent_shape, "rule": rule_shape,
          "hook": hook_shape}

FORCED_SUBJECT = {
    "skill": "Claude Code SKILL.md",
    "agent": "Claude Code sub-agent definition",
    "rule": "one-line rule bullet",
    "hook": "Claude Code hook nudge (a JSON object)",
}

_ROUTING_FIELDS = (
    "trigger_event is \"none\", or \"<HookEventName>:<Matcher>\" (for example "
    "\"PreToolUse:Bash\") naming a real Claude Code hook event this lesson could "
    "be checked against mechanically on every matching tool call. gate is a "
    "single-predicate object usable by the nudge dispatcher, or null if no gate "
    "applies. needs_own_context is true only if acting on this lesson needs its "
    "own agent and budget rather than a reminder, and when it is true "
    "context_evidence MUST be an exact substring copied verbatim from the lessons "
    "below that shows that need. Without that quote the lesson is treated as a "
    "discipline rather than an agent. capability_evidence, if set, MUST be an "
    "exact substring copied verbatim from the lessons below, never paraphrased, "
    "naming a concrete thing the agent can actually do that neither a hook nor a "
    "rule can express. declined is true only if no artifact at all is warranted."
)

DRAFTER_SYSTEM = (
    "You write Claude Code artifacts from recurring lessons. You reply with one "
    "JSON object and nothing else: no prose, no code fence, no <think> block."
)

JUDGE_SYSTEM = (
    "You are the last gate before an artifact is committed and starts changing an "
    "agent's behaviour. You reply with one JSON object and nothing else."
)


def draft_messages(pattern: str, lessons: list[str], existing: str | None = None,
                   artifact_type: str | None = None) -> list[dict]:
    """Messages for the drafter.

    `artifact_type` forces a shape (a served_by refine); None lets the reply
    decide. The two are exclusive on purpose: a routing decision is requested if
    and only if the caller will route from it. Asking for one and ignoring it is
    how the body and the route came to disagree in V1.
    """
    sources = bounded_sources(lessons)
    tail = (f"\n\nExisting artifact to refine:\n{existing}" if existing else "")
    if artifact_type in SHAPES:
        user = (
            f"{'Refine the existing' if existing else 'Write a'} "
            f"{FORCED_SUBJECT[artifact_type]} for the recurring lesson "
            f"'{pattern}'. Its type is already decided; do not re-decide it.\n\n"
            "Reply with a JSON object holding exactly one key, \"artifact\". Its "
            f"value is {'an object' if artifact_type == 'hook' else 'a string'} "
            "in this shape:\n"
            + SHAPES[artifact_type](pattern) + "\n\n"
            "Do not restate this task, do not add commentary, do not leave "
            "angle-bracket fill-ins, do not include secrets or tokens.\n\n"
            "Lessons to generalise:\n\n" + sources + tail
        )
    else:
        user = (
            f"Decide what kind of Claude Code artifact the recurring lesson "
            f"'{pattern}' should become, then write that artifact.\n\n"
            "Reply with one JSON object with these keys: trigger_event, gate, "
            "needs_own_context, context_evidence, capability_evidence, declined, "
            "artifact.\n\n" + _ROUTING_FIELDS + "\n\n"
            "\"artifact\" is the body, and WHICH body is decided by the routing "
            "fields you just wrote. Work through these in order and write the "
            "first one that applies, and only that one:\n"
            "1. declined is true: artifact is the empty string.\n"
            "2. trigger_event is not \"none\" and gate is not null: write a HOOK. "
            + hook_shape(pattern) + " Put it in \"artifact\" as an OBJECT.\n"
            "3. needs_own_context is true: write an AGENT, as a string. "
            + agent_shape(pattern) + "\n"
            "4. capability_evidence is set: write a SKILL, as a string. "
            + skill_shape(pattern) + "\n"
            "5. otherwise: write a RULE, as a string. " + rule_shape(pattern) + "\n\n"
            "The body MUST be in the shape the type you selected requires; a body "
            "in the wrong shape is rejected and this lesson is dropped. Do not "
            "restate this task, do not add commentary, do not leave angle-bracket "
            "fill-ins, do not include secrets or tokens.\n\n"
            "Lessons to generalise:\n\n" + sources + tail
        )
    return [{"role": "system", "content": DRAFTER_SYSTEM},
            {"role": "user", "content": user}]


def judge_messages(pattern: str, artifact_type: str, body: str,
                   lessons: list[str]) -> list[dict]:
    """Messages for the judge.

    Adversarial framing, because the permissive version did not discriminate: a
    small model asked whether a skill "faithfully generalizes its sources"
    accepted 4 of 5 candidates, including one that inverted its lesson, and
    justified each by echoing the question's own vocabulary. So enumerate the
    failure modes, force a quote from the artifact as evidence, and make the
    verdict the first field.

    Balanced, not reject-biased. A reject-first wording stopped a 1.7b model
    rubber-stamping but made a 14b model reject a good draft while its own
    reasoning said the instruction was supported. Judge the criteria; accept when
    none are violated.
    """
    user = (
        f"Decide strictly but fairly whether this {artifact_type} may be "
        f"committed for the recurring lesson '{pattern}'. Reject it if it "
        "violates any rule below; accept it if it violates none.\n\n"
        "Reject if ANY of these hold:\n"
        "1. CONTRADICTS: it advises the opposite of what a source concluded.\n"
        "2. VAGUE: it is generic advice ('be careful', 'verify things') that "
        "would not change what someone does. Specific commands or checks must be "
        "named.\n"
        "3. UNSUPPORTED: it instructs something no source supports.\n"
        "4. UNSAFE: it advises skipping a verification a source demands, or "
        "acting on unverified claims to save time.\n"
        "5. UNRELATED: its topic is not the sources' topic.\n\n"
        "Method: quote the artifact's single most important instruction verbatim, "
        "then name the source sentence that supports it, or state that none does. "
        "Do not restate this question's wording as your reasoning.\n\n"
        "Reply with one JSON object: {\"verdict\": \"yes\" or \"no\", "
        "\"reason\": one sentence holding that quote and its supporting source, "
        "or the rule number violated}.\n\n"
        f"ARTIFACT:\n{body}\n\nSOURCES:\n{bounded_sources(lessons)}"
    )
    return [{"role": "system", "content": JUDGE_SYSTEM},
            {"role": "user", "content": user}]


# --- reply parsing -----------------------------------------------------------

def _loads(raw: str) -> dict | None:
    """The reply as an object, tolerating a fence or a leading think block.

    json_mode is a request, not a guarantee: a model may still wrap the object.
    """
    cleaned = _THINK_RE.sub("", raw or "").strip()
    fenced = _FENCE_RE.match(cleaned)
    if fenced:
        cleaned = fenced.group(1).strip()
    if not cleaned.startswith("{"):
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start == -1 or end <= start:
            return None
        cleaned = cleaned[start:end + 1]
    try:
        data = json.loads(cleaned)
    except (json.JSONDecodeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def parse_draft(raw: str, *, forced_type: str | None = None):
    """(body, RouteAnswer) from the drafter's reply.

    An unreadable reply carries `parse_error`, never a default RouteAnswer: a
    default is what a real "no signal, use the conservative fallback" looks like
    to `route()`, and returning it for "I could not read this" would route a
    malformed answer straight at the rules file.

    On the forced path the routing fields are absent by construction. The caller
    short-circuits `route()` there, so the answer is never read, and it is left
    without a `parse_error` so nothing reports a decline the drafter never made.
    """
    from sil.router import RouteAnswer

    data = _loads(raw)
    if data is None:
        head = " ".join((raw or "").split())[:80]
        return "", RouteAnswer(parse_error=(
            f"reply is not a JSON object (starts {head!r})" if head
            else "the provider returned an empty reply"))

    body = data.get("artifact", "")
    if forced_type is not None:
        return _coerce_body(body, forced_type), RouteAnswer()

    fields = {k: v for k, v in data.items() if k != "artifact"}
    # `parse_error` describes our reading of the reply, so the reply does not get
    # to set it: a model echoing the schema back could otherwise send an operator
    # after a provider that worked perfectly.
    fields.pop("parse_error", None)
    try:
        answer = RouteAnswer(**fields)
    except Exception as e:  # noqa: BLE001 - any validation failure gates, never crashes
        return "", RouteAnswer(
            parse_error=f"routing fields failed validation: {type(e).__name__}")
    return _coerce_body(body, None), answer


def _coerce_body(body, forced_type: str | None):
    """A dict for a hook, text for every other type.

    Keyed on the body's own shape when the type is not yet final, because the
    router can disagree with what the drafter proposed. A hook body is an object;
    a SKILL.md, an agent definition and a rule bullet never parse as one.
    """
    if isinstance(body, dict):
        return body
    text = str(body or "")
    cleaned = _THINK_RE.sub("", text).strip()
    fenced = _FENCE_RE.match(cleaned)
    if fenced:
        cleaned = fenced.group(1).strip()
    if forced_type == "hook" or (forced_type is None and cleaned.startswith("{")):
        try:
            parsed = json.loads(cleaned)
        except (json.JSONDecodeError, ValueError):
            # Fall back to the raw string: lint then reports "hook artifact must
            # be a JSON object" and gates the pattern out cleanly, which is the
            # right fail-closed outcome for an unreadable reply.
            return cleaned
        if isinstance(parsed, dict):
            return parsed
    return cleaned


def parse_verdict(raw: str) -> tuple[bool, str]:
    """(accepted, reason). Fails closed, and says so when no verdict was found:
    an unreadable reply must stay distinguishable from a substantive rejection."""
    data = _loads(raw)
    if data is None:
        head = " ".join((raw or "").split())[:150]
        return False, (f"no verdict: unparseable judge reply: {head}" if head
                       else "no verdict: empty judge reply")
    verdict = str(data.get("verdict", "")).strip().lower()
    reason = " ".join(str(data.get("reason", "")).split())[:300]
    if verdict in ("yes", "true", "accept", "accepted"):
        return True, reason or "accepted"
    if verdict in ("no", "false", "reject", "rejected"):
        return False, reason or "rejected"
    return False, f"no verdict: judge replied {verdict!r}"
