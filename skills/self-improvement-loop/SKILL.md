---
name: self-improvement-loop
description: Use when operating the self-improvement loop (`sil`) from Claude Code or Codex, such as checking whether the worker runs, reading reflections or pending lessons, reviewing, accepting, rejecting or retiring a staged skill, hook, rule or agent, rating an artifact good or bad, or a ModelNotConfigured error.
---

# self-improvement-loop

The loop reflects on finished sessions in the background. A lesson seen in
three reflections becomes a staged artifact (skill, hook, rule or agent) on a
branch of the world's target repo. A human accepts or rejects it, unless
`promotion.auto_merge` is on (off by default, never for an `llm: local` world).
Usage and votes then feed the next promotion pass. The engine is the `sil` CLI.

Run `sil` from PATH. If `command -v sil` finds nothing, try `~/.local/bin/sil`
(`sil codex install` and `sil schedule install` both write it).

## Which host you are in

| | Claude Code | Codex or another agent |
| --- | --- | --- |
| This session is recorded | yes, by the plugin hooks | no, nothing records it |
| Lessons injected at start | yes, as context | no, run `sil lessons` |
| Skill use is counted | yes | no |
| Slash commands | `/reflect`, `/loop`, `/curriculum`, `/feedback` | none, call `sil` |

Outside Claude Code you cannot queue the current session. Say so plainly. Do
not run `sil reflect` there: it marks an existing queue entry, and with
`--cwd` it would end some other Claude Code session in the same directory.

## Worlds

Every command acts on one world. Read commands resolve it from the current
directory. `review accept|reject|rehome|retire` and `reflections show` need
`--world <name>`. Take the name from `sil status` (first column of the world
table) or `sil worlds list`. Never guess it.

## Quick reference

| Need | Command |
| --- | --- |
| Is the loop running | `sil status`, `sil schedule show` |
| Did a reflection get written | `sil reflections list --limit 5`, `sil logs worker --lines 50` |
| Reflections behind a pattern | `sil reflections list --pattern <slug>`, then `sil reflections show <id> --world <w>` |
| Lessons waiting for delivery | `sil lessons` (read only, delivers nothing) |
| What curriculum would promote | `sil curriculum plan` (no model calls) |
| What is staged | `sil review list` |
| Artifacts and scorecards | `sil artifacts` |
| Rate an artifact | `sil feedback add <type>:<name> good\|bad --note "<why>"` |
| Model per role | `sil llm list` |
| Web console | `sil web` keeps running: start it detached, read the URL it prints |
| Logs | `sil logs hook\|worker\|web\|curriculum` |

In a ref, `<type>` is `skill`, `hook`, `rule` or `agent`, and for an artifact
the loop made, `<name>` is its pattern slug: `skill:verify-callsites`. The
`review` commands take the bare slug (`verify-callsites`), the first column of
`sil review list`, never a ref.

## Accepting a staged artifact

Accept merges the branch into the world's target repo. A world with `remote:
push` or `remote: pr` also pushes or opens a PR. The human decides, not you.

1. Run `sil review show <pattern> --world <w>`. If it prints `accept
   blocked:`, report the reason and stop.
2. Run `sil review show <pattern> --world <w> --diff` and show the user the
   diff.
3. Wait for an explicit yes to that diff. "Accept X" said before the user saw
   the diff is not that yes.
4. Run `sil review accept <pattern> --world <w> --reviewed-state <hash>` with
   the `reviewed_state:` value printed in step 2. Never invent or reuse an old
   hash. If accept says `reviewed state changed since preview`, the branch
   moved: go back to step 2.

## Rejecting, retiring, re-homing

- `sil review reject <pattern> --world <w>` drops a staged branch.
- A live artifact misfires: record `sil feedback add <ref> bad --note "..."`
  first. To take it out of service, `sil review retire <pattern> --world <w>
  --yes` stages a removal branch. The artifact stays live until that branch
  is accepted with the steps above.
- `sil review rehome <pattern> --type skill|hook|rule|agent --world <w>`
  stages a move to another type. It also applies only on accept.

Never edit or delete artifact files in the target repo by hand.

## When something looks wrong

- `ModelNotConfigured`: a role (`critic`, `drafter` or `judge`) has no model.
  `sil llm list` shows what each role resolves to. `sil llm set-model <role>
  <model>` sets one. A worker under launchd or systemd also needs the
  endpoint's API key env var in its own environment. Never add a fallback
  model or a placeholder key.
- `skipped: transcript not persisted`: the session ran with
  `--no-session-persistence`. Nothing to fix.
- `failed` in the queue: the reflection ran and broke. Read `sil logs worker`.
- Nothing ever happens: `sil schedule show`. With no unit installed, the
  worker runs only when a Claude Code hook kicks it (`worker.auto_kick`, on by
  default) or someone runs `sil worker --once`.

## Rules

- Report what a command printed. Never say a reflection was written unless
  `sil reflections list` shows it.
- `sil worker --once` and `sil curriculum run --apply` call a model and take
  minutes. Run them only when asked, detached, and report that they started.
  `worker --once` also runs curriculum when it is due; add `--no-curriculum`
  for a reflection-only pass.
- Ask before a command that changes state: `review accept|reject|retire|
  rehome`, `aliases set`, `llm use`, `llm set-model`. A vote the user asked
  for needs no extra confirmation.
- A vote only feeds the next planning pass. It never changes an artifact.
- No hook ever blocks a tool call or calls a model, and `sil curriculum run`
  never pushes. Nothing reaches a shared remote without an accept.
