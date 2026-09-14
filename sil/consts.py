"""Literals shared by the stdlib hook path and the engine. Stdlib only."""

# Managed rules block. Same literals as V1 so a dotfiles CLAUDE.md keeps working.
RULE_START = "<!--loop-rules:start-->"
RULE_END = "<!--loop-rules:end-->"
RULE_TAG = "<!--rule:{pattern}-->"

# Hook config snapshot written by the engine, read by the stdlib hook.
HOOK_SNAPSHOT = "hook-config.json"

# Hook events the plugin registers.
HOOK_EVENTS = (
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "SubagentStop",
    "SessionEnd",
)

# Artifact reference format: `<type>:<name>`.
ARTIFACT_TYPES = ("skill", "hook", "rule", "agent")
