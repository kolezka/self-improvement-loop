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
dist/{hook,cli,server,gate-runner,hook-module}.js, dist/web/    built single-file bundles the plugin actually runs (built by the release workflow, not committed on main; see docs/RELEASE.md)
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
usage/events.jsonl                  skill / agent / rule usage events, compacted by the worker
usage/hook-runs.jsonl               hook run diagnostics (exit code, duration), rotated
usage/payloads/<world>.jsonl        PreToolUse samples (tool name, command, file path), rotated; the router's gate corpus
                                    backfill an empty one from old transcripts with `sil import payloads --days 30`
usage/nudge-fires.jsonl             nudge emissions (V1 format)
loop-state.sqlite                   loop state DB (with -wal and -shm), mode 600; see "Loop state" below
<old file>.imported-<stamp>-<id>    an imported legacy log or document, kept byte for byte as its backup
inbox/<world>/<lesson_id>.json      lessons waiting for delivery to sessions
sessions/<session_id>/              per-session markers (once_per, delivered, offsets)
worker.lock
logs/{hook,worker,web,curriculum,state}.log
```

Data dir (`$SIL_DATA_DIR`, default `~/.local/share/self-improvement-loop/`):

```
worlds/<world>/reflections/<YYYY-MM-DD>-<pattern>-<id>.md
worlds/<world>/aliases.json.imported-<stamp>-<id>
                                    aliases moved into STATE/loop-state.sqlite in 1.3;
                                    the imported file stays here as its backup
worlds/<world>/digests/<pattern>.json   rolling summary of a cluster, plus the
                                        reflection ids it covers (a cache)
worlds/<world>/learned/             default target repo (git, auto-init) when the
                                    world configures no `target`
```

### Loop state

`STATE/loop-state.sqlite` holds four logs that used to be JSONL files in the
state dir, three documents that used to be JSON files (the queue cutoffs, the
worker status and the per-world refine attempts), and the per-world alias map.
Each log is a stream of rows in one table, `log_records`:

| Stream | Was | Written by |
| --- | --- | --- |
| `reflect_runs` | `usage/reflect-runs.jsonl` | the worker, once per critic run that finished |
| `critic` | `feedback/critic.jsonl` | the critic's verdicts on served artifacts |
| `human` | `feedback/human.jsonl` | `/feedback` and `sil feedback add` |
| `proposal_events` | `curriculum/proposal-events.jsonl` | staged, revised, accepted, rejected and the other proposal events |

The three documents live one row each in the `docs` table, keyed by name and
world. The alias maps live in the `aliases` table, one row per pair and world.
That makes four stores beside the logs:

| Store | Was | Written by |
| --- | --- | --- |
| `queue_cleared` | `queue/cleared.json` | "Clear done" and "Clear failed" (`queue.clear`, `queue.unclear`) |
| `worker_status` | `worker-status.json` | the worker, at the end of each run |
| `refine_attempts` | `curriculum/refine-attempts/<world>.json` | the curriculum, for refines that already gated out |
| `aliases` | DATA `worlds/<world>/aliases.json` | `saveAliases` (CLI, web pane, bundle import) |

The one-hop rule has one implementation, `assertOneHop` in `@sil/core`, and
every path that writes aliases runs it: `replaceAliases` for API and bundle
writes, and the legacy importer for a file it imports (a file that fails it is
quarantined whole).

The code is `@sil/statedb` (`packages/statedb`), which depends on `@sil/core`
only and keeps `bun:sqlite` out of `@sil/core` and the browser bundles.
`openState()` is the one opener and the only thing that creates the file. Every
connection runs WAL, `synchronous=FULL`, a 2 s busy timeout and foreign keys on.
`PRAGMA user_version` is the schema version (2: version 1 added the logs,
version 2 the `docs` and `aliases` tables); a newer one raises instead of being
read. Hooks do not touch the DB yet.

Before any read or write of a stream, a non-hook process checks whether the old
JSONL file is still there. If it is, it imports it in one transaction: every
nonblank line that is a JSON object becomes a row (trimmed), any other nonblank
line goes to the `quarantine` table with its raw text (up to 64 KiB), blank
lines are counted and skipped, and the file is renamed to
`<file>.imported-<stamp>-<id>`. A document or aliases file imports the same
way, whole: a document becomes one `docs` row, an aliases file one `aliases`
row per pair, and a file that does not pass becomes one quarantine entry.
Per-world files are found by listing the state and data dirs, not from config.
That renamed file is the original, byte for byte, with its size and sha256 in `legacy_imports`; nothing deletes it.
`sil state export --legacy-paths` pauses these imports until `sil state migrate`
clears the pause. Readers
come in three kinds: strict (raises on a quarantined line), counted (returns the
quarantine count, as `history.series` and `readProposalEvents` do) and tolerant
(reads what the DB has, logs once to `logs/state.log`). `sil state status`
shows the streams, a `documents:` block for the three documents and each
aliases world, and every import. `sil state` shows and manages all of this;
OPERATIONS.md has the commands and the way back to an older plugin.

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
    kind: openai                   # openai | claude-cli | system-one
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
    effort: low                    # optional; passed as `--effort <level>`, unset means the CLI's own default
  - name: jev
    kind: system-one                # POST /v1/systemone; typed decisions, so only judge can run here
    base_url: https://api.typesafe.ai
    api_key_env: TYPESAFE_API_KEY
    models:
      judge: jev-latest
    decision_threshold: 0.5         # reject when any judge rule's probability is at or above this
  - name: laya
    kind: system-one                # local server (arbiter, lajev, laya-rs); usually no key
    base_url: http://127.0.0.1:8010
    models:
      judge: laya-typed-decisions
    decision_threshold: 0.5
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

With `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, Claude Code loads a hooks module
(`dist/hook-module.js`, registered via `hooks.json`'s top-level `modules` key)
that owns SessionStart, UserPromptSubmit, PreToolUse and PostToolUse in
process; the four command-hook entries for those events are guarded with
`[ "$SIL_HOOK_MODULE" = "$PPID" ] || sh scripts/hook` and skip once the module
sets `SIL_HOOK_MODULE` to the pid of its own claude process. The comparison is
with the hook shell's parent pid, so a nested `claude` started from a Bash tool
call inherits the variable, does not match, and keeps its four command hooks;
when the module cannot read the pid it leaves the variable unset and every
command hook runs. Stop, SubagentStop and SessionEnd stay command-only: the
module's sandbox has no Node and can only overwrite a whole file, so it cannot
append to the state dir's JSONL logs. Instead it buffers appends and moves for
a session into `sessions/<session_id>/module-spool.json`; the Stop and
SessionEnd command hooks apply and delete that spool under the same session
lock they already hold, before either checks for a missing transcript. The
module caches the snapshot, resolved world and loaded nudge list per session,
so a config edit, `sil init`, or a newly promoted nudge is seen by the next
session, not the current one; the command hook path re-reads all three on
every event. A session that never gets a Stop or SessionEnd (crash, kill, or
a last Stop with `stop_hook_active`) has its spool swept and applied at the
next Stop or SessionEnd of any session, once it is 30 minutes old.

| Event | Action |
|---|---|
| SessionStart | Inject: managed rules block of the world (if `rules_inject`), up to 3 undelivered inbox lessons for the world, one-line loop status. Kick the worker (detached) only when `sil init` has written the hook snapshot, no live worker holds the lock, the last kick is older than 15 minutes, and there is queued work or the curriculum interval elapsed. Record session start. |
| UserPromptSubmit | Deliver inbox lessons that arrived since session start (once each). Nudge dispatch. |
| PreToolUse | Record one payload sample for the world: tool name plus `tool_input.command` (credential values blanked) and `tool_input.file_path`, the two keys a gate can read; never `description`, `old_string`, `content` or a prompt. Nudge dispatch. |
| PostToolUse | Record usage for `Skill` (skill name) and `Agent` (subagent_type, model). Nudge dispatch. |
| Stop | Under a per-session lock: upsert the queue entry (session_id, transcript_path, cwd, world, git head, first/last stop ts, stop count) and scan the transcript from the stored byte offset for `attachment` hook records, appending hook run diagnostics to `usage/hook-runs.jsonl`. No nudge dispatch: Claude Code does not deliver `additionalContext` on Stop. |
| SubagentStop | Record `agent_stop` usage event. |
| SessionEnd | Mark queue entry `ended: true`. |

Nudge dispatch is the V1 `nudge_dispatch.py` contract: sorted `*.json` from the
world's `nudges_dir` plus the plugin's built-in `nudges/` (empty by design: a
built-in fires for every user in every world), one winner per event,
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
   An entry that stays below `min_tool_uses` after the session is over (`ended`,
   or the transcript untouched for 7 days) retires to `done` as
   `skipped: below min_tool_uses`, so the pending queue drains instead of
   re-parsing the same transcripts on every run.
2. **Scorecards.** `scorecards(world, cfg)` in `@sil/feedback` folds usage events, nudge
   fires, critic votes and human feedback into one record per artifact. The same
   step compacts `usage/events.jsonl`: hook_run diagnostics and events past the
   retire clock go, the newest event per artifact stays whatever its age.
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

- The drafter reads each reflection's `What worked`, `What failed & why`,
  `Reusable lesson` and `Verification` sections, not the lesson line alone. The critic writes
  that line as one imperative under 300 characters, which fits one rule bullet
  at the default cap; on lesson-only input the drafter proposed hook or rule on every
  one of five real clusters, and with the fuller text it took a 56-reflection
  pattern to a skill the router accepted. `What worked` was cut too until
  October 2026, while the router kept accepting quotes from it: that section is
  where a reflection names the commands of a procedure, so the one quote a
  skill needs was the one text the drafter never saw. The judge still reads the
  lesson lines, which are the conclusions it checks an artifact against, plus
  the quote the router verified when it routed to `skill` or `agent`, so an
  artifact built on that quote is not refused as unsupported. `Not verified`
  is cut from the drafter's input and from the router's quote haystack, so a
  claim the critic refused to stand behind can never buy a skill or an agent.
- The payload corpus is the plugin's fixtures plus the world's recorded
  `usage/payloads/<world>.jsonl` samples (newest 2000, deduplicated). A narrow
  gate on a real command (`--no-verify`, `pkill`) can never match twenty
  synthetic fixtures; six of eight drafted hooks (eleven drafter runs on five
  live clusters) were downgraded to rules that way before the samples existed. A gate firing on more than half of the corpus
  is refused as a broadcast, and the route reason carries the hit count.
- The run report records `routed[pattern] = {drafted, type, reason}` for every
  pattern that reached the router, so a downgrade shows in `sil curriculum run`
  and the web worker status instead of looking like a rule that was asked for.
  When the type was routed from a drafter answer (a fresh pattern, or a
  re-route probe) it also carries `signals`: the trigger event, whether a gate
  came with it, `needs_own_context`, both evidence quotes (cut to 200
  characters), `no_artifact`, `parse_error` and `missing_keys` (requested keys
  the reply left out; a fresh pattern still routes on the defaults). Without them nobody could tell
  from a log whether a rule came from a "no" or from a reply nobody read.

New: the planner reads scorecards and adds
`refine` (misfires outnumber helpful votes) and `retire-candidate` (no use in
`retire_after_days`) proposals. Both are surfaced, never executed automatically.

### Redraft policy: observing and escalate

Nothing judged whether a redraft actually worked: new evidence past the
watermark redrafted an already-promoted pattern every time, wording churn with
no read on whether the recurrence rate moved. Two fixes close that loop.

**The accept bug.** `acceptInner` decided "is this pattern already promoted"
from the branch's own ledger row (`entry`), which reads `staged` for every
ordinary redraft (only an auto-merge branch ever writes `promoted` there). So
every redraft's accept read as a first promotion and reset `promoted_at`,
which also reset `recurrence_30d`'s window and kept a high-volume pattern
inside the 7 day "new" grace period forever. The fix reads promotion status
from the live ledger (`liveRow`, loaded at the branch's base sha) instead.
`revised_at` and `revisions` are new fields alongside the fix: `promoted_at`
stays the first promotion, `revised_at` moves on every accepted redraft, and
`revisions` counts them. `sil curriculum repair-promoted-at` recomputes all
three from the ledger file's own git history for rows the bug already
corrupted (dry run by default, `--apply` writes and commits, never pushes).

The repair's version identity is the pattern's own artifact content read from
git at each promoted snapshot (a rule's own tagged bullet only), never the
ledger `commit` field or a row's own `promoted_at`: auto-merge always writes
`commit: null`, and a pre-fix redraft resets `promoted_at` on every accept, so
neither survives as a stable version key. A new version is a readable,
byte-exact content that differs from the one before it in the current span
(since the last retirement, if any), so a revert to an earlier text still
counts, and an unreadable artifact counts toward the span start only. The walk
follows the default branch's own line from its tip: an accept of a stale
branch merges the default branch into it and commits the merge with the exact
accept subject (`feat(<type>): [retire ]<pattern> (reviewed)`) and the old
default tip as second parent, so the line continues through that parent; any
other merge keeps it on the first parent, so a side branch's stale ledger is
never read. `--first-parent` alone lost the redrafts behind such an accept, a plain
log read stale side snapshots. Reads are cached per blob id, so a repair costs
one `ls-tree` per commit on that line plus one read per distinct blob. With a
single visible version (a shallow or imported history) a post-fix row keeps its
own `revised_at` and `revisions`. A retired row keeps its status but still gets
its three fields repaired from the span that closed at the retirement.

Auto-merge already landing a branch (it fast-forwards the default branch onto
the branch tip but leaves the branch ref in place) is not itself an accept:
`review.detail` and `review.accept` both refuse a pattern whose branch head is
already an ancestor of the default branch, so a direct accept cannot add a
ledger-only commit and bump `revisions` with no new draft behind it.

**Recurrence rate.** Each scorecard carries three `RateWindow`s
(`{sessions, hits, rate}`): `rate_baseline` (before `promoted_at`),
`rate_since_promotion` (from `promoted_at` to now) and `rate_since_revision`
(from `revised_at`, or `promoted_at` when never revised, to now). `sessions`
is every reflected session of the world in the window, `hits` the ones whose
(alias-resolved) reflection is this pattern; `rate` is `null` below
`promotion.observe_min_sessions` (default 20), since a ratio over a handful of
sessions is noise, not a signal. Reflected sessions come from two sources: a
reflection's own `session_id` when it has one, and the `reflect_runs` stream
in loop state (formerly `usage/reflect-runs.jsonl`), one row per critic run
that finished, recorded or not, written by the worker
right after `reflectSession` returns. The second source exists because the
queue's `done` bucket is pruned to 500 entries and cannot serve as history; a
world with any real volume loses the sessions that were reflected but did not
record a lesson within days.

The planner spends a redraft's evidence on itself before drafting: for an
already-promoted pattern with new evidence past the watermark,
`redraftPolicy` runs before `promote`/`refine`.
- **`observing`**: `rate_since_revision.sessions` is below
  `observe_min_sessions`. The live text has not been seen by enough sessions
  to trust a rate yet, so the planner waits instead of drafting on noise. A
  concurrent scorecard `refine` complaint is not dropped: the reason is
  appended and `feedback` stays set, the same as the `promote` path. A
  low-traffic pattern that stays under `observe_min_sessions` for more than
  `promotion.observe_max_days` (default 14) since its live text last changed
  stops reporting `observing` and falls through to a normal redraft instead of
  waiting on a window that will never fill. A row with no date at all (a V1
  row never repaired) has no age to wait out and redrafts as before.
- **`escalate`**: the row has used its redraft budget (`revisions >=
  max_rewords`, default 2), the post-revision rate has not meaningfully
  dropped (`rate_since_revision >= escalate_ratio * rate_since_promotion`,
  default ratio 0.9), and both windows have at least one hit with
  `rate_since_promotion` positive. Without those guards, zero recurrence on
  both sides (`0 >= escalate_ratio * 0`), or zero since the revision with
  `escalate_ratio` 0, escalated a pattern that had stopped recurring. Wording is not fixing a real
  escalation; a human needs to change the artifact's type or split the
  pattern.

Both are proposals, exactly like `retire-candidate`: `run()` never executes
them (no draft, no cap spent), and the run report does not count them as
failures. `sil curriculum plan` and the web Loop pane show them alongside the
other plan actions.

### What the drafter sees (`context.ts`)

A drafting prompt carries more than one cluster's raw lessons, because both
failures that produces were measured in the default world:

* **The rolling summary.** `evidence-level-overclaim` reached 66 reflections
  against one 300 character rule. Re-quoting every lesson on every run made each
  run a fresh generation, so the rule churned wording without covering more
  evidence. A cluster of `SUMMARY_MIN_LESSONS` (8) or more gets a standing
  summary, written by one extra `drafter` call and cached under
  `worlds/<world>/digests/<pattern>.json` keyed by the reflection ids it covers.
  It is updated incrementally (previous summary plus only the new lessons) and
  reused untouched while nothing is new, so the drafting input barely moves
  between runs. The prompt then quotes the `RECENT_LESSONS` (12) newest lessons
  in full and tells the drafter the rest reach it through the summary.
* **Earlier evidence.** The summary is built from lesson lines and paraphrases,
  and the router only accepts a verbatim quote, so evidence in an older
  reflection could never buy a skill: 92% of reflections sat in clusters over
  12. The prompt therefore also quotes, verbatim and labelled as quotable, the
  `What worked` section of older reflections that names at least two inline
  commands, newest first, up to `EARLIER_EVIDENCE_CHARS` (4000). The selection
  depends only on the reflections, so the block moves only when new ones
  arrive, like the summary. A section too long for what is left of the budget
  is skipped, not a stop. Artifact feedback and scorecard complaints are quoted
  after the lessons and never count toward the window. `Not verified` text never enters it.
* **The knowledge map.** Every other pattern in the world, its reflection count
  and the artifact serving it, one line each, with the instruction not to
  restate a neighbour under a new name. Without it a drafter cannot know the
  world already promoted a near-identical rule under a different pattern.

None of these is a gate: lint's grounding check and the router's quote check
keep reading the full source text of every reflection in the cluster, and the
judge keeps reading every lesson line. A summariser call that fails
falls back to the cached summary, then to the raw lessons, and never blocks a
promotion. A redraft that reproduces the artifact already in place is reported
as `no change` and stages nothing, so an unchanged line never reaches review.

Accept: verify `reviewed_state`, re-check the branch head inside the scratch
worktree against the reviewed sha, verify the branch carries only the artifact and
ledger, fast-forward merge the exact commit accept prepared into the target's main
branch, relink skills into the world's Claude config dir, optionally `push` or
open a PR (`remote`, with the PR head re-checked before merge). Reject:
delete the branch and record the rejected watermark. Rehome and retire as in V1.

Rehome and retire stage a branch and change nothing live. Accepting a retirement
records `retired`, not `promoted`: the branch deleted the artifact, so the row it
merges must say the pattern is out of rotation, or the inventory keeps listing it
as serving and the next plan can refine it back into existence.

Three more things hold along that path, each of which kept a retired artifact
alive on its own:

- A tick skips any pattern whose branch row says `retired`. Otherwise the branch
  reset that keeps a redraft at one commit throws the staged deletion away, and
  the accept that follows records a promotion of the artifact just removed.
- Retiring stamps the rejected watermark, so the reflections already on disk are
  not read as new evidence on the next tick.
- Accept reaps the link of every linkable type, not only the accepted one, and
  reads liveness from the artifact file rather than its directory. A re-home off
  `skill` links nowhere, and a retired skill can leave a non-empty directory
  behind; both used to keep `~/.claude/skills/<pattern>` in place.

A re-home writes a stub, not an artifact, and it does not move the watermark. The
plan therefore treats a `staged` row whose branch still holds only that stub as
`promote`, whatever the reflection count says. Read as `done`, the stub sat on the
branch until the pattern earned `threshold` new reflections, and the artifact it
replaces kept serving all that time.

### Re-routing an already served pattern

Once a pattern reaches `rule`, `skill`, `hook` or `agent`, `stageOne` forces
every later redraft into that same type (`servedBy`, then `forcedType`): the
drafter never reports routing fields in forced mode, so `route()` is never
consulted again. Measured over 30 days of live logs (2026-09-14 to
2026-10-14): only 29 fresh router decisions against 400+ redrafts carrying
`already served by this artifact`. A pattern that became a rule early stayed a
rule no matter what new evidence later showed, and only a human `rehome`
could move it.

`run()` now reconsiders the type on a `promote` action (new reflections past
the watermark; never a `refine`, never a ledger-only redraft, since there is
no fresh evidence to route from there), and only when the pattern is
currently served by `rule`. A pattern already served by a `hook`, `skill` or
`agent` never asks the drafter for routing fields at all: only a human
`rehome` moves it, and the pattern pays no extra provider cost for a probe
that could never fire. The forced drafting call for a served `rule` asks for
the routing fields alongside the body (`DraftOptions.wantRouteAnswer`,
`ParseDraftOptions.keepRouteAnswer`): the instructions for the body itself are
unchanged either way, so what the drafter writes in the served type does not
move, and the forced path pays for one extra set of keys in the same call
rather than a second model call. `route()` then runs on those fields exactly
as it does for a fresh pattern. A result of `rule` or `none` is the router's
own fallback, not evidence of anything, and never displaces an artifact a
prior tick already earned: only `hook`, `skill` or `agent`, and only when it
differs from the current type, counts as an upgrade. When the probe runs and
earns no upgrade, the routed reason carries its verdict
(`already served by this artifact; re-route probe kept rule: <reason>`), so a
probe that said no is told apart from one that never ran. A probe reply whose
routing fields fail validation, or that leaves a requested key out, carries
`parse_error` naming the fields, and the
reason reads `re-route probe kept rule: unreadable drafter reply: ...`. It used
to fall back to the empty answer, which printed the same "no workable gate"
line as a drafter that considered the evidence and said no.

An upgrade redrafts once more in the new type (the same single-redraft path a
drafter/router mismatch already uses on a fresh pattern), lints, judges, and
stages on the pattern's branch exactly like an ordinary redraft: the old type's
artifact is removed, the new one written, `served_by` and `artifact_type` flip
to the new type, and the commit message says so (`feat(hook): re-route
<pattern> from rule (auto, gated)`). The "no change" skip that drops a redraft
reproducing the artifact already in place never applies to a re-route: a type
change is the change, even when the new type's text happens to read the same
as the old one's. A re-route is also always staged for review, never
auto-merged, whatever `promotion.auto_merge` says: it is a type change nobody
has looked at yet, which is exactly what auto-merge exists to skip for
everything else. Nothing changes live until a human accepts it in review,
exactly like a re-home today; accept already read the branch's own
`served_by` and reaped every linkable type's link, so it merges a
worker-staged type change with no code change of its own.

A re-route never overrides a human's own choice of type, checked in order of
durability:

1. `type_set_by: "human"` on the branch's ledger row or the live one. Set by
   `rehomeInner` when a human re-homes a pattern, and carried forward by every
   later write of that row (`stageOne`'s own redraft, `accept`, `reject`,
   `repair`), so it survives even if the `rehomed` proposal event below never
   makes it to disk. It is `.optional()` on `PromotionEntry`, never
   `.default()`, so it is written only where it is set and does not rewrite
   every other row on the next save.
2. The branch's type disagreeing with the live one (`migrating`: a re-home,
   or an earlier re-route, still waiting for review).
3. This pattern ever recording a `rehomed` proposal event. Best effort: that
   append runs after the re-home's commit already landed and swallows its own
   write failure (a full disk, a read-only mount) rather than undoing a commit
   that already happened, so it can miss an event the commit itself carried
   out. `type_set_by` on the ledger row is the durable fallback for exactly
   that failure.

An ordinary open restage of the same type does not block it: the worker
restages that branch on every tick, and on live state every pattern with new
evidence had one. A reviewing human is protected by `reviewed_state`, as for
any restage. `rehomed` stays a human-only event on purpose: an automatic
re-route records its own `rerouted` event instead, so it neither misreports
itself as a human decision nor permanently blocks its own pattern from a later
upgrade. `rerouted` is also its own series in `history.series` (`proposals_rerouted`),
counted separately from, but still included in, `proposals_staged`.

### Inline artifacts (`/learn`)

`/learn` lets the session agent turn a correction into a rule, skill, agent or
nudge at once, without waiting for three reflections. The agent drafts it, the
operator approves the diff, and `sil artifacts register` records it in the
world's ledger as an inline row. The loop sees inline rows for votes, scorecards
and dedupe, but never redrafts, retires or re-homes them: a human edits the file.

Three optional fields on a ledger row (`PromotionEntry` in `@sil/core`):

| Field | Meaning |
|---|---|
| `origin` | `"loop"` or `"inline"`. Absent means loop, so every older row stays loop. |
| `external_path` | Absolute path of an inline rule, skill or agent outside the target repo. Never stored in `served_by.path`, which `repair.ts` reads as a repo-relative blob path. |
| `note` | The one-line lesson. Used as the row's gist in the knowledge map. |

They are `.optional()`, not `.default()`. A default would be written into every
row on the next save and rewrite the whole ledger file.

Write path: `register()` in `@sil/review` is the single write point. It takes
the worker lock and writes one local commit on the target repo's default branch
through `commitOnDefault`. It never pushes. A nudge (`--type hook`) is read from a
scratch JSON file, linted, and copied into `nudges_dir` in the same commit as its
ledger row, so its `served_by.path` is the repo path and it has no
`external_path`. A dry run runs every check and returns the row without writing,
with one intended difference: for a rule, skill or agent the file need not exist
yet, because the preview comes before the artifact is written.

Path rules, checked before any write:

- the type is one of `INLINE_TYPES` (`rule`, `skill`, `agent`, `hook`), also for
  callers that are not TypeScript;
- `--path` is absolute, and a regular file when it exists. A real run needs it to
  exist; a dry run of a rule, skill or agent may name a file not written yet;
- the path is resolved through symlinks. A path not written yet resolves its
  deepest existing ancestor, so the dry-run row equals the committed row. A
  dangling symlink on the way is refused;
- a rule, skill or agent path that resolves inside the target repo is refused:
  that tree belongs to the loop.

Ownership refusals: a promoted loop row for the pattern, an existing
`curriculum/<world>/<pattern>` branch, or an inline row already registered at
a different path. A rejected or retired loop row may be replaced and keeps its
`rejected_at_count`. Re-running with the same path bumps `revisions` and
`revised_at` and keeps `promoted_at`.

Guards in the rest of the loop:

- `plan.ts`: every promoted inline row plans as `done`, with or without new
  reflections or a scorecard. A `refine` or `retire-candidate` proposal is shown
  in the reason, never executed.
- `run.ts`: refuses to stage a pattern whose live row is inline, right after the
  prior row is read. This is a second lock in case a plan bug lets one through.
- `review accept`: refuses when the row at the reviewed base is inline, so an
  older staged branch cannot overwrite it. The message names `sil review reject`.
- `review retire` and `rehome`: refuse an inline row, checked on the live row and
  on the branch row, and print its path.
- `repair.ts`: skips inline rows. Their dates come from `register`.
- `review delete`: takes an inline row, writes a `deleted` tombstone and leaves an
  external file in place. `register` treats that tombstone as a free slug.
- `feedback` `propose()`: no zero-use `retire-candidate` for an inline rule,
  whose uses are never counted. Complaints can still propose `refine`.
- `context.ts`: an inline row's gist is its `note`.
- `inventory()`: `served_by` shows `external_path` when set, and rows carry
  `origin`. `sil artifacts` prints `origin=inline`.

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

An inline rule lives in a `CLAUDE.md` that Claude Code loads itself, outside the
rules block the loop injects, so its uses are not counted. Inline skills, agents
and nudges are counted like loop ones, which is why their names must equal the
pattern slug.

Scorecard fields: `uses_30d`, `fires_30d`, `helpful`, `misfired`, `human_good`,
`human_bad`, `recurrence_30d`, `last_used`, `proposal` (`keep | refine | retire-candidate`),
`rate_baseline`, `rate_since_promotion`, `rate_since_revision` (see "Redraft
policy: observing and escalate" above; `recurrence_30d` is a rolling 30 day
count, the rate windows describe the artifact's whole life since promotion).

`recurrence_30d` counts this pattern's reflections (alias-resolved) created after
`promoted_at` inside the window, or the whole window when `promoted_at` is null.
A used artifact whose failure keeps being reflected proposes `refine` once the
count grows past the ledger snapshot by `max(threshold, half the snapshot)`, and
not within 7 days of the snapshot's `snapshot_at`, which stage and reject stamp.

`uses_30d` counts every way an artifact is served: skill and agent invocations,
rule injections, and hook fires. `fires_30d` keeps the hook-only count, so a
hook fire adds to both. Counting only skill and agent invocations left every
promoted rule and hook at 0 uses, which read as "nothing is running".

## Non-goals

No sandboxing or world isolation as an execution boundary, no task runner, no
vector search, no Outline read path. Those belong to other tools.
