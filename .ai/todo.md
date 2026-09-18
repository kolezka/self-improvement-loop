# OpenClaw integration for self-improvement-loop

Goal: run the same loop (reflect, promote, deliver, measure) for OpenClaw
sessions, not only Claude Code sessions.

## Facts the design is built on (verified in this session)

- OpenClaw writes one JSONL transcript per session at
  `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`. Record types:
  `session` (header, holds `id` and `cwd`), `message`, `model_change`,
  `thinking_level_change`, `custom`. A `message` holds `message.role` of
  `user`, `assistant` or `toolResult`; assistant content holds `toolCall`
  blocks; shell runs through the `exec` tool.
- OpenClaw has no Claude Code style hook contract. Third party code plugs in
  as a plugin under `~/.openclaw/extensions/<id>/` with an
  `openclaw.plugin.json` manifest, loaded by jiti (`.ts`, `.js`, `.mjs`).
- Typed plugin hooks used here: `session_start`, `session_end`,
  `after_tool_call`. They are not gated by config. Internal hooks
  (`agent:bootstrap`) are gated by `hooks.internal.enabled === true`, so they
  are not used.
- Workspace bootstrap files (AGENTS.md, SOUL.md, ...) are injected in every
  session. OpenClaw caps each file at 20000 chars (`BOOTSTRAP_MAX_CHARS`) and
  the whole set at 150000 (`BOOTSTRAP_TOTAL_MAX_CHARS`), verified in the
  2026.2.26 bundle. That is the lesson delivery path.
- Skills live at `<workspace>/skills/<name>/SKILL.md`; `description` is
  required, `name` is optional.

## Tasks

- [x] `packages/transcript`: OpenClaw record adapter, format autodetect, so
      `evidencePack()` and `countToolUses()` work on both formats.
- [x] `packages/store`: `markDelivered()` on the lesson inbox (deliveries
      counter plus archive at 5), so the OpenClaw path shares the Claude Code
      delivery accounting.
- [x] `packages/openclaw`: host paths, session discovery, queue enqueue,
      workspace lesson block sync, plugin and skill install.
- [x] `apps/cli`: `sil openclaw install|sync|scan|enqueue|status`.
- [x] `integrations/openclaw/plugin`: the OpenClaw plugin (session_start ->
      sync, session_end -> enqueue, after_tool_call -> skill usage event).
- [x] `integrations/openclaw/skill`: workspace skill that tells the agent what
      the loop is and how to give feedback.
- [x] Tests: adapter, discovery, enqueue, workspace sync, CLI.
- [x] Docs: `docs/OPENCLAW.md`, README pointer, ARCHITECTURE note.

## Review

- Reflection trigger has two paths: the plugin (`session_end`, immediate) and
  `sil openclaw scan` (poll, idle based). The scan path works with no plugin
  installed, so the integration degrades to "install nothing in OpenClaw".
- Lesson delivery lags one session when it runs from `session_start`, because
  bootstrap files are read before the hook writes the block. `sil openclaw
  sync` before a session removes the lag. This is documented, not hidden.
- Usage events from OpenClaw count a read of `skills/<name>/SKILL.md` as a
  skill use. OpenClaw has no `Skill` tool; reading the file is how a skill is
  used there.
- The SKILL.md read is renamed to a `Skill` tool call, not duplicated. The
  first version emitted both and inflated `counts.tool_uses`, which feeds the
  `worker.min_tool_uses` eligibility gate.
- Verified: `bun test` 845 pass 0 fail, `bun run typecheck` clean,
  `bun run lint:dashes` clean, and `sil openclaw status` plus
  `sil openclaw sync --dry-run` run against the real `~/.openclaw` install
  without writing to it.
