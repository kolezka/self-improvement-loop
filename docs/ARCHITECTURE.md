# Architecture

`self-improvement-loop` is a Claude Code plugin plus a TypeScript engine (`sil`) that runs on Bun.
It watches sessions, reflects on them in the background, promotes recurring lessons
into artifacts (skills, nudge hooks, rules, agents), measures whether those artifacts
are used, and feeds that back into the next promotion decision.

It is the successor of the loop that lived inside `dotfiles-next` (V1). Every V1
behaviour worth keeping is listed in `docs/V1-PARITY.md` with where it now lives.

## The loop in one picture

```
session ──hooks──▶ usage events + reflection queue        (fast, one bundle, never blocks)
                          │
                          ▼
             worker (background, out of session)
                          │
        ┌─────────────────┼──────────────────┐
        ▼                 ▼                  ▼
   critic            feedback            curriculum
 (one model call)  (scorecards)   (cluster, route, draft, judge, lint, stage)
        │                 │                  │
        ▼                 ▼                  ▼
  reflection store    artifact          staged branch  ──▶ web UI review ──▶ accept
  + lesson inbox     scorecards         curriculum/<world>/<pattern>        (merge, relink)
        │
        └──SessionStart / UserPromptSubmit──▶ next session gets the lesson
```

## Design rules

1. **Hooks never block and never call a model.** The in-session half is one
   bundled script (`dist/hook.js`), budgeted to well under 60 ms, and emits at most an
   `additionalContext`. No `decision: block`, no `permissionDecision: deny`.
   V1's Stop-hook question is gone; consent is a config switch, not a prompt.
2. **One critic implementation.** The worker builds a structured evidence pack from
   the transcript and the repo, makes one model call through the configured
   endpoint, and writes one reflection. There is no second in-session critic agent
   and no second `/curriculum` drafting path (V1 had two divergent pipelines).
3. **Local-first, offline core.** Reflections, ledger, scorecards and queue live on
   disk. Only the critic, drafter and judge reach a model endpoint. Outline is an
   optional export target, never a read dependency.
4. **Nothing reaches a shared remote without a human.** Curriculum stages branches in
   a scratch worktree of the target repo. Accept happens in the web UI (or CLI) and
   is bound to a `reviewed_state` digest of exactly what the human saw.
5. **Feedback is data the planner reads.** Usage, fires, helpful/misfire votes and
   human `/feedback` entries become per-artifact scorecards. The planner proposes
   `refine` and `retire-candidate`; a human decides.
6. **Worlds stay separate.** A world owns its reflections, ledger, target repo,
   model policy and nudges. World filtering happens before alias resolution.
7. **Fail loud.** No localhost fallback for the model endpoint, no placeholder API
   key, no silent default model. A missing role raises `ModelNotConfigured`.

## Runtime layout

Plugin root (`${CLAUDE_PLUGIN_ROOT}`, a versioned dir under `~/.claude/plugins/cache/kolezka/self-improvement-loop/`):

```
.claude-plugin/plugin.json
hooks/hooks.json            every event -> bun ${CLAUDE_PLUGIN_ROOT}/dist/hook.js
commands/*.md               /reflect /loop /curriculum /feedback
skills/self-improvement-loop/SKILL.md
packages/*                  TypeScript engine, one package per concern (@sil/core, @sil/store, ...)
apps/{cli,hook,server,web}  entry points: the sil CLI, the hook fast path, the web API, the Svelte UI
dist/{hook,cli,server,gate-runner}.js, dist/web/    built single-file bundles the plugin actually runs (built by the release workflow, not committed on main; see docs/RELEASE.md)
scripts/sil                 shim: resolves the plugin root, execs `bun dist/cli.js` (or source, in a dev checkout)
```

Config dir (`$SIL_CONFIG_DIR`, default `~/.config/self-improvement-loop/`):

```
config.yaml                 worlds, promotion knobs, worker cadence, ui port
llm.yaml                    endpoints + model roles (critic, drafter, judge)
```

State dir (`$SIL_STATE_DIR`, default `~/.local/state/self-improvement-loop/`):

```
queue/pending/<session_id>.json     written by the Stop/SessionEnd hook
queue/done/<session_id>.json
queue/failed/<session_id>.json
usage/events.jsonl                  skill / agent / hook usage events
usage/payloads/<world>.jsonl        PreToolUse samples (tool name, command, file path), rotated; the router's gate corpus
                                    backfill an empty one from old transcripts with `sil import payloads --days 30`
usage/nudge-fires.jsonl             nudge emissions (V1 format)
feedback/human.jsonl                /feedback entries
inbox/<world>/<lesson_id>.json      lessons waiting for delivery to sessions
sessions/<session_id>/              per-session markers (once_per, delivered, offsets)
worker.lock
logs/{hook,worker,web,curriculum}.log
```

Data dir (`$SIL_DATA_DIR`, default `~/.local/share/self-improvement-loop/`):

```
worlds/<world>/reflections/<YYYY-MM-DD>-<pattern>-<id>.md
worlds/<world>/aliases.json
worlds/<world>/learned/             default target repo (git, auto-init) when the
                                    world configures no `target`
```

## Worlds and targets

```yaml
# config.yaml
version: 1
worlds:
  - name: default
    llm: cloud                     # local | cloud policy (see llm.yaml local_models)
    repos: []                      # cwd prefixes owned by this world; [] = catch-all
    target: null                   # git repo that receives artifacts; null = learned/
    layout:                        # paths inside target
      skills_dir: skills
      nudges_dir: nudges
      agents_dir: agents
      rules_file: RULES.md
      ledger: promotions.json
    remote: none                   # none | push | pr   (accept side effects)
    rules_inject: true             # SessionStart injects the managed rules block
promotion:
  threshold: 3
  per_run_cap: 3                   # stagings per run; a gated-out pattern frees its slot
  max_rule_chars: 500              # one rule bullet, its <!--rule:...--> tag included
  auto_merge: false                # never honoured for llm: local worlds
worker:
  idle_minutes: 10                 # a session is reflected once idle this long
  curriculum_interval_minutes: 60
  min_tool_uses: 6                 # skip trivial sessions
web:
  port: 8766
  host: 127.0.0.1                  # 0.0.0.0 or a LAN/tailscale address to reach it remotely
  allowed_hosts: []                # extra Host header values, e.g. a MagicDNS name
```

A session is mapped to a world by longest `repos` prefix match on `cwd`; the
catch-all world wins otherwise. A V1 `worlds.yaml` (`kb list`) is importable with
`sil worlds import-kb <path>`; a world with `target: <dotfiles repo>` and the V1
layout (`claude/skills`, `claude/hooks/nudges`, `claude/agents`, `global.CLAUDE.md`,
`claude/skills/promotions.json`) keeps V1's on-disk contract.

## Model access

```yaml
# llm.yaml
endpoints:
  - name: litellm
    kind: openai                   # openai | claude-cli
    base_url: http://100.64.0.3:4000
    api_key_env: LITELLM_API_KEY
    models:                        # model names are per endpoint
      critic: deepseek/deepseek-flash
      drafter: deepseek/deepseek-flash
      judge: deepseek/deepseek-flash
    extra_body: {}                 # merged into each request, e.g. reasoning_effort: low
  - name: claude
    kind: claude-cli               # `claude -p --model <m>`; no proxy needed
    models:
      critic: sonnet
      drafter: sonnet
      judge: sonnet
active: litellm                    # the default endpoint for every role
role_endpoints:                    # per role override of `active`
  critic: claude
local_models: []                   # allowlist that a `llm: local` world may use
models: {}                         # fallback for a role no endpoint names
```

A role resolves in two steps: the endpoint is `role_endpoints[role]`, else `active`,
else the first endpoint; the model is that endpoint's `models[role]`, else the top
level `models[role]`. Nothing defaults past that, so a missing model is an error
naming the role and the endpoint, not a silent fallback. Model names live on the
endpoint because LiteLLM wants `deepseek/deepseek-flash` where claude-cli wants `sonnet`,
so switching provider never rewrites them.

`chat(role, messages, { world })` in `@sil/providers` is the single transport. It
resolves the role on every call, checks `local_models` for a `llm: local` world, and
posts to `<base_url>/v1/chat/completions` (LiteLLM, OpenAI, Ollama, anything
OpenAI-compatible) or shells out to `claude -p`. Because resolution is per call, the
critic can run on `claude -p` while the drafter and judge stay on LiteLLM.
Temperature 0. No fallback URL, no placeholder key.

`sil llm use <endpoint>` and `sil llm set-model <role> <model>` edit this file, as
does the `llm.use` op behind the web Models pane.

## Hook fast path (`apps/hook`, bundled to `dist/hook.js`)

One entry point for every event; imports only `@sil/core` and `@sil/nudges`; wall
budget 250 ms shared by nudge gates. Everything is wrapped so a failure is a silent exit 0.

| Event | Action |
|---|---|
| SessionStart | Inject: managed rules block of the world (if `rules_inject`), up to 3 undelivered inbox lessons for the world, one-line loop status. Kick the worker (detached) only when `sil init` has written the hook snapshot, no live worker holds the lock, the last kick is older than 15 minutes, and there is queued work or the curriculum interval elapsed. Record session start. |
| UserPromptSubmit | Deliver inbox lessons that arrived since session start (once each). Nudge dispatch. |
| PreToolUse | Record one payload sample for the world: tool name plus `tool_input.command` (credential values blanked) and `tool_input.file_path`, the two keys a gate can read; never `description`, `old_string`, `content` or a prompt. Nudge dispatch. |
| PostToolUse | Record usage for `Skill` (skill name) and `Agent` (subagent_type, model). Nudge dispatch. |
| Stop | Under a per-session lock: upsert the queue entry (session_id, transcript_path, cwd, world, git head, first/last stop ts, stop count) and scan the transcript from the stored byte offset for `attachment` hook records, appending hook usage events. No nudge dispatch: Claude Code does not deliver `additionalContext` on Stop. |
| SubagentStop | Record `agent_stop` usage event. |
| SessionEnd | Mark queue entry `ended: true`. |

Nudge dispatch is the V1 `nudge_dispatch.py` contract: sorted `*.json` from the
world's `nudges_dir` plus the plugin's built-in nudges, one winner per event,
once-per-session markers, fire log, breadcrumbs, never blocks. A nudge may only
target SessionStart, UserPromptSubmit, PreToolUse or PostToolUse, the four events
where the hook can deliver text; lint rejects the rest so a fire is always a
delivery.

## Other hosts (`@sil/openclaw`)

The engine is host neutral below the hook. Everything above reads a queue entry
and a transcript path, so a second host only has to write those two things.

OpenClaw is the first one. `@sil/transcript` detects the record shape of the
transcript file and translates OpenClaw records into the Claude Code shape, so
the worker, the critic and the evidence pack see one format. `@sil/openclaw`
finds OpenClaw sessions, writes queue entries for them, and delivers rules and
inbox lessons through a marker-fenced block in a workspace bootstrap file,
because OpenClaw has no per-session context injection hook. An OpenClaw plugin
calls the `sil` CLI on `session_start`, `gateway_start` and `session_end`;
`sil openclaw scan` covers the same ground without the plugin.

Full contract, limits and commands: `docs/OPENCLAW.md`.

## Worker (`sil worker --once | --loop`)

Under `worker.lock`:

1. **Reflect.** For each pending queue entry that is `ended` or idle for
   `idle_minutes` and has at least `min_tool_uses`: build an evidence pack
   (`evidencePack` in `@sil/transcript`), list existing pattern slugs for the world,
   list installed artifacts, call the `critic` role, parse the JSON answer, write a
   reflection if `record` is true, append artifact feedback events, drop a lesson
   in the world inbox when `lesson_short` is present. Move the entry to `done`, or
   to `failed` with a reason. A provider or configuration error keeps the entry
   queued for up to three attempts, so a proxy outage does not lose the session.
2. **Scorecards.** `scorecards(world, cfg)` in `@sil/feedback` folds usage events, nudge
   fires, critic votes and human feedback into one record per artifact.
3. **Curriculum.** If the interval elapsed: `run(world, cfg, { apply: true })` in `@sil/curriculum`, the V1
   gate stack (route, rule-writability, lint, integrity, judge) against a scratch
   worktree; stages branches, never pushes.
4. **Export.** If the world configures Outline, push new reflections (best effort).

## Reflection document

V1 body shape, plus YAML front matter for machine fields. `Pattern:` stays the
single identity line so V1 mirror documents remain readable.

```
---
id: 2026-09-14-verify-callsites-3f9a
world: default
session_id: ...
cwd: /home/me/Development/x
revision: abc123..def456
model: anthropic/claude-sonnet-5
artifacts_used: [skill:verify-callsites, agent:explorer]
artifacts_helpful: [skill:verify-callsites]
artifacts_misfired: [nudge:worktree-wrong-tree-edit]
---
Last updated: 2026-09-14

Pattern: verify-callsites

## What worked
## What failed & why
## Reusable lesson
## Verification
## Not verified
```

## Curriculum and review

Ported from V1 with the same semantics: cluster by resolved pattern, threshold and
watermarks (`promoted_at_count`, `rejected_at_count`), deterministic router with
the hook gate executed against the payload corpus, artifact lint plus grounding
lint, judge, one commit carrying artifact and ledger, scratch worktree, branch
`curriculum/<world>/<pattern>`.

Three things keep all four artifact types reachable, each added after a measured
failure:

- The drafter reads each reflection's `What failed & why`, `Reusable lesson`
  and `Verification` sections, not the lesson line alone. The critic writes
  that line as one imperative under 300 characters, which fits one rule bullet
  at the default cap; on lesson-only input the drafter proposed hook or rule on every
  one of five real clusters, and with the fuller text it took a 56-reflection
  pattern to a skill the router accepted. The judge still reads the lesson
  lines, which are the conclusions it checks an artifact against. `Not
  verified` is cut from the router's quote haystack as well, so a claim the
  critic refused to stand behind can never buy a skill or an agent.
- The payload corpus is the plugin's fixtures plus the world's recorded
  `usage/payloads/<world>.jsonl` samples (newest 2000, deduplicated). A narrow
  gate on a real command (`--no-verify`, `pkill`) can never match twenty
  synthetic fixtures; six of eight drafted hooks (eleven drafter runs on five
  live clusters) were downgraded to rules that way before the samples existed. A gate firing on more than half of the corpus
  is refused as a broadcast, and the route reason carries the hit count.
- The run report records `routed[pattern] = {drafted, type, reason}` for every
  pattern that reached the router, so a downgrade shows in `sil curriculum run`
  and the web worker status instead of looking like a rule that was asked for.

New: the planner reads scorecards and adds
`refine` (misfires outnumber helpful votes) and `retire-candidate` (no use in
`retire_after_days`) proposals. Both are surfaced, never executed automatically.

Accept: verify `reviewed_state`, re-check the branch head inside the scratch
worktree against the reviewed sha, verify the branch carries only the artifact and
ledger, fast-forward merge the exact commit accept prepared into the target's main
branch, relink skills into the world's Claude config dir, optionally `push` or
open a PR (`remote`, with the PR head re-checked before merge). Reject:
delete the branch and record the rejected watermark. Rehome and retire as in V1.

## Web UI (`sil web`)

FastAPI + uvicorn bound to `web.host` (loopback by default), token in the URL
fragment, `X-SIL-Local` header on every call, routes generated from the ops registry
(READ = GET, LOCAL and REMOTE = POST, REMOTE ops declare a gate). A bind off
loopback requires the token, and the `Host` header must be a private IP literal
(LAN, CGNAT/tailscale, IPv6 ULA) or a name in `web.allowed_hosts`, which keeps DNS
rebinding blocked. Frontend is vanilla ES modules with no
build step (a plugin install is a git clone). Panes: Overview, Queue, Reflections,
Review, Artifacts, Loop, Models, Worlds, Logs.

## Feedback loop for artifacts

| Signal | Source | Artifact types |
|---|---|---|
| invocation | PostToolUse `Skill` / `Agent` | skill, agent |
| injection | SessionStart rules block, once per session per rule | rule |
| fire | nudge fire log | hook |
| hook run | transcript `attachment` records (hookName, exitCode, durationMs) | hook |
| helpful / misfire | critic answer per session | all |
| human vote | `/feedback <type>:<name> good|bad [note]` | all |
| relevance | critic marks a rule as relevant to the session | rule |

Scorecard fields: `uses_30d`, `fires_30d`, `helpful`, `misfired`, `human_good`,
`human_bad`, `last_used`, `proposal` (`keep | refine | retire-candidate`).

`uses_30d` counts every way an artifact is served: skill and agent invocations,
rule injections, and hook fires. `fires_30d` keeps the hook-only count, so a
hook fire adds to both. Counting only skill and agent invocations left every
promoted rule and hook at 0 uses, which read as "nothing is running".

## Non-goals

No sandboxing or world isolation as an execution boundary, no task runner, no
vector search, no Outline read path. Those belong to other tools.
