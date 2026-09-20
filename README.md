# self-improvement-loop

A Claude Code plugin that watches your sessions, reflects on them in the
background, and promotes recurring lessons into skills, hooks, rules and agents.
It tracks whether those artifacts actually get used, and feeds that back into the
next promotion decision. Nothing reaches a shared remote without a human.

## The loop, in words

Hooks record what happened in a session (fast, one bundled script, never blocks, never
calls a model). A worker, running on a schedule outside any session, reflects on
sessions that ended or went idle: it builds evidence from the transcript, makes
one model call, and writes a reflection if there is a real lesson. Reflections
cluster by pattern; three occurrences of the same pattern trigger curriculum,
which drafts and stages an artifact on a branch. You review and accept it (or
reject, rehome, retire it) in the web UI or the CLI. Once accepted, the next
session that matches gets the lesson delivered as context, and usage of the new
artifact starts feeding a scorecard that the next curriculum pass reads.

See `docs/ARCHITECTURE.md` for the full picture and `docs/V1-PARITY.md` for what
carried over from the previous (`dotfiles-next`) version of this loop and what
changed.

## Install

```
claude plugin marketplace add kolezka/marketplace
claude plugin install self-improvement-loop@kolezka
```

See `docs/INSTALL.md` for local dev installs and running on a schedule.

## First run

```
sil init
sil web
```

`sil init` writes `config.yaml` and `llm.yaml` templates and a `learned/` repo for
the default world. Edit `llm.yaml` and set `models.critic`, `models.drafter` and
`models.judge` before the worker can call a model. `sil web` opens the local
review UI.

## How lessons reach a session

`SessionStart` and `UserPromptSubmit` hooks inject up to a few undelivered lessons
for the current world as `additionalContext`. A lesson is delivered once, then
marked so it is never repeated in a later session.

## How feedback works

```
/feedback skill:verify-callsites good "caught a real bug"
```

or

```
sil feedback add skill:verify-callsites good --note "caught a real bug"
```

Votes, tool/agent invocation counts, nudge fires and critic-noticed
helpful/misfire signals all fold into a per-artifact scorecard
(`sil artifacts`). The curriculum planner reads scorecards and proposes `refine`
or `retire-candidate`; a human still decides.

## Config files

- `~/.config/self-improvement-loop/config.yaml`: worlds, promotion thresholds,
  worker cadence, web UI port.
- `~/.config/self-improvement-loop/llm.yaml`: model endpoints and the three model
  roles (`critic`, `drafter`, `judge`). Each endpoint carries its own model names.
  `sil llm list` shows which endpoint serves each role, `sil llm use <endpoint>`
  switches all three, and `sil llm use <endpoint> --role critic` switches one.

## Worlds

A world owns its own reflections, ledger, target repo and model policy. Sessions
map to a world by the longest `repos` prefix match on `cwd`; a world with no
`repos` is the catch-all.

```
sil worlds add work --repos ~/Development/work --target ~/dotfiles --llm cloud
```

To keep a V1 (`dotfiles-next`) target repo's on-disk contract
(`claude/skills`, `claude/hooks/nudges`, `claude/agents`, `global.CLAUDE.md`,
`claude/skills/promotions.json`), add `--layout v1`:

```
sil worlds add legacy --target ~/dotfiles --layout v1
```

A V1 `worlds.yaml` manifest imports directly:

```
sil worlds import-kb ~/.config/kb/worlds.yaml
```

## Model providers

Three endpoint kinds in `llm.yaml`: `openai` (any OpenAI-compatible endpoint,
including a local LiteLLM proxy or Ollama), `claude-cli` (shells out to
`claude -p --model <model>`, no proxy needed), and `system-one` (a typed-decision
API such as Jev or Laya; only the judge role can run on it, see
`docs/OPERATIONS.md`). A role picks its endpoint from
`role_endpoints`, else `active`, so the critic can run on `claude -p` while the
drafter and judge stay on the proxy. Every chat call
runs at temperature 0 for reproducibility. A world set to `llm: local` may only
use models in `llm.yaml`'s `local_models` allowlist; the loop refuses rather than
silently falling back to a cloud model.

## Privacy

Reflections, the ledger, scorecards and the queue all live on disk under
`~/.local/state/self-improvement-loop/` and `~/.local/share/self-improvement-loop/`.
Only the critic, drafter and judge calls leave the machine, to whatever endpoint
you configured. Curriculum never pushes to a remote on its own; accept is a
human action, and `remote: push|pr` is an explicit per-world opt-in on top of
that.

## Docs

- `docs/ARCHITECTURE.md`: design rules, runtime layout, full loop mechanics.
- `docs/INSTALL.md`: marketplace install, local dev install, scheduling.
- `docs/OPERATIONS.md`: daily loop, reviewing, key rotation, troubleshooting.
- `docs/V1-PARITY.md`: what carried over from V1 and what changed.

## License

Proprietary. All rights reserved. See `LICENSE`; contact mariusz@raqz.pl for a license.
