# Install

## Requirements

- `bun` (>= 1.4.2) on `PATH`. Every part of the plugin runs on it: the hook
  fast path, the CLI, the worker and the web UI.
- `git`.
- A model endpoint: either a local LiteLLM/OpenAI-compatible proxy, or the
  `claude` CLI on `PATH`.

## Marketplace install

```
claude plugin marketplace add kolezka/marketplace
claude plugin install self-improvement-loop@kolezka
```

Then in any Claude Code session:

```
/loop
```

This prints status and confirms the plugin is wired up.

The marketplace entry tracks the `release` branch of this repo, which a release
run moves to the newest release commit. Only those commits carry the prebuilt
`dist/` the plugin runs; `main` does not. To pin one version, set
`"ref": "v<version>"` on the entry. On a machine with no git or npm, install the
zip attached to the release with an `archive` source; the release notes carry the
URL and its `sha256`. See `docs/RELEASE.md`.

## Local dev install

From a checkout of this repo:

```
make build
claude --plugin-dir /path/to/self-improvement-loop
```

This loads the plugin from disk without touching the marketplace. Useful while
developing `sil` itself. `make build` is not optional: `dist/` is untracked, and
the hooks run `dist/hook.js`.

## First run

```
scripts/sil init
```

This writes `~/.config/self-improvement-loop/config.yaml` and `llm.yaml` with one
catch-all world, and a `learned/` git repo that world's artifacts land in until you
point it at a real target. Edit `llm.yaml` and set `models.critic`,
`models.drafter` and `models.judge`, then check status:

```
scripts/sil status
```

Then run `sil import payloads --days 30` once, so the curriculum router has a
corpus of real tool calls to test drafted hook gates against from the start
instead of waiting for the sampler to fill one. It reads Claude Code's own
session transcripts under `~/.claude/projects`; the PreToolUse hook keeps the
file current afterwards, so this is a one-time backfill.

Once a plugin install is active, the same commands work through the installed
shim:

```
sil status
sil web
```

## Function hooks (early access)

Set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the environment before starting
`claude`. Nothing changes without it: the plugin runs exactly as above, one
command hook per event. With it set, Claude Code loads the plugin's hooks
module (`dist/hook-module.js`) and runs SessionStart, UserPromptSubmit,
PreToolUse and PostToolUse in process instead of spawning `bun dist/hook.js`
for those four events. The command hooks for those four are guarded by
`[ "$SIL_HOOK_MODULE" = "$PPID" ] ||`, which compares the variable the module
sets with the hook shell's parent pid, so a nested `claude` run from a Bash tool
call keeps its own command hooks instead of silently losing them. Stop,
SubagentStop and SessionEnd are unaffected either way.

## Reaching the UI from another machine

`sil web` binds `127.0.0.1` by default and runs tokenless there, so the printed
URL has no token fragment: open `http://127.0.0.1:8766/` directly. To open it from a phone, another laptop or
over tailscale, set the bind address in
`~/.config/self-improvement-loop/config.yaml`:

```yaml
web:
  port: 8766
  host: 0.0.0.0            # or a single address, e.g. 100.64.0.5 for tailscale only
  allowed_hosts: []        # add "box.tail1234.ts.net:8766" to use a MagicDNS name
```

`sil web --host <address>` does the same for one run. A non-loopback bind keeps
the token on, so the URL printed at startup carries it in the fragment; open that
exact URL on the other machine. When the bind address is a wildcard, `sil web`
prints one URL per private address of this machine, so you can copy the tailscale
one directly.

Two rules the server enforces:

- A bind off loopback requires the token. It stays on there by default, and
  `sil web --no-token --host 0.0.0.0` fails instead of exposing every op to the
  network.
- The `Host` header must be a private IP literal (LAN, `100.64.0.0/10` for
  tailscale, IPv6 ULA) or a name listed in `web.allowed_hosts`. This is what keeps
  DNS rebinding blocked: an attacker domain never matches.

If the address answers nowhere, check the host firewall before the config:
`sudo ss -tlnp | grep 8766` shows what the server bound to.

## Running on a schedule

```
sil schedule install --web --interval-min 60
```

It picks systemd on Linux and launchd on macOS. Pass `--systemd` or
`--launchd` to choose one yourself. Running it again replaces the installed
units and reloads them, so a new `--interval-min` takes effect at once.

This installs a worker timer/interval and a web service, both calling a stable
shim at `~/.local/bin/sil` so a plugin version bump never breaks the schedule.
See `docs/OPERATIONS.md` for what runs and when. On macOS the agents write
their output to the files `sil logs worker` and `sil logs web` read.

The web service picks up a plugin update on its own: `sil web` notices that the
current install path or the built `dist/` changed, stops and exits 0, and the
supervisor (systemd `Restart=always`, launchd `KeepAlive`) starts it again on
the new version. The URL stays the same, and so does the token when a bind off
loopback uses one, so an open tab keeps working after a reload. Run
`sil web --no-watch` for a foreground server that should survive an update.

## Uninstall

```
sil schedule uninstall
claude plugin uninstall self-improvement-loop@kolezka
```

Config, state and data under `~/.config/self-improvement-loop/`,
`~/.local/state/self-improvement-loop/` and `~/.local/share/self-improvement-loop/`
are left in place; remove them by hand if you want a clean slate.
