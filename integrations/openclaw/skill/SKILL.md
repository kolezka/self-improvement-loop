---
name: self-improvement-loop
description: Use when working with the self-improvement loop from OpenClaw - reading the lesson block in the workspace file, queueing this session for reflection, listing reflections or lessons, or rating a staged artifact with good/bad feedback.
---

# self-improvement-loop (OpenClaw)

Background reflection on sessions. It promotes a lesson seen three times into
an artifact (skill, hook, rule or agent), tracks whether that artifact gets
used, and feeds the result into the next promotion decision. The engine is the
`sil` CLI; OpenClaw is one of its hosts, Claude Code is the other.

## What runs by itself

- At session start and at gateway start, the plugin runs `sil openclaw sync`.
  That writes the world's rules and up to 5 pending lessons into the block
  between `<!--sil:start-->` and `<!--sil:end-->` in the workspace bootstrap
  file (`AGENTS.md` by default). Everything inside the block is machine owned
  and is replaced on the next sync. Edit around it, never inside it.
- At session end, the plugin runs `sil openclaw enqueue --ended` for the
  session that just finished. A worker pass picks it up later.
- When you read a `skills/<name>/SKILL.md` file, the plugin records one usage
  event for that skill. That is how skill usage is counted here: there is no
  Skill tool in OpenClaw.

Nothing in that path calls a model and nothing blocks a turn.

## Commands to run with `exec`

- `sil openclaw status` shows the install state, the workspace in use, how
  many sessions exist and how many wait in the queue.
- `sil openclaw sync --dry-run` prints the block that would be written,
  without writing it and without counting a lesson as delivered.
- `sil openclaw scan --max-age-hours 24` queues recent sessions. Use it when
  the plugin is not enabled, or after the gateway was restarted mid session.
- `sil lessons` lists pending lessons, `sil reflections list` lists
  reflections, `sil review list` lists staged artifacts.
- `sil feedback add skill:<name> good|bad --note "..."` rates an artifact.
  Use it when an artifact helped or got in the way.
- `sil worker --once` runs one reflection pass now. It calls a model, so it is
  slow. Do not run it in a hot loop.

## Rules for the agent

- Never edit the `<!--sil:start-->` block by hand. Run `sil openclaw sync`.
- A lesson counts as delivered the moment it is written into the workspace
  file, so a sync you trigger for fun spends the delivery.
- Report what a command printed. Do not claim a reflection was written: the
  worker decides that, not the queueing step.
