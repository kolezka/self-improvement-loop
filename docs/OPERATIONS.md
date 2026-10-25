# Operations

## The daily loop

1. Sessions run normally. Hooks record queue entries and usage events, in the
   background, without ever calling a model.
2. The worker (on its schedule, or kicked by a hook when there is queued work)
   reflects on ended or idle sessions and writes reflection documents.
3. Every hour (default `worker.curriculum_interval_minutes`) the worker runs
   curriculum: it clusters reflections by pattern, routes and drafts artifacts for
   patterns past threshold, and stages a branch. Nothing merges by itself.
4. You review staged branches (`sil review list`, `sil review show <pattern>`, or
   the web UI) and accept, reject, rehome or retire each one.
5. You rate artifacts as they turn out to help or misfire (`/feedback` or
   `sil feedback add`). The next curriculum pass reads that back in.

## Reviewing, rejecting, rehoming, retiring, rating

```
sil review list --world default
sil review show verify-callsites --world default --diff
sil review accept verify-callsites --world default --reviewed-state <hash from show>
sil review reject some-pattern --world default
sil review rehome some-pattern --type rule --world default
sil review retire old-pattern --world default --yes
sil review delete old-pattern --world default --yes
sil feedback add skill:verify-callsites good --note "caught a real bug"
```

`rehome` and `retire` only stage a branch. The artifact keeps serving until you
accept that branch, so a retirement is two steps: `sil review retire <pattern>
--yes`, then `sil review accept <pattern> --reviewed-state <hash>`.

While a retirement waits on its branch, the worker leaves that pattern alone and
reports it as gated out. Accepting the retirement deletes the artifact, reaps its
symlink in `~/.claude`, records the row as `retired` and stamps a watermark, so
the pattern needs `promotion.threshold` new reflections before it is proposed
again. `sil review rehome <pattern> --type none --yes` is a retirement as well:
nothing serves the pattern after it, so it asks for `--yes` exactly like
`retire` (the `router.rehome` op wants `confirm: true` for the same reason).

`sil review delete <pattern> --world <w> --yes` (op `router.delete`, which wants
`confirm: true`) takes a pattern out of every listing. It works on a retired or
rejected row, an inline row, and a staged proposal that was never accepted,
whose branch it deletes. It commits straight to the default branch, like
`reject`, and pushes nothing. It refuses a live loop artifact: retire that and
accept the retirement first. The row stays in the ledger as a `deleted`
tombstone with the watermark raised to the current reflection count, so the
loop does not stage the pattern again until `promotion.threshold` new
reflections arrive. `retire`, `rehome` and Verify refuse a tombstone.

`accept` always needs `--reviewed-state`: paste the hash `sil review show` prints.
This binds the accept to exactly what you looked at; if the branch changed
underneath you, accept fails and asks you to reload.

### Escalated patterns, and Refine

A promoted artifact that has used up its redraft budget and is still
recurring almost as often as before shows up as escalated: `sil curriculum
plan` reports it with `action: escalate`, and the Review pane's Escalated
section lists it with its reason and how many reflections back it. Neither
place drafts anything by itself; a human decides to change the artifact's
type (rehome), split the pattern, or try one more redraft.

"Create proposal" on an escalated row, and the Artifacts pane's **Refine**
button on any live, non-inline row, both call the same `artifacts.refine` op
with an optional instruction. It drafts through the same lint, judge and hook
gates a promotion uses, always stages for review (never auto-merges, even
with `promotion.auto_merge: true`), and opens the Review detail view on the
result. If a proposal is already staged for that pattern (an ordinary
refine, a staged rehome, or a staged retirement), it opens that proposal
instead of redrafting or overwriting it.

### Artifacts pane: Preview, Verify, Refine, Retire, Delete

The web console's Artifacts pane lists every ledger row with up to five row
actions. Rows deleted with `sil review delete` are not listed.

- **Preview** (every row) opens a read-only drawer with the artifact's body
  exactly as it is on the target repo's checked-out working tree, never a
  staged review branch. That tree is normally the default branch, but it can
  carry local uncommitted edits; the drawer warns when the body does not
  match what is committed on the default branch (`matches_default_branch`).
  It also shows whether the artifact is actually active (a skill or agent's
  symlink into `~/.claude`, a hook's file, or a rule's bullet inside the
  managed block, with `rules_inject` and the size cap honoured, and an inline
  file checked against where Claude Code actually loads that type from). A
  retired or missing artifact reports a clear error instead of an empty body.
- **Verify** (live rows only) runs the offline checks (exists, live, lint,
  and for a hook, its own gate against the real payload corpus) plus one
  drafter call that asks whether today's evidence would route the pattern to
  a different type. It writes nothing: no ledger change, no branch, no
  proposal event, no scorecard. An inline row (edited by hand) skips the
  model call with an explicit reason; so does a pattern with no reflections
  on disk. When the router would pick a real upgrade (hook, skill or agent,
  different from the current type), the drawer offers "Rehome to `<type>`",
  which calls `router.rehome` after a confirmation and stages the move for
  review like any other rehome.
- **Refine** (live, non-inline rows) opens a drawer for an optional
  instruction, then calls `artifacts.refine` (see "Escalated patterns, and
  Refine" above) and opens the result in Review.
- **Retire** now shows only on a live, non-inline row. It used to show on
  every row and failed with `"<pattern>" is already retired` when clicked on
  one already retired.
- **Delete** shows on every row Retire does not: retired, rejected and inline
  rows. It calls `router.delete` after a confirmation. An inline file outside
  the target repo is left in place and the toast names it.

The Review pane has **Discard** next to Reject. It calls `router.delete` on the
selected proposal and is disabled when the pattern is live on the default
branch (`detail.live`), where Reject is the way to drop the branch.

## The native console (`/sil`)

`/sil` opens the loop console in a pane beside the chat. It reads only: accept,
reject, rehome, retire, rate and settings changes stay with the CLI and
`sil web`. It needs the hooks module (`docs/INSTALL.md`, "Native console").
Without it, use `sil status`, `sil review list --world <world>`,
`sil review show <pattern>` and `sil web`.

The pane has five sections: Overview, Review, Artifacts, Activity and Settings,
for one world at a time. A row of buttons picks the section, another the world
(the current one is marked), and Refresh and Close sit at the bottom. The world
the pane opens on is the one that owns the session's working directory. Below 44
columns the pane stacks its controls, and where the surface has a selector the
section and world rows become two selectors. The console defines no key
bindings of its own: moving between controls and pressing them is the host
pane's keyboard behaviour. That behaviour has not been checked in an attended
terminal yet.

Review shows one staged proposal's body and diff a page at a time, up to 200
lines and 64 KiB per page. Every page is tied to the proposal's
`reviewed_state` digest. If the branch changes while you read, the next page
says the proposal changed instead of mixing two revisions; read it again from
the start. A line too long for one page is reported, not cut short. A clipped
or partial view is never a complete review: accept through
`sil review accept`, which checks the digest of what you saw.

A failed read shows as an error in the pane, never as an empty result. Values
kept from an earlier read are marked as possibly stale. Loop state that exists
but cannot be read (an unreadable file, a broken directory, malformed content,
a failed git call) fails the read with a short reason; only state that is not
there yet reads as empty. `sil review list` and `sil review show` follow the
same rule. `sil status`, `sil lessons` and `sil reflections` are summaries that
still skip what they cannot read, so a zero there is not proof of an empty
queue or inbox. `sil logs worker` shows the worker side.

## Capturing a lesson now (`/learn`)

`/learn [note]` turns a mistake caught in the current session into a rule, skill,
agent or nudge, without waiting for three reflections. In Codex, ask the agent to
capture a lesson; it follows the same procedure from the installed skill. The
agent works through these steps and stops for your yes at each confirmation:

1. States the failure and the check that would have caught it. You confirm.
2. Proposes the world. You confirm. Every later `sil` call passes `--world`.
3. Looks for an existing artifact or pending cluster that covers it
   (`sil artifacts --world <w> --json`, `sil curriculum plan --world <w>`, `rg`
   over the usual places).
4. Picks a type (rule, skill, agent, or nudge, registered as `--type hook`).
5. Picks a scope: the project, or `~/.claude/`. A rule, skill or agent cannot
   live inside the world's target repo. A nudge always goes to `nudges_dir`.
6. Runs `sil artifacts register ... --dry-run` and shows you the artifact diff
   and the ledger row. For a rule, skill or agent, `--path` is the final location
   in the project's main checkout or under `~/.claude/`, never a temporary
   worktree path; the file need not exist yet. For a nudge, `--path` is the
   draft JSON in a fresh `mktemp -d` directory. That draft is the only thing
   written before your yes. You approve both the artifact diff and the ledger
   row before step 7; a yes given before they were shown does not count.
7. Writes the file. In a git repo it goes on a branch, never on the default
   branch. Under `~/.claude/`, or in a project directory without git, it is
   edited in place.
8. Registers it. A file edited in place, or a nudge, is registered at once. A
   project file on a branch is registered only after you say the branch is
   merged and one of these exits 0 (the second covers squash and rebase):

   ```sh
   git -C <repo> merge-base --is-ancestor <branch> <default-branch>
   git -C <repo> diff --quiet <branch> <default-branch> -- <repo-relative path>
   ```

   `<repo-relative path>` is `--path` with `<repo>/` removed, derived rather than
   typed by hand.

   The agent never merges or pushes. Until register succeeds it reports the
   pending command and does not claim the lesson is recorded.

The nudge scratch directory is removed after register succeeds or you say no.
If register refuses, it is kept so the retry reads the same approved bytes.

## Saving a working answer as a skill (`/toolify`)

`/toolify [note]` turns the last answer that worked in the current session (a
Redash query, a set of API calls, a command sequence) into a skill, so a later
session repeats it without finding it again. In Codex, ask the agent to save
the answer as a tool. The agent:

1. Extracts the request, the exact query or commands that ran, the fixed
   values, the parameters and the expected result. Only facts confirmed by tool
   output count. You confirm the summary.
2. Proposes the world and checks for an existing skill, as `/learn` does.
3. Proposes a scope (project `.claude/skills/` or `~/.claude/skills/`) and a
   slug, which is also the skill's `name`.
4. Drafts SKILL.md (trigger, parameters, steps, expected result, what to check
   when it stops working). Secrets become environment variable names.
5. Runs `sil artifacts register --type skill ... --dry-run` and shows you the
   file and the ledger row. Nothing is written before your yes.
6. Writes and registers it under the same rules as `/learn` steps 7 and 8.

A stale tool is voted down with `/feedback skill:<slug> bad`.

### `sil artifacts register`

```text
sil artifacts register --world <w> --type <rule|skill|agent|hook>
  --pattern <slug> --path <absolute path> --note "<one-line lesson>" [--dry-run] [--json]
```

It writes one local commit on the target repo's default branch, with the ledger
row and, for a nudge, the copied JSON. It never pushes. Exit codes: 0 on
success, 1 when register refuses, 2 on bad arguments. An unknown action, or a
register flag (`--type`, `--pattern`, `--path`, `--note`, `--dry-run`) given to
the bare listing or to `rebuild`, also exits 2, so a forgotten `register` does
not look like success.

Refusals and what to do:

| Message | What to do |
|---|---|
| `unknown --type`, `--type must be one of ...` | Use `rule`, `skill`, `agent` or `hook`. |
| `needs --pattern, --path and --note` | Pass all three (exit 2). |
| `unsafe pattern slug` | Use lowercase letters and digits joined by single dashes, at most 64 characters. |
| `--note is required` | Pass a one-line lesson. |
| `--path must be absolute` | Pass the absolute final path. |
| `<path> does not exist` | Write the file first. Only a dry run of a rule, skill or agent accepts a file not written yet. |
| `<path> is not a file` | Point at the file, not its directory. |
| `goes through a dangling symlink at <link>` | Fix or remove the link, then retry. |
| `is inside the target repo` | That tree belongs to the loop. Pick a path outside it, or let the loop handle it with `/reflect`. |
| `is not a git repository` | The world's target is not a repo. Fix the world's `target`. |
| `is on <branch>, not <default>` | Check the default branch out in the target repo and retry. |
| `has uncommitted or untracked files under ...` | Commit or discard them in the target repo and retry. |
| `curriculum/<world>/<pattern> exists` | Answer it first with `sil review accept` or `sil review reject`. |
| `is owned by the loop` | The loop already serves this pattern. Vote on it with `/feedback`, or pick a new slug. Re-homing keeps it a loop row, so it does not help. |
| `is already registered at <path>` | One pattern, one inline file. Register the same path again to extend it, or pick a new slug. |
| `not JSON`, `pattern field`, `refused by lint` | Fix the nudge JSON: valid object, `pattern` equal to the slug, lint clean. |
| `worker is running` | Retry in a moment. |

Each of these refusals leaves the live artifact and the ledger unchanged, so the
same command can be run again once the cause is fixed.

An inline row is edited by hand. `sil review retire` and `rehome` refuse it and
print its path: edit or delete that file instead. `sil review delete` takes an
inline row out of the ledger but leaves its file where it is; an inline hook was
copied into the target repo, so that copy is removed in the same commit. `sil review accept` refuses an
older staged branch for the same pattern and prints the
`sil review reject <pattern> --world <w>` command that clears it. `sil
curriculum plan` lists a promoted inline row as `done` and shows any scorecard
proposal in the reason.

## Switching providers

A `litellm` endpoint exists only when `sil init --llm-base-url <url>` created
one, or an operator added it to `llm.yaml` by hand. A plain `sil init` writes
only the `claude` endpoint and makes it active; the examples below assume a
`litellm` endpoint is already there.

```
sil llm list                             endpoints, reachability, and who serves each role
sil llm use claude                       send every role to `claude -p`
sil llm use litellm --role drafter       send one role to LiteLLM
sil llm set-model critic sonnet --endpoint claude
```

`sil llm use <endpoint>` sets `active` and clears the per role overrides, so it is a
full switch. Adding `--role` touches that one role and leaves `active` alone. Model
names live on the endpoint, so a switch never rewrites them: a `litellm` endpoint
keeps the model `--model` gave it at init time (`deepseek/deepseek-flash` if none
was given) while the claude endpoint keeps `sonnet` unless `--claude-model` said
otherwise.

The split that worked in the live run: critic on claude-cli, drafter and judge on
LiteLLM. The critic reads a whole transcript and has to return strict JSON, which
`claude -p` handles well; the drafter and judge are cheaper and faster through the
proxy.

```
sil llm use litellm
sil llm use claude --role critic
```

The same switch is available in the web UI under Models, per endpoint ("Use for all
roles") and per role (the Roles block).

### Running the judge on Jev or Laya

Add a `system-one` endpoint to `llm.yaml` the same way you would add a second
`openai` one (there is no CLI for it), then route the judge to it:

```yaml
endpoints:
  - name: laya
    kind: system-one
    base_url: http://127.0.0.1:8010
    models:
      judge: laya-typed-decisions
    decision_threshold: 0.5
```

```
sil llm use laya --role judge
```

Only `judge` can run on a `system-one` endpoint: it takes a state and a map of
typed questions and returns a calibrated answer per question in one pass, never
text. `sil llm use <ep>` without `--role judge` (or with `--role critic`/`--role
drafter`) is refused by `useEndpoint` with a `ConfigError`. `chat()` refuses too.

The judge gate asks one noul per reject rule (`contradicts`, `vague`,
`unsupported`, `unsafe`, `unrelated`) against one state holding the artifact and
the sources, and all five come back in one call. The pattern is gated out when
any probability is at or above `decision_threshold` (default 0.5); the reason
line names the worst rule and its probability. What is lost against the chat
judge: it quotes its evidence and writes a sentence of reasoning, the typed
judge gives a number per rule and no reasoning.

`sil status` and the web Models pane probe a `system-one` endpoint by sending
one real noul question with the configured judge model, so a probe costs a few
input tokens and reports "no model for role judge configured on this endpoint"
when the model name is missing.

Jev (TypeSafe AI, hosted, paid, needs `TYPESAFE_API_KEY`) is still unmeasured in
this loop. Laya (Convai Innovations, Apache-2.0, usually local with no key) is
free to try, but its own model card calls it "a fast base to specialise, not a
zero-shot decision engine": zero-shot accuracy on the typed-decisions set is
0.362 against a guessing baseline of 0.318, and its calibration only reaches the
advertised error after temperature refitting. Treat a zero-shot Laya judge as an
experiment, keep `auto_merge` off, and read the staged branches yourself.

### Semantic alias review (optional, off by default)

`sil aliases suggest` compares slug tokens. It cannot see that
`stale-cached-env` and `env-read-before-refresh` are one mechanism under two
names, and it fires on pairs that only share vocabulary. With this feature on,
each candidate pair also gets one typed question on the `system-one` endpoint
that serves the judge, and the answer prints under the candidate.

It never applies an alias, never folds two counts together and never touches
promotion, routing or the ledger. `sil aliases set` stays the only way a pair
becomes an alias, and a pair judged `distinct` stays on the list.

Turn it on in `config.yaml`:

```yaml
alias_semantic:
  enabled: true              # default false: no request is made at all
  max_candidates: 10         # assess the first N of the deterministic list
  max_reflections_per_pattern: 2
  max_excerpt_chars: 600     # per reflection, cut not summarised
  timeout_s: 20              # per pair
  concurrency: 2             # pairs in flight
  min_confidence: 0.6        # below this the verdict is `unsure`
```

An answer at exactly `min_confidence` is a verdict; only a lower number
becomes `unsure`. An answer that carries no confidence and no probability for
its own pick is not `unsure` at all: nothing was measured, so that pair reads
`unavailable`.

It needs the judge on a `system-one` endpoint (see the section above). A world
with `llm: local` only reaches a model listed in `local_models`; the feature
reports that it could not run rather than sending the evidence anywhere else.
The endpoint's `base_url` and, when it declares `api_key_env`, the credential
are both checked before the first request, so a missing one is one line above
the list instead of the same line under every candidate.

```
$ sil aliases suggest --world default
possible near-duplicate patterns (same mechanism, different slug). Review each, then apply with the command shown:
  stale-env (2) ~ stale-cached-env (5)  score=0.67
    semantic: same mechanism (confidence 0.94, model jev-1.13.0)
      evidence stale-env: 2026-09-02-stale-env-01, 2026-09-01-stale-env-00
      evidence stale-cached-env: 2026-09-05-stale-cached-env-02, 2026-09-04-stale-cached-env-01
    sil aliases set stale-env stale-cached-env --world default
  verify-callsites (1) ~ verify-callsites-before-fix (2)  score=0.50
    semantic: different mechanisms (confidence 0.81, model jev-1.13.0)
      evidence verify-callsites: 2026-09-06-verify-callsites-00
      evidence verify-callsites-before-fix: 2026-09-08-verify-callsites-before-fix-01
    sil aliases set verify-callsites verify-callsites-before-fix --world default
```

What leaves the machine: the two slugs, and up to
`max_reflections_per_pattern` reflections per slug, each one as its id and an
excerpt cut to `max_excerpt_chars`. The excerpt is the reflection's reusable
lesson, or its body when there is no lesson section. Nothing else: no
transcript, no reflection frontmatter, no env var, nothing from another world.

Two details worth knowing before turning it on. The excerpt is the critic's own
sentence and is cut, not scrubbed, so it carries whatever a lesson normally
carries, repository paths included. The reflection id carries a date and a
pattern slug, and when a slug was folded by an existing alias the id names the
retired pattern rather than the slug above it: `2026-09-15-old-env-00` can
appear as evidence for `stale-cached-env`.

The model picks one of two named options and never writes prose, so every
verdict line is a fixed template plus real reflection ids. An answer that is
not one of the two options is refused. The refusal quotes the answer when it
is short and identifier-shaped, and reports its length instead when it is not.

When a pair times out or the endpoint answers badly, that pair says so and the
rest carry on:

```
  stale-env (2) ~ stale-cached-env (5)  score=0.67
    semantic: unavailable (ProviderTimeout: provider "jev" at http://localhost:5000/v1/systemone timed out after 20s)
    sil aliases set stale-env stale-cached-env --world default
```

A problem that stops every pair before the first request (no `system-one`
endpoint for the judge, no model for the role, no `base_url`, an unset
`api_key_env`, a locality refusal) is reported once, above the list, which
still prints in full:

```
  semantic assessment unavailable: role judge runs on endpoint "litellm" of kind "openai"; semantic assessment needs a system-one endpoint (sil llm use <endpoint> --role judge)
```

The same one-line summary also appears when every pair was tried and every
pair failed. Then each candidate keeps its own `unavailable (...)` line as
well, and the summary names the error most of them agree on.

An error line quotes the provider's own error text, cut to one bounded line.
That is the one place where text from the far end reaches the screen, and it
is always inside `unavailable (...)`, never inside a verdict.

The unit tests use a fake provider: they prove the integration, not the
quality of the judgment. For that, run the live evaluation against your own
endpoint:

```
bun run eval:alias-semantic            # add --json for machine output
```

It asks the configured judge about six hand-labelled pairs in
`scripts/fixtures/alias-semantic-pairs.json` (two clearly equivalent, two
clearly distinct, two genuinely ambiguous), prints the human label next to the
verdict, and lists every disagreement. Ambiguous pairs are reported, never
scored. It writes nothing.

A disagreement is a finding, not a failure, so it exits 0. A failed request,
an answer with no confidence, and a run that scored no pair at all exit 1,
because then the evaluation measured nothing.

## Moving an install to another host

```
sil export ~/sil.tar.gz              # old host
sil import bundle ~/sil.tar.gz       # new host
sil status
```

A destination that ends in `.tar.gz` or `.tgz` gives an archive; any other path
gives a plain directory you can inspect file by file. Both forms import the
same way.

The bundle holds what the loop created: `config.yaml`, `llm.yaml`, and per world
the reflections, aliases, scorecards, inbox and the built-in `learned` repo with
its review branches, plus the usage and feedback history the scorecards are
rebuilt from. Every path under `$HOME` is stored as `~/...`, so a bundle written
in `/home/me` restores under `/Users/me`.

Host state stays behind on purpose: the queue, sessions, logs, the worker lock,
the web token, and `hook-config.json`, which import regenerates. `usage/hook-runs.jsonl`
is also left out; it is the bulk of the volume and no scorecard reads it.

Flags:

- `--world <name...>` on either command limits the worlds. `sil export` refuses
  a name no world has.
- `--no-history` leaves usage, feedback and inbox files behind. The scorecards
  still travel, but they cannot be recomputed on the new host.
- `--force` on export overwrites a non-empty destination. On import it takes the
  bundle's copy of a file this host already has.

Import merges, it does not replace. On a host with no `config.yaml` the bundle's
config is taken whole. On a live host the worlds are merged, and any file the
host already has is kept and counted in the summary; `--force` reverses that
choice. Reflections are the one exception: they are append-only and are never
overwritten, not even with `--force`. The history files are whole-file copies
rather than appends, because appending would double every usage event the host
already counted.

Two things need a hand after an import:

- **Credentials.** `llm.yaml` names an env var, never a key, and no other file
  in the config directory is read, so nothing secret is in the bundle. Set the
  API key env vars on the new host, then run `sil status` to confirm the wiring.
- **External targets.** A world whose `target` points at a repo of your own is
  recorded in the manifest and reported as a note, but never copied. Clone that
  repo on the new host and check the path still matches.

## Rotating API keys

Edit the env var named by `llm.yaml`'s `api_key_env` (or your shell profile), then
just run `sil status` or wait for the next scheduled worker tick. Every scheduled
invocation execs a fresh shell through the `~/.local/bin/sil` shim, so it never
holds a stale key from a long-lived process. `sil web` is itself a long-lived
process: restart it (`sil schedule uninstall && sil schedule install --systemd
--web`, or just `systemctl --user restart sil-web.service`) after a rotation if it
is the one making model calls.

## Updating the plugin

```
claude plugin marketplace update kolezka
claude plugin install self-improvement-loop@kolezka
```

An install writes a new versioned directory and repoints
`~/.claude/plugins/installed_plugins.json`. Hooks, the CLI and every scheduled
worker pass read that at call time, so they are on the new version at once.
`sil web` is the one long lived process: it polls the install path and the built
`dist/.srchash` every 5 seconds, and on a change it stops and exits 0 so the
supervisor starts it on the new version. Nothing to do by hand.

Two consequences worth knowing:

- The systemd unit needs `Restart=always` for this (a clean exit is not a
  failure). `sil schedule install --systemd --web` writes that; a unit written by
  0.2.7 or earlier says `Restart=on-failure` and has to be rewritten once.
- A bind that uses a token (any non-loopback one) no longer gets a fresh token
  per start. It lives in `~/.local/state/self-improvement-loop/web-token`, mode
  600, so a restart keeps every open tab working. Rotate it by deleting that
  file and restarting the service. A loopback bind is tokenless and unaffected.

## Loop state (`sil state`)

Four logs moved from JSONL files into one SQLite file,
`~/.local/state/self-improvement-loop/loop-state.sqlite`:

| Store | Old file (in the state dir) |
| --- | --- |
| `reflect_runs` | `usage/reflect-runs.jsonl` |
| `critic` | `feedback/critic.jsonl` |
| `human` | `feedback/human.jsonl` |
| `proposal_events` | `curriculum/proposal-events.jsonl` |

Nothing to do by hand. The first `sil` command, worker pass or `sil web` that
reads or writes one of these imports the old file and renames it to
`<file>.imported-<stamp>-<id>`, for example
`human.jsonl.imported-2026-10-25T065425046Z-1`. That file is your original, byte
for byte. Nothing deletes it.

```
sil state status [--json]          # DB path, schema, rows per store, each import and its backup check
sil state migrate                  # import any old file now (handy before a first sil web)
sil state quarantine               # lines that were not JSON objects and did not import
sil state quarantine --drop <store>
sil state export --legacy-paths [--force]
```

`status` re-reads every backup. `backup ok` means it still matches what was
imported. `backup grew after import: N bytes not in the DB` means an older
process appended N bytes to the file after the import. Those bytes are only in
that backup, unchanged; no reader, migrate or export uses them.

A quarantined line keeps its raw text in the DB, cut at 64 KiB. A line from an
old JSONL file is also still whole in that file's backup. A line from a bundle
(`sil import bundle`) has no backup: the DB copy is all the loop keeps. While a
store has quarantined lines, strict readers (the consoles' scorecards),
`sil export` and `sil state export` refuse to read that store. Before
`--drop`, make sure you still have the backup or the bundle the line came from.

### Going back to an older plugin

Older builds read the JSONL files and know nothing about the DB. To downgrade:

1. Stop everything that can write:
   - close every Claude Code session (their hooks start workers);
   - stop any `sil web` you started by hand;
   - save what `sil schedule show` prints, and the worker interval from its
     unit file: `OnUnitActiveSec` in `~/.config/systemd/user/sil-worker.timer`,
     or `StartInterval` (seconds) in whichever of
     `~/Library/LaunchAgents/com.raqz.sil-worker.plist` and the older
     `com.kolezka.sil-worker.plist` exists;
   - run `sil schedule uninstall`. It removes unit files even when stopping a
     job fails. On macOS, this must print nothing:

     ```sh
     launchctl list | grep -E 'com\.(raqz|kolezka)\.sil-'
     ```

     If a label remains, run `launchctl remove <label>` and check again.
     On Linux, check each unit named in `apps/cli/src/schedule.ts`:

     ```sh
     for unit in sil-worker.timer sil-worker.service sil-web.service; do
       state=$(systemctl --user show -p ActiveState "$unit") || { echo "cannot check $unit"; exit 1; }
       case "$state" in
         ActiveState=active|ActiveState=activating) echo "$unit is $state"; exit 1 ;;
       esac
     done
     ```

     Every query must exit 0, and every unit must be neither active nor
     activating. If a unit is still running, use `systemctl --user stop <unit>`
     and check again. If a query fails, stop the rollback and investigate;
     a failed query does not prove the scheduler stopped;
   - check that no worker, web or curriculum process is left:

     ```
     pgrep -fl '(dist/cli\.js|apps/cli/src/main\.ts) (worker|web|curriculum)'
     ```

     It prints nothing (exit 1) when all are gone. Stop whatever it lists;
   - from here until the older plugin is installed, run only the `sil state`
     commands below. Other commands write too, for example `sil feedback`,
     `sil review`, `sil reflect` and `sil curriculum`.
2. Run `sil state status`. If any backup says `grew`, stop here: those bytes
   are not in the DB and the export would not contain them. They are still in
   that backup file; decide by hand what to do with them. Clear any quarantined
   lines too (`sil state quarantine`), or that store will not export.
3. Run `sil state export --legacy-paths`. It writes each store that has rows to
   its old path in the old format, and pauses imports so this build leaves those
   files alone. A store with no rows gets no file.
4. If the export exits 1, stop. Do not install the older plugin. The export may
   have written some stores and paused imports, but at least one store is
   missing. Read its `error:` lines and fix the cause: for "has lines that are
   not in the loop state" run `sil state migrate`; for quarantined lines see
   above; for "already exists" pass `--force`, which replaces only a file that
   is exactly one this DB recorded. Then run the export again until it exits 0.
5. Check that the old path of every store with rows in `sil state status` has a
   file.
6. Install the older plugin. Then reinstall the schedule the way your saved
   `sil schedule show` output describes: `--systemd` or `--launchd` from the
   section it listed, `--web` if a `sil-web` unit was there, and
   `--interval-min` with the interval you saved, in minutes.

If you upgrade again later, run `sil state migrate` once. Until then imports
stay paused, `sil state status` says `legacy imports suspended since ...`, and
nothing the older build wrote is read. Migrate turns an unchanged exported file
into a backup without importing it twice, and imports only the lines the older
build appended.

### Reading the DB directly

`sil state export --legacy-paths` is the normal way to get JSONL back. To look
without changing anything:

```
sqlite3 -readonly ~/.local/state/self-improvement-loop/loop-state.sqlite \
  "SELECT body FROM log_records WHERE stream = 'human' ORDER BY id"
```

`body` is the record as one JSON line: the imported line with surrounding
whitespace trimmed, or what this build wrote. The other tables are
`quarantine`, `legacy_imports` (one row per import or export, with size, sha256
and, once the file has been moved aside, its backup path) and `meta`. Do not
write to the file by hand.

## Logs

```
sil logs worker --lines 100
sil logs hook --lines 50
sil logs web
sil logs curriculum
```

Log files live at `~/.local/state/self-improvement-loop/logs/{hook,worker,web,curriculum}.log`.

A tolerant read that had to fall back to what the loop state DB already had
writes one line per store to `logs/state.log` (no `sil logs` name for it yet).

## Troubleshooting

**Hook seems to do nothing.** The hook snapshot may be stale: rerun `sil
hook-snapshot` (also runs automatically after `init`, `worlds add`, `worlds
import-kb`). Check `sil logs hook`.

**Worker never runs.** Check `sil status` for the lock state. A stale lock (worker
crashed mid-run) sits at `~/.local/state/self-improvement-loop/worker.lock`;
remove it by hand if `sil status` shows no running worker but the lock file is
old.

**`ModelNotConfigured` or `LocalityViolation`.** `llm.yaml` has no model set for a
role, or a world is `llm: local` but its configured model is not in
`local_models`. Both are fail-loud by design: fix `llm.yaml`, do not add a
fallback.

**Provider errors.** `sil status` prints the provider's reachability for each
world. A `claude-cli` endpoint needs the `claude` binary on `PATH`; an `openai`
endpoint needs its `base_url` reachable and `api_key_env` set.

**`/learn` says the lesson is not recorded yet.** A project artifact on a branch
is registered only after the branch is merged and the merge check passes. Pull
the default branch locally if you merged remotely, then ask the agent to run
the pending register command.

**Curriculum keeps gating a pattern out.** `sil curriculum plan --world <w>`
prints the reason per pattern with no model calls. `sil curriculum run --world <w>`
(no `--apply`) does the same after a real draft, without staging anything.

### The critic or drafter fails with "returned empty content"

The model is a reasoning model and spent the whole `max_tokens` budget on its
hidden reasoning (the error names the `finish_reason` and the reasoning token
count). Give the endpoint in `llm.yaml` an `extra_body` that the proxy forwards
to the provider, for example:

```yaml
endpoints:
  - name: litellm
    kind: openai
    base_url: https://litellm.example
    api_key_env: LITELLM_API_KEY
    extra_body:
      reasoning_effort: low      # or: thinking: { type: disabled }
```

`extra_body` is merged into every chat request last, so it can also raise
`max_tokens`. Measured on `zai/glm-5.3-flash` through LiteLLM: without it a
critic call burned 3994 reasoning tokens and returned nothing after 110 s; with
`reasoning_effort: low` the same call answers in a few seconds.

A `claude-cli` endpoint has no `extra_body` (that only reaches an `openai`
endpoint's request body). Its own reasoning knob is the endpoint's `effort`
field (`low`, `medium`, `high`, `xhigh` or `max`), passed as `--effort <level>`. A
nested `claude -p` call spends 10k to 22k output tokens on hidden thinking at
around 100 tokens/s and can exceed `timeout_s` before it ever answers; setting
`effort: low` cuts that budget. Every `claude-cli` call also runs with
`--no-session-persistence`, `--strict-mcp-config` and `--tools ""`, so a
nested run does not load the parent's tools or MCP servers and the hook does
not later reflect on the critic's own session.

### The proxy answers HTTP 524 or the call takes longer than 100 s

A Cloudflare tunnel in front of LiteLLM cuts requests at 100 s. Pick a model
that answers the critic prompt well inside that window (measured: a non
reasoning 14B model in 23 s, `claude-cli` sonnet in about 80 s, a reasoning
model that hides 4000 tokens of thinking never). Verify that a reasoning knob in
`extra_body` reaches the provider by reading `reasoning_tokens` in the error
message; if it does not move, the proxy is dropping the parameter.

