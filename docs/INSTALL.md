# Install

## Requirements

- `bun` (>= 1.4.2), from https://bun.sh. Every part of the plugin runs on it:
  the hook fast path, the CLI, the worker and the web UI. The hooks and `sil`
  also look in `~/.bun/bin`, `/opt/homebrew/bin` and `/usr/local/bin`, so a
  Claude Code started from the desktop app or an IDE finds it without the
  shell's `PATH`. With no bun at all, each hook prints an install hint and
  sessions are not recorded.
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

If the loop has never been set up, `/loop` now runs `sil init` first and
reports its output; otherwise it prints status and confirms the plugin is
wired up. To run init directly instead, use the full path into the plugin
cache:

```
~/.claude/plugins/cache/kolezka/self-improvement-loop/<version>/scripts/sil init
```

The marketplace entry tracks the `release` branch of this repo, which a release
run moves to the newest release commit. Only those commits carry the prebuilt
`dist/` the plugin runs; `main` does not. To pin one version, set
`"ref": "v<version>"` on the entry. On a machine with no git or npm, install the
zip attached to the release with an `archive` source; the release notes carry the
URL and its `sha256`. See `docs/RELEASE.md`.

## Standalone install from a checkout

To use the loop without installing a Claude Code plugin:

```sh
bun install
make install-local
# Equivalent: bun run install:local
```

Both commands build the checkout, then install symlinks into
`$CLAUDE_CONFIG_DIR`. If that variable is unset or empty, they use `~/.claude`.
A nonempty variable always selects that directory, creating it if needed:

```sh
CLAUDE_CONFIG_DIR="$HOME/.claude-work" make install-local
```

The installer creates:

- `self-improvement-loop` pointing to this checkout.
- `commands/*.md` pointing to this repo's slash commands.
- `skills/self-improvement-loop` pointing to the shared skill directory.
- Command hook entries in `settings.json`, merged with existing settings and hooks.

It does not register a plugin or modify `CLAUDE.md`, model settings, or the
loop's own config. Running it again keeps the same links and hook entries.
Conflicting files or links are refused before installation; move them aside
and rerun. A malformed or symlinked `settings.json` is also refused rather than
overwritten. Do not run standalone and plugin hooks together. If this config
has the plugin enabled, disable it with `/plugin` before installing; also check
project settings and do not start Claude with `--plugin-dir` for this repo.

Restart Claude Code. On a fresh setup, run `scripts/sil init` from the checkout;
this also installs the normal `~/.local/bin/sil` shim. If already initialized,
use status instead. The CLI is available directly even before the shim exists:

```sh
"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/self-improvement-loop/scripts/sil" status
```

Slash commands are installed without a plugin namespace. If another command or
a built-in skill owns a name such as `/loop`, use the CLI instead.

Keep the checkout in place. After pulling updates, rerun `make install-local`
to rebuild and pick up new commands. Use the same `CLAUDE_CONFIG_DIR` in the
terminal or service that runs `sil`; an explicit `SIL_PLUGIN_ROOT` still wins.
To move the checkout, remove only this install's symlinks, then reinstall from
the new location. To uninstall, remove those symlinks and the hook entries whose
commands point to `self-improvement-loop` from `settings.json`; keep unrelated
hooks and settings. Links for commands removed from the repo are not pruned
automatically; remove those dangling links manually.

Standalone mode uses the command hooks, not the function hooks module. The
native `/sil` console requires the plugin; `/loop`, the CLI and `sil web` work
without it.

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
point it at a real target. The default `llm.yaml` routes every role through the
`claude` CLI (`claude -p`) with model `sonnet`, so a plain `sil init` needs no
further setup as long as `claude` is on `PATH`. To route through a LiteLLM or
other OpenAI-compatible endpoint instead, pass `--llm-base-url`:

```
scripts/sil init --llm-base-url http://localhost:4000 --model deepseek/deepseek-flash
```

That writes a second endpoint named `litellm` and makes it active, and the
worker needs `LITELLM_API_KEY` (or whatever `--api-key-env` names) set in its
environment before it can use it. `sil llm use claude` and `sil llm use
litellm` switch between them later; `--llm-base-url` only has an effect the
first time, while `llm.yaml` does not exist yet. Check which endpoint serves
each role:

```
scripts/sil status
```

`sil init` also installs the `sil` shim at `~/.local/bin/sil` and warns when
that directory is not on `PATH`, so the commands below work in a plain shell.
It creates (or finds) `learned/RULES.md` and prints its path.
Promoted rules live in the marked block inside that file, and the SessionStart
hook injects them into every session on its own; there is nothing to add to
your own CLAUDE.md.

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

## Codex

The first time, before any shim exists, run the plugin's own copy:

```
~/.claude/plugins/cache/kolezka/self-improvement-loop/<version>/scripts/sil codex install
```

This copies `skills/self-improvement-loop/SKILL.md`, the same skill Claude Code
loads, to `~/.agents/skills/self-improvement-loop/SKILL.md`. That is the user
skill directory Codex scans. It also writes the `~/.local/bin/sil` shim, so a
Codex agent can call `sil`, and warns when that directory is not on `PATH`.

Both files are copies, never symlinks, because the plugin cache path changes
with every version. Run `sil codex install` again after a plugin update. If you
put a symlink at either path yourself, it is left alone and nothing is written
through it.

The shim finds the plugin through `SIL_PLUGIN_ROOT`, else through Claude Code's
`installed_plugins.json`. With no marketplace install, for example a dev
checkout, export `SIL_PLUGIN_ROOT=/path/to/self-improvement-loop` in the shell
Codex runs from.

The skill lets a Codex agent operate the loop: status, reflections, lessons,
review and feedback. Codex sessions do not feed the loop. Nothing records them
and there is no Codex transcript parser, so a Codex agent asked to queue its
session says it cannot. To remove the skill, delete
`~/.agents/skills/self-improvement-loop`.

## Function hooks (early access)

Set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the environment before starting
`claude`. Nothing changes without it: the plugin runs exactly as above, one
command hook per event. With it set, Claude Code loads the plugin's hooks
module (`dist/hook-module.js`) and runs SessionStart, UserPromptSubmit,
PreToolUse and PostToolUse in process instead of spawning `scripts/hook`
for those four events. The command hooks for those four are guarded by
`[ "$SIL_HOOK_MODULE" = "$PPID" ] ||`, which compares the variable the module
sets with the hook shell's parent pid, so a nested `claude` run from a Bash tool
call keeps its own command hooks instead of silently losing them. Stop,
SubagentStop and SessionEnd are unaffected either way.

## Native console (`/sil`)

`/sil` opens a read-only console pane beside the chat: overview, staged
proposals with their full diff, artifacts, activity and settings, per world. It
lives in the hooks module, so it needs what the module needs: a built `dist/`
and function hooks enabled as above. Without the module there is no `/sil`, and
nothing pretends otherwise. The CLI and the web UI cover the same reads and the
writes the pane does not have yet: `sil status`, `sil review list`,
`sil review show <pattern>`, `sil web`. See `docs/OPERATIONS.md`.

The pane reads through `sil ops`, the plugin's own `scripts/sil` with the
plugin root pinned, one bounded request per read. It never starts the worker and
never calls a model.

What has been checked, and how:

- Measured by tests: the bridge against a real staged proposal (all diff and
  body pages at one digest, a refused stale digest, no write to loop state, no
  provider call), in `tests/native-console.test.ts` over the built `dist/`.
- Measured by `bun run scripts/test-native.ts`: `claude plugin validate` and the
  module's engine tests, on a mounted tree, against the installed `claude`.
- Not verified yet: the pane in an attended terminal (typing `/sil`, resizing,
  keyboard focus, close and reopen), reload across instances, and which Claude
  Code builds load the module without `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.
  Treat the flag as required until that is measured.

### An isolated fixture for trying the console

`scripts/native-console-fixture.ts` seeds synthetic loop state for trying `/sil`
away from a real install and loop state. Run it with an isolated HOME, Bun cache,
`TMPDIR` and XDG dirs of its own, since a plain `bun run` writes Bun's
transpiler cache under your real HOME:

```sh
checkout=/path/to/self-improvement-loop
scratch="$(realpath "$(mktemp -d "${TMPDIR:-/tmp}/sil-setup.XXXXXX")")"
root="$(realpath "$(mktemp -d "${TMPDIR:-/tmp}/sil-native.XXXXXX")")"
mkdir -p "$scratch/home" "$scratch/tmp"
env -i HOME="$scratch/home" TMPDIR="$scratch/tmp" \
  XDG_CONFIG_HOME="$scratch/home/.config" XDG_CACHE_HOME="$scratch/home/.cache" \
  XDG_DATA_HOME="$scratch/home/.local/share" XDG_STATE_HOME="$scratch/home/.local/state" \
  BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
  PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  bun run "$checkout/scripts/native-console-fixture.ts" "$root"
```

`$scratch` is the setup run's own home; `$root` is the fixture and stays
empty until the script fills it. `tests/native-console.test.ts` runs this exact
block with a stand-in HOME and checks nothing lands there.

The root must exist, be empty and be given by its canonical path: on macOS
`/var` and `/tmp` are symlinks, so pass the `realpath` of the dir. The script
refuses anything else and leaves it untouched. It prints one JSON line,
`{ root, pluginRoot, configDir }`: `pluginRoot` is this checkout and
`configDir` is the `SIL_CONFIG_DIR`. The rest of the layout is fixed under
root:

| Path under root | What it is |
| --- | --- |
| `config`, `state`, `data` | `SIL_CONFIG_DIR`, `SIL_STATE_DIR`, `SIL_DATA_DIR` |
| `home`, `claude`, `gitconfig`, `tmp` | `HOME`, `CLAUDE_CONFIG_DIR`, git global config, `TMPDIR` |
| `bin/claude` | a stand-in `claude` that only records calls in `claude-calls.log` |
| `workspace`, `workspace-two` | the dirs worlds `fixture` and `fixture-two` own |
| `target`, `target-two` | each world's git target, one staged proposal each |

The script also writes the hook snapshot (`state/hook-config.json`) through
`scripts/sil hook-snapshot`, so the session's hooks and the console pick the
same world.

`worker.auto_kick` is off and the only configured endpoint is the stand-in
`claude`, so the loop's own worker has no real model to call through this
config. The Claude Code session you open is still a normal session: what you
type to it goes to a model. A session started in `workspace` resolves to world
`fixture`. To open it, run the real `claude` by its absolute path with only the
fixture's environment, the same paths the fixture's own processes use:

```sh
real_claude="$(command -v claude)"
cd "$root/workspace"
env -i TERM="$TERM" HOME="$root/home" TMPDIR="$root/tmp" \
  PATH="$root/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  XDG_CONFIG_HOME="$root/home/.config" XDG_STATE_HOME="$root/home/.local/state" \
  XDG_DATA_HOME="$root/home/.local/share" XDG_CACHE_HOME="$root/home/.cache" \
  SIL_CONFIG_DIR="$root/config" SIL_STATE_DIR="$root/state" SIL_DATA_DIR="$root/data" \
  CLAUDE_CONFIG_DIR="$root/claude" GIT_CONFIG_GLOBAL="$root/gitconfig" \
  GIT_CONFIG_SYSTEM="$root/gitconfig" GIT_CONFIG_NOSYSTEM=1 \
  BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 \
  "$real_claude" --plugin-dir "$checkout"
```

The empty `CLAUDE_CONFIG_DIR` has no login, so the session asks for one. The
test checks that this block names the same paths as the fixture; the launch
itself has not been run attended yet. Remove `$root` and `$scratch` when done.

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
