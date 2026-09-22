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

`accept` always needs `--reviewed-state`: paste the hash `sil review show` prints.
This binds the accept to exactly what you looked at; if the branch changed
underneath you, accept fails and asks you to reload.

## Switching providers

```
sil llm list                             endpoints, reachability, and who serves each role
sil llm use claude                       send every role to `claude -p`
sil llm use litellm --role drafter       send one role to LiteLLM
sil llm set-model critic sonnet --endpoint claude
```

`sil llm use <endpoint>` sets `active` and clears the per role overrides, so it is a
full switch. Adding `--role` touches that one role and leaves `active` alone. Model
names live on the endpoint, so a switch never rewrites them: LiteLLM keeps
`deepseek/deepseek-flash` (the `sil init` default) while the claude endpoint keeps `sonnet`.

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

## Logs

```
sil logs worker --lines 100
sil logs hook --lines 50
sil logs web
sil logs curriculum
```

Log files live at `~/.local/state/self-improvement-loop/logs/{hook,worker,web,curriculum}.log`.

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

### The proxy answers HTTP 524 or the call takes longer than 100 s

A Cloudflare tunnel in front of LiteLLM cuts requests at 100 s. Pick a model
that answers the critic prompt well inside that window (measured: a non
reasoning 14B model in 23 s, `claude-cli` sonnet in about 80 s, a reasoning
model that hides 4000 tokens of thinking never). Verify that a reasoning knob in
`extra_body` reaches the provider by reading `reasoning_tokens` in the error
message; if it does not move, the proxy is dropping the parameter.

