# OpenClaw integration

The loop is not tied to Claude Code. OpenClaw sessions can feed the same queue,
the same reflections, the same curriculum and the same review UI. This page is
the whole contract: what gets installed, what runs when, and what is different
from the Claude Code host.

Verified against OpenClaw 2026.2.26.

## What OpenClaw gives us, and what it does not

| Need | Claude Code | OpenClaw |
| --- | --- | --- |
| Session transcript | `~/.claude/projects/**/<id>.jsonl` | `~/.openclaw/agents/<agentId>/sessions/<id>.jsonl` |
| Queue a session | `Stop` / `SessionEnd` hook | plugin `session_end`, or `sil openclaw scan` |
| Deliver a lesson | `SessionStart` `additionalContext` | managed block in a workspace bootstrap file |
| Count skill usage | `Skill` tool in `PostToolUse` | a `read` of `skills/<name>/SKILL.md` |

OpenClaw has no hook that can inject context per session the way Claude Code's
`SessionStart` does. What it does have is the workspace bootstrap files
(`AGENTS.md` and friends), injected into every session. So lessons go there,
inside markers, and OpenClaw delivers them for free.

## Install

```
sil openclaw install --enable
sil openclaw status
```

`install` copies three things and touches nothing else:

- `~/.openclaw/extensions/self-improvement-loop/` gets the plugin
  (`openclaw.plugin.json`, `index.mjs`) plus `sil-config.json`, which records the
  `sil` command path, the world name and the sil state dir.
- `<workspace>/skills/self-improvement-loop/SKILL.md` gets the skill that tells
  the agent how to use the loop.
- With `--enable`, `plugins.entries."self-improvement-loop".enabled` is set to
  true in `~/.openclaw/openclaw.json`. The previous file is kept as
  `openclaw.json.sil-bak`. Without `--enable` nothing in the OpenClaw config is
  touched; run `openclaw plugins enable self-improvement-loop` yourself.

Restart the gateway afterwards. OpenClaw loads plugins at startup.

The plugin is copied, never symlinked, so pulling a new sil version does not
silently change what the gateway runs. Re-run `sil openclaw install` to update.

## What runs when

- `session_start` and `gateway_start` run `sil openclaw sync`, detached.
- `session_end` runs `sil openclaw enqueue --session <id> --ended`, detached.
- `after_tool_call` appends one `kind: "skill"` usage event when a successful
  `read` hits `skills/<name>/SKILL.md`.

Every handler is fire and forget. The plugin never awaits the CLI, never calls a
model, and never blocks a turn. A missing or broken `sil` writes one line
through `api.logger` and is otherwise invisible to the agent.

`session_start` and `session_end` only fire on the new-session path (`/new`,
`/reset`, auto-reset). A long running session that is never reset never fires
either one, which is why `sil openclaw scan` exists.

## Without the plugin

The plugin is optional. This alone keeps the loop fed:

```
sil openclaw scan --max-age-hours 24
sil openclaw sync
```

Run it from the same schedule that runs `sil worker`. `scan` queues every
OpenClaw transcript that is not already reflected; the worker's idle window
(`worker.idle_minutes`) then decides when a session is quiet enough to reflect,
exactly as it does for Claude Code. The cost of the polling path is one lost
signal: a session queued by `scan` has no `ended` flag, so it waits out the idle
window instead of being picked up at once.

## The managed block

`sil openclaw sync` writes into `<workspace>/AGENTS.md` (change it with
`--file`):

```
<!--sil:start-->
## self-improvement-loop (world: default)
...rules and lessons...
<!--sil:end-->
```

Everything between the markers is machine owned and is replaced on every sync.
Text outside the markers is never touched, and a file with no markers gets the
block appended. Edit around it, never inside it.

The block is capped at 4000 characters. OpenClaw caps each bootstrap file at
20000 chars (`agents.bootstrapMaxChars`) and the whole bootstrap set at 150000
(`agents.bootstrapTotalMaxChars`), so the block stays small enough to leave room
for the file's real content. Rules go in first, then lessons while they fit; a
rules block that alone blows the budget is trimmed and marked
`(rules trimmed by sil)` rather than pushing the lessons out.

A lesson is counted as delivered when it is written into the block, using the
same counter the Claude Code hook uses. Five deliveries archive it. So
`sil openclaw sync --dry-run` exists: it prints the block and spends nothing.

Because the sync runs at session start, a lesson created during a session lands
in the next one. Claude Code's `UserPromptSubmit` delivery has no equivalent
here.

## Transcripts

Nothing in the worker or the critic knows about OpenClaw. `@sil/transcript`
detects the format from the first record of the file and translates OpenClaw
records into the Claude Code shape:

- `message.role` `user` / `assistant` / `toolResult` become `user` / `assistant`
  records with `text`, `tool_use` and `tool_result` blocks.
- `exec` is renamed to `Bash`, so bash and test-command detection keeps working.
- A `read` of `skills/<name>/SKILL.md` is renamed to a `Skill` tool call, so
  skill usage is counted. The call is renamed, not duplicated: one tool call
  stays one tool call in the evidence counts.
- `thinking` blocks, `model_change`, `thinking_level_change` and `custom`
  records are dropped. They carry no evidence.

## Worlds

A session maps to a world by its `cwd`, taken from the transcript header, using
the same longest-prefix match as Claude Code. A session with no header (or an
agent that never left the workspace) falls back to the workspace dir, which
normally lands in the catch-all world. `--world <name>` forces one instead.

## Commands

| Command | What it does |
| --- | --- |
| `sil openclaw install [--enable] [--workspace <path>]` | copy the plugin and the skill, write the install config |
| `sil openclaw sync [--dry-run] [--file AGENTS.md] [--limit 5]` | write rules and lessons into the workspace file |
| `sil openclaw scan [--max-age-hours 24]` | queue sessions for reflection |
| `sil openclaw enqueue --session <id> [--agent <id>] [--ended]` | queue one session |
| `sil openclaw status [--json]` | install state, workspace, session and queue counts |

`OPENCLAW_CONFIG_DIR` (or `OPENCLAW_HOME`) moves the OpenClaw dir;
`OPENCLAW_WORKSPACE_DIR` overrides the workspace. Otherwise the workspace comes
from `agents.defaults.workspace` in `openclaw.json`, then
`<openclaw dir>/workspace`.

## Limits

- Lesson delivery lags one session when it rides on `session_start`.
- A session that is never reset never fires `session_start` or `session_end`.
  Keep `sil openclaw scan` on the schedule even with the plugin enabled.
- Usage events written by the plugin carry OpenClaw's session key, not the
  transcript session id, so they group per session but do not join a queue entry
  by id.
- Nothing reads OpenClaw's own `hooks.internal` entries. A plugin-registered
  internal hook only wires up when `hooks.internal.enabled` is true, which is not
  the default, so the integration does not depend on it.
