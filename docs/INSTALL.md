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

## Local dev install

From a checkout of this repo:

```
claude --plugin-dir /path/to/self-improvement-loop
```

This loads the plugin from disk without touching the marketplace. Useful while
developing `sil` itself.

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

Once a plugin install is active, the same commands work through the installed
shim:

```
sil status
sil web
```

## Running on a schedule

```
sil schedule install --systemd --web --interval-min 60
```

or on macOS:

```
sil schedule install --launchd --web
```

This installs a worker timer/interval and a web service, both calling a stable
shim at `~/.local/bin/sil` so a plugin version bump never breaks the schedule.
See `docs/OPERATIONS.md` for what runs and when.

## Uninstall

```
sil schedule uninstall
claude plugin uninstall self-improvement-loop@kolezka
```

Config, state and data under `~/.config/self-improvement-loop/`,
`~/.local/state/self-improvement-loop/` and `~/.local/share/self-improvement-loop/`
are left in place; remove them by hand if you want a clean slate.
