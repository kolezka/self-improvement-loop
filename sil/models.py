"""Shared data models (pydantic). Not importable from the hook fast path."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


# --- config -----------------------------------------------------------------

class Layout(BaseModel):
    """Paths inside a world's target repo. Defaults match the built-in
    `learned/` repo; the V1 dotfiles layout is `claude/skills`,
    `claude/hooks/nudges`, `claude/agents`, `global.CLAUDE.md`,
    `claude/skills/promotions.json`."""

    skills_dir: str = "skills"
    nudges_dir: str = "nudges"
    agents_dir: str = "agents"
    rules_file: str = "RULES.md"
    ledger: str = "promotions.json"


class OutlineExport(BaseModel):
    base_url: str
    api_key_env: str = "OUTLINE_API_KEY"
    collection_id: str
    parent_document_id: str | None = None


class World(BaseModel):
    name: str
    llm: Literal["local", "cloud"] = "cloud"
    repos: list[Path] = Field(default_factory=list)
    target: Path | None = None
    layout: Layout = Field(default_factory=Layout)
    remote: Literal["none", "push", "pr"] = "none"
    rules_inject: bool = True
    outline: OutlineExport | None = None
    llm_config: Path | None = None


class Promotion(BaseModel):
    threshold: int = 3
    per_run_cap: int = 3
    auto_merge: bool = False
    retire_after_days: int = 45


class WorkerConfig(BaseModel):
    idle_minutes: int = 10
    curriculum_interval_minutes: int = 60
    min_tool_uses: int = 6
    auto_kick: bool = True


class WebConfig(BaseModel):
    port: int = 8766


class Config(BaseModel):
    version: int = 1
    worlds: list[World] = Field(default_factory=lambda: [World(name="default")])
    promotion: Promotion = Field(default_factory=Promotion)
    worker: WorkerConfig = Field(default_factory=WorkerConfig)
    web: WebConfig = Field(default_factory=WebConfig)


# --- llm --------------------------------------------------------------------

class Endpoint(BaseModel):
    name: str
    kind: Literal["openai", "claude-cli"] = "openai"
    base_url: str | None = None
    api_key_env: str | None = None
    timeout_s: int = 240


ROLES = ("critic", "drafter", "judge")


class LlmConfig(BaseModel):
    endpoints: list[Endpoint] = Field(default_factory=list)
    active: str | None = None
    local_models: list[str] = Field(default_factory=list)
    models: dict[str, str] = Field(default_factory=dict)


# --- queue ------------------------------------------------------------------

class QueueEntry(BaseModel):
    session_id: str
    transcript_path: Path
    cwd: Path
    world: str
    git_head: str | None = None
    first_stop: str
    last_stop: str
    stops: int = 1
    ended: bool = False
    tool_uses: int = 0
    attempts: int = 0
    result: str | None = None


# --- usage / feedback -------------------------------------------------------

class UsageEvent(BaseModel):
    """One line of usage/events.jsonl.

    kind: skill | agent | agent_stop | hook_run
    ref:  artifact ref `<type>:<name>` when resolvable, e.g. skill:verify-callsites,
          agent:explorer, hook:PreToolUse:Bash
    """

    ts: str = Field(default_factory=now_iso)
    session_id: str
    world: str
    kind: str
    ref: str
    detail: dict = Field(default_factory=dict)


class HumanFeedback(BaseModel):
    ts: str = Field(default_factory=now_iso)
    world: str
    ref: str
    vote: Literal["good", "bad"]
    note: str = ""
    session_id: str | None = None


class Scorecard(BaseModel):
    ref: str
    type: str
    name: str
    uses_30d: int = 0
    fires_30d: int = 0
    helpful: int = 0
    misfired: int = 0
    human_good: int = 0
    human_bad: int = 0
    last_used: str | None = None
    proposal: Literal["keep", "refine", "retire-candidate", "new"] = "keep"
    reason: str = ""


# --- reflections ------------------------------------------------------------

class Reflection(BaseModel):
    id: str
    world: str
    pattern: str
    path: Path
    created: str
    session_id: str | None = None
    cwd: Path | None = None
    revision: str | None = None
    model: str | None = None
    artifacts_used: list[str] = Field(default_factory=list)
    artifacts_helpful: list[str] = Field(default_factory=list)
    artifacts_misfired: list[str] = Field(default_factory=list)
    lesson: str = ""
    body: str = ""


class Lesson(BaseModel):
    """Inbox item delivered to a later session as additionalContext."""

    id: str
    world: str
    pattern: str
    text: str
    created: str = Field(default_factory=now_iso)
    reflection_id: str | None = None
    repo: Path | None = None


# --- ledger -----------------------------------------------------------------

class ArtifactType(str, Enum):
    skill = "skill"
    hook = "hook"
    rule = "rule"
    agent = "agent"
    none = "none"


class ArtifactRef(BaseModel):
    type: ArtifactType
    path: str | None = None


class PromotionEntry(BaseModel):
    pattern: str
    promoted_at_count: int = 0
    rejected_at_count: int = 0
    status: Literal["staged", "promoted", "rejected", "retired"] = "staged"
    artifact_type: ArtifactType = ArtifactType.none
    served_by: ArtifactRef | None = None
    last_updated: str = Field(default_factory=now_iso)
    commit: str | None = None
    feedback: Scorecard | None = None


class Ledger(BaseModel):
    version: int = 1
    entries: dict[str, PromotionEntry] = Field(default_factory=dict)


# --- curriculum reports -----------------------------------------------------

class PlanAction(BaseModel):
    pattern: str
    count: int
    watermark: int
    action: Literal["promote", "refine", "over-cap", "below-threshold", "done", "retire-candidate"]
    sources: list[str] = Field(default_factory=list)
    reason: str = ""


class PlanReport(BaseModel):
    world: str
    threshold: int
    actions: list[PlanAction] = Field(default_factory=list)


class RunReport(BaseModel):
    world: str
    dry_run: bool = True
    staged: list[str] = Field(default_factory=list)
    merged: list[str] = Field(default_factory=list)
    gated_out: dict[str, str] = Field(default_factory=dict)
    dropped: dict[str, int] = Field(default_factory=dict)
    started: str = Field(default_factory=now_iso)
    finished: str | None = None
    error: str | None = None


# --- review -----------------------------------------------------------------

class ReviewItem(BaseModel):
    world: str
    pattern: str
    branch: str
    artifact_type: ArtifactType
    artifact_path: str | None = None
    count: int = 0
    staged_at: str | None = None
    commit: str | None = None


class ReviewDetail(ReviewItem):
    body: str = ""
    sources: list[str] = Field(default_factory=list)
    reviewed_state: str
    accept_blocked: str | None = None


class ReviewDiff(BaseModel):
    world: str
    pattern: str
    diff: str
    reviewed_state: str


class RouterRow(BaseModel):
    pattern: str
    artifact_type: ArtifactType
    served_by: str | None = None
    status: str
    reflections: int = 0
    scorecard: Scorecard | None = None
