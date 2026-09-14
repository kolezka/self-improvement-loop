---
name: self-improvement-loop
description: Use when operating the self-improvement loop, reading or listing reflections, rating an artifact with good/bad feedback, or reviewing a staged skill, hook, rule or agent before accepting or rejecting it.
---

# self-improvement-loop

Background reflection on sessions that promotes recurring lessons into
artifacts (skills, hooks, rules, agents), tracks whether those artifacts get
used, and feeds that back into the next promotion decision.

## How it works, briefly

1. Hooks record queue entries and usage events in the background. They never
   block and never call a model.
2. A worker, run by `sil worker` on a schedule, reflects on ended or idle
   sessions: it builds evidence from the transcript, calls one model (the
   `critic` role), and writes a reflection document if there is a supported
   lesson.
3. Reflections cluster by a `Pattern:` slug. Three occurrences of the same
   pattern make it eligible for promotion.
4. The curriculum step drafts an artifact, routes it deterministically to a
   type (hook, rule, skill or agent), lints it, judges it, and stages a
   branch. Nothing merges without a human.
5. A lesson also drops into the world's inbox and reaches the next session as
   `additionalContext` at `SessionStart` and `UserPromptSubmit`.

## The four commands

- `/reflect` queues a background reflection on the current session. It never
  waits and never claims a reflection was written.
- `/loop` prints worker status; `/loop web` starts the local review UI;
  `/loop run` triggers one worker pass.
- `/curriculum` previews what would be promoted (dry run, no model calls);
  `/curriculum apply` drafts and stages branches, detached.
- `/feedback <type>:<name> good|bad [note]` records a human vote on an
  artifact, e.g. `/feedback skill:verify-callsites bad wrong call site`.

## Where files live

- Config: `$SIL_CONFIG_DIR` (default `~/.config/self-improvement-loop/`):
  `config.yaml` (worlds, promotion knobs, worker cadence), `llm.yaml`
  (endpoints and model roles).
- State: `$SIL_STATE_DIR` (default `~/.local/state/self-improvement-loop/`):
  the queue, usage events, human feedback, the inbox, logs, `worker.lock`.
- Data: `$SIL_DATA_DIR` (default `~/.local/share/self-improvement-loop/`):
  reflections and aliases per world, and the built-in `learned/` target repo
  for a world that configures no `target`.

## How lessons reach a session

`SessionStart` injects the world's managed rules block (if `rules_inject` is
on), up to 3 undelivered inbox lessons, and a one-line loop status.
`UserPromptSubmit` delivers any inbox lessons that arrived since session
start, once each. Nothing is delivered twice on purpose.

## Rating an artifact

Use `/feedback` with a `<type>:<name>` ref, or `sil feedback add <ref>
good|bad --note "..."` directly. Votes feed per-artifact scorecards; the
planner reads those and proposes `refine` or `retire-candidate`, a human
decides. `sil review show <pattern> --diff` shows a staged artifact before
you rate or accept it.

## What never happens

No hook ever blocks a tool call or asks a consent question: consent is the
`rules_inject`/`remote` config, not a Stop-hook prompt. No hook calls a
model. Nothing reaches a shared remote without an explicit `sil review
accept` (or the web UI's accept), bound to a `reviewed_state` digest of
exactly what was reviewed. `sil curriculum run` stages branches only, it
never pushes and never auto-merges for a `llm: local` world.
