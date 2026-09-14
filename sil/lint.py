"""Deterministic lint for a self-authored artifact. Pure, stdlib only.

Empty list means clean. This is the cheap gate before the model judge; it never
passes an artifact that is malformed, mis-slugged, trivially short, secret
bearing, an echo of the drafting prompt, or ungrounded in its own sources.

Ported from V1's skilllint + artifactlint, merged because the split only ever
existed to keep two sets of callers apart.
"""

from __future__ import annotations

import importlib
import json
import re

from sil.consts import RULE_END, RULE_START, RULE_TAG

MAX_DESCRIPTION = 500
MAX_SENTENCES = 2
MAX_RULE_CHARS = 300
MIN_BODY_CHARS = 80
MIN_SHARED_TERMS = 4

_FRONTMATTER = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)\Z", re.DOTALL)
_TRIGGER_RE = re.compile(r"(use when|trigger)", re.IGNORECASE)

# Coarse secret sniff. High-signal tokens only.
SECRET_RE = re.compile(
    r"(AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|"
    r"(api[_-]?key|secret|token|password)\s*[:=]\s*['\"]?[A-Za-z0-9/\+_-]{16,})",
    re.IGNORECASE,
)

# An unreplaced placeholder from the drafting template. A staged skill once
# shipped `description: Use when <the situation that should trigger this skill>`
# and both the lint and the judge accepted it, producing a skill that can never
# fire. Multi-word angle brackets only, so `git log -- <file>` and `Vec<String>`
# survive.
_PLACEHOLDER_RE = re.compile(r"<[A-Za-z][A-Za-z-]*(?:\s+[A-Za-z][A-Za-z-]*)+>")

# Prompt echo. A staged skill once carried the drafting prompt's worked example
# as its body, with valid frontmatter and a matching name. Keep in lockstep with
# sil/prompts.py.
_SCAFFOLD_MARKERS = (
    "source reflections:",
    "now write the real one",
    "both '---' delimiter lines",
    "must begin with 'use when'",
    "existing skill to refine:",
    "existing artifact to refine:",
    "lessons to generalise:",
    "decide what kind of claude code artifact",
    "copy the structure, never the wording",
    "write the first one that applies",
)

_SENTENCE_END = re.compile(r"[.!?](?:\s|$)")
# `e.g.` and `i.e.` end in a period plus a space, which looks exactly like a
# sentence end. Blank them before counting: a false "3 sentences" does not
# shorten a draft, it drops the pattern out of the loop.
_ABBREVIATION = re.compile(r"\b(?:e\.g|i\.e|etc|vs|cf|al)\.", re.IGNORECASE)

_WORD_RE = re.compile(r"[a-z][a-z0-9_-]{4,}")
# Words carrying no topic signal, so sharing them proves nothing about grounding.
_GENERIC = frozenset("""
about above after again against always because before being below between both
check checks claim could doing during evidence every first further given having
however itself might other properly should since their there these things think
those through under until using verify whether which while would your result
results ensure ensures never making makes made
""".split())

# The opening of a per-pattern rule tag. A bullet carrying one would be written
# into the managed block with two tags, and the second is what removal misses.
_RULE_TAG_OPEN = RULE_TAG.split("{", 1)[0]

_heading_words: frozenset[str] | None = None


def _template_words() -> frozenset[str]:
    """Words from the reflection template's own section headings.

    Every reflection carries them, so a body that echoes "worked", "failed",
    "reusable lesson", "verification" shares them with its sources while saying
    nothing about them. Counted as grounding, five of those headings alone clear
    the bar and vacuous filler passes.

    Read from `store.SECTIONS` rather than copied, so editing the template moves
    both. Imported at call time to keep this module's imports stdlib-only, and
    not guarded: an unimportable store would quietly widen what counts as
    grounding, which is the failure this function exists to close.
    """
    global _heading_words
    if _heading_words is None:
        sections = importlib.import_module("sil.store").SECTIONS
        _heading_words = frozenset(
            word for heading in sections for word in _WORD_RE.findall(heading.lower()))
    return _heading_words


def _payload_text(payload) -> str:
    """One string to sniff for secrets, whatever shape the artifact is."""
    if isinstance(payload, str):
        return payload
    try:
        return json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    except (TypeError, ValueError):
        return str(payload)


def _field(name: str, front_matter: str) -> str | None:
    for line in front_matter.splitlines():
        if line.lower().startswith(name + ":"):
            return line.split(":", 1)[1].strip()
    return None


def _count_sentences(desc: str) -> int:
    return len(_SENTENCE_END.findall(_ABBREVIATION.sub("", desc.strip())))


def lint_description_cap(desc: str) -> list[str]:
    """Bound the one field that decides whether a skill ever triggers.

    One V1 description grew to a single ~300-word sentence carrying twenty
    disjunctive triggers, one appended per refine cycle. A description that long
    is less likely to fire, so the growth the loop called refinement was making
    the skill worse on the only axis that matters.
    """
    problems: list[str] = []
    if len(desc) > MAX_DESCRIPTION:
        problems.append(
            f"`description` is {len(desc)} chars; the cap is {MAX_DESCRIPTION}. "
            f"A trigger is one situation, not a disjunction of twenty.")
    n = _count_sentences(desc)
    if n > MAX_SENTENCES:
        problems.append(f"`description` has {n} sentences; the cap is {MAX_SENTENCES}")
    return problems


def lint_grounding(body: str, sources_text: str,
                   *, min_shared: int = MIN_SHARED_TERMS) -> list[str]:
    """Flag a body that does not reuse its sources' distinctive vocabulary.

    Vacuous filler ("be careful, verify things properly") is the one failure the
    model judge does not catch: measured, it credited the sources' specificity to
    the artifact. A real artifact names the metrics, commands and fields its
    sources name, so shared distinctive terms separate the two mechanically.
    """
    excluded = _GENERIC | _template_words()

    def terms(text: str) -> set[str]:
        return {w for w in _WORD_RE.findall(text.lower()) if w not in excluded}

    shared = terms(body) & terms(sources_text)
    if len(shared) < min_shared:
        return [f"body not grounded in its sources: only {len(shared)} distinctive "
                f"term(s) shared ({sorted(shared)}); reads as generic filler"]
    return []


def lint_skill(text: str, pattern: str, *, min_body_chars: int = MIN_BODY_CHARS) -> list[str]:
    """Structural lint for a SKILL.md or an agent definition (same file shape)."""
    problems: list[str] = []
    match = _FRONTMATTER.match(text or "")
    if not match:
        return ["missing or malformed frontmatter (--- ... --- at top of file)"]
    front_matter, body = match.group(1), match.group(2)

    name = _field("name", front_matter)
    if not name:
        problems.append("frontmatter missing non-empty `name`")
    elif name != pattern:
        problems.append(
            f"frontmatter `name` ({name!r}) must equal the pattern ({pattern!r})")

    desc = _field("description", front_matter)
    if not desc:
        problems.append("frontmatter missing non-empty `description`")
    elif not _TRIGGER_RE.search(desc):
        problems.append(
            "`description` must read as a trigger (contain 'Use when' or 'Trigger')")
    else:
        problems.extend(lint_description_cap(desc))

    if len(body.strip()) < min_body_chars:
        problems.append(f"body too short (< {min_body_chars} non-whitespace chars)")

    for placeholder in dict.fromkeys(_PLACEHOLDER_RE.findall(text)):
        problems.append(f"unreplaced template placeholder: {placeholder}")

    low = text.lower()
    for marker in _SCAFFOLD_MARKERS:
        if marker in low:
            problems.append(f"drafting-prompt scaffolding echoed into the artifact: {marker!r}")

    return problems


def lint_rule(text: str, pattern: str | None = None) -> list[str]:
    """A rule is exactly one bullet with a bounded length and no block markers.

    `pattern` is what the writer will tag the bullet with. Without it the cap is
    measured against a shorter line than the one that reaches disk.
    """
    lines = [line for line in (text or "").strip().splitlines() if line.strip()]
    if len(lines) != 1:
        return [f"a rule is exactly one bullet; got {len(lines)} line(s)"]
    line = lines[0].strip()
    problems = []
    if not line.startswith("- "):
        problems.append("a rule must start with '- '")

    # A bullet carrying the block's own syntax wedges the rules file for good:
    # a second marker pair makes every later write and every retire ambiguous,
    # and a second tag survives the removal that matches only the last one.
    for marker in (RULE_START, RULE_END, _RULE_TAG_OPEN):
        if marker in line:
            problems.append(
                f"rule contains the managed-block marker {marker!r}; writing it "
                f"would make the rules file unreadable and unretireable")

    # The writer appends " <!--rule:pattern-->", so the cap covers it.
    tag = RULE_TAG.format(pattern=pattern) if pattern else ""
    total = len(line) + (1 + len(tag) if tag else 0)
    if total > MAX_RULE_CHARS:
        detail = f" once its {tag} tag is appended" if tag else ""
        problems.append(f"rule is {total} chars{detail}; the cap is {MAX_RULE_CHARS}")
    return problems


def lint_hook(payload) -> list[str]:
    """Delegate to the nudge dispatcher's own file-format lint.

    Imported lazily so this module stays usable before the hook half of the
    plugin is present, and so a test can inject a fake dispatcher.
    """
    if not isinstance(payload, dict):
        return ["hook artifact must be a JSON object"]
    try:
        nudge = importlib.import_module("sil.nudge")
    except ImportError as e:
        return [f"nudge dispatcher unavailable, cannot lint a hook: {e}"]
    return list(nudge.lint_nudge(payload))


def lint(artifact_type: str, payload, pattern: str, sources_text: str) -> list[str]:
    """Empty list means clean. `payload` is a dict for hooks, text for the rest.

    Grounding and the secret sniff apply to every type: vacuous filler and a
    leaked token are both type-independent.

    A payload shaped for one type can reach another type's path for real, not
    just in a fixture: a served_by suppression forces the ledger's type onto
    whatever the drafter returned. So each branch checks the shape it needs
    before touching it.
    """
    if artifact_type == "none":
        return []

    if artifact_type == "hook":
        if not isinstance(payload, dict):
            return ["hook artifact must be a JSON object"]
        problems = lint_hook(payload)
        # The dispatcher keys its once-per-session marker and its fire log on the
        # payload's own `pattern`. Unbound, a hook logs its fires under another
        # artifact's name and burns that artifact's marker for the session.
        if payload.get("pattern") != pattern:
            problems.append(
                f"hook `pattern` ({payload.get('pattern')!r}) must equal the "
                f"artifact's pattern ({pattern!r})")
        body = str(payload.get("text", ""))
    elif artifact_type == "rule":
        if not isinstance(payload, str):
            return [f"rule artifact must be text, not {type(payload).__name__}"]
        problems = lint_rule(payload, pattern)
        body = payload
    elif artifact_type in ("skill", "agent"):
        if not isinstance(payload, str):
            return [f"{artifact_type} artifact must be text, not {type(payload).__name__}"]
        problems = lint_skill(payload, pattern)
        body = payload
    else:
        return [f"unknown artifact type {artifact_type!r}"]

    # Every type, against the whole serialised artifact. Run only on the skill
    # path, this missed a token in a rule bullet and in any hook field.
    if SECRET_RE.search(_payload_text(payload)):
        problems.append("possible secret or token detected; refusing to promote")

    problems.extend(lint_grounding(body, sources_text))
    return problems
