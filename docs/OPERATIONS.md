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

`accept` always needs `--reviewed-state`: paste the hash `sil review show` prints.
This binds the accept to exactly what you looked at; if the branch changed
underneath you, accept fails and asks you to reload.

## Rotating API keys

Edit the env var named by `llm.yaml`'s `api_key_env` (or your shell profile), then
just run `sil status` or wait for the next scheduled worker tick. Every scheduled
invocation execs a fresh shell through the `~/.local/bin/sil` shim, so it never
holds a stale key from a long-lived process. `sil web` is itself a long-lived
process: restart it (`sil schedule uninstall && sil schedule install --systemd
--web`, or just `systemctl --user restart sil-web.service`) after a rotation if it
is the one making model calls.

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
