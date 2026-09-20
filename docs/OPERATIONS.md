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
again. `sil review rehome <pattern> --type none` is a retirement as well: nothing
serves the pattern after it.

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

