# CLAUDE.md

Claude Code plugin that reflects on coding sessions in the background, clusters the
lessons, and stages skills, hooks, rules and agents for a human to accept. Bun +
TypeScript monorepo, Svelte 5 web console, CLI `sil`. Successor of the V1 loop in
`dotfiles-next`; `docs/V1-PARITY.md` maps what carried over.

Design record: `docs/ARCHITECTURE.md`. Operations: `docs/OPERATIONS.md`. Install:
`docs/INSTALL.md`. Release: `docs/RELEASE.md`.

## Commands

```sh
bun install
bun run build          # writes dist/ (untracked); hooks.json runs dist/hook.js
bun test
bun run typecheck
bun run check:web      # svelte-check
bun run lint:dashes    # fails on em or en dashes in any tracked text file
bun run sil <args>     # CLI from source
make dev-install       # claude --plugin-dir .
```

CI (`.github/workflows/ci.yml`) runs, in order: `bun install`, `git diff --exit-code
-- bun.lock`, lint:dashes, typecheck, check:web, build, test. Run the same set before
calling a change done. Build before test: `tests/dist.test.ts` skips its drift checks
when `dist/` is missing.

Bun version is pinned in `.bun-version`. A `dist/` built on another bun differs and
fails the drift test with a diff that looks like a source problem.

## Layout

- `apps/hook`: command hook, bundled to `dist/hook.js`.
- `apps/hook-module`: in-process function hooks module (behind
  `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`).
- `apps/cli`, `apps/server`, `apps/web`: `sil` CLI, `Bun.serve` API, Svelte console.
- `packages/*` (`@sil/*`): core, store, transcript, providers, critic, worker,
  curriculum, review, feedback, nudges, ops, openclaw.
- `hooks/hooks.json`, `commands/`, `skills/`, `.claude-plugin/`: plugin surface.
- `.ai/todo.md`, `.ai/lessons.md`: working plan and lessons. Update both when a task
  lands.

## Design rules (from ARCHITECTURE.md, do not break)

1. Hooks never block and never call a model. At most an `additionalContext`. No
   `decision: block`, no `permissionDecision: deny`. Budget well under 60 ms.
2. One critic implementation, in the worker. No second drafting path.
3. Local-first. Only critic, drafter and judge reach a model. Outline is an optional
   export target, never a read dependency.
4. Nothing reaches a shared remote without a human. Curriculum stages branches;
   accept is bound to the `reviewed_state` digest of what the human saw.
5. Feedback (usage, fires, votes) is data the planner reads. A human decides
   refine and retire.
6. Worlds stay separate. Filter by world before alias resolution.
7. Fail loud. No localhost fallback, no placeholder key, no silent default model. A
   missing role raises `ModelNotConfigured`.

## Hook paths

The function hooks module owns SessionStart, UserPromptSubmit, PreToolUse and
PostToolUse, and sets `SIL_HOOK_MODULE` to its claude pid. The matching command
hooks are guarded with `[ "$SIL_HOOK_MODULE" = "$PPID" ]` so a nested `claude` keeps
its hooks. Stop, SubagentStop and SessionEnd stay command hooks and ingest the
module spool (`sessions/<id>/module-spool.json`). Shared logic lives in pure cores
(`@sil/core/layout`, `lessons`, `hook-snapshot`, `spool`,
`@sil/nudges/dispatch-core`) so the two paths cannot drift. Change the core, not a
copy.

`claude plugin validate .` wants `function register(on)` at top level, not
`export const register = ...`. The module has no Node APIs: `node:` imports are
refused at load.

## Traps already hit (read before writing similar code)

- Tests that spawn a process must pass `env` built from tmp dirs.
  `Bun.spawn`/`spawnSync` snapshot env at process start, so setting `process.env`
  later does nothing and the test runs against the real home.
- Tests that drive the worker must disable `worker.auto_kick` after `sil init`, or a
  real detached worker steals the queue entry.
- Use `Object.hasOwn`, never `x in obj`, for lookups keyed by untrusted strings.
  This trap was written twice. Grep `.ai/lessons.md` for the construct.
- An empty path string means cwd. Never default a path to `""`.
- Bound regex input at load time and prefer linear matchers. Heuristic
  nested-quantifier checks have been bypassed.
- Enforce an invariant at the single write point every caller passes through, not
  in one caller.
- When a decision depends on when an event happened, store that event's own
  timestamp, not `last_updated`.
- `Bun.build({ target: "browser" })` bundles a polyfill for `node:` imports instead
  of refusing. Check the source import closure, not the bundle text.
- `bun install --frozen-lockfile` accepts a stale lockfile. Diff `bun.lock`.
- Before implementing in a worktree: `git fetch`, `git log --oneline
  HEAD..origin/main`, and check sibling branch names for the same symptom. Fixes
  have been redone on stale bases twice.
- Parallel implementers must get cross-module signatures as code in the brief, and
  one end-to-end test must run through the real modules before "all green" counts.

## Local install and ops

- `dist/` is never committed on `main`. The release workflow builds it, tags
  `v<version>` and force-pushes the `release` branch. Never branch off `release`.
- Version bumps go through `scripts/bump-version.sh <x.y.z>` (manifests, health
  handler `SIL_VERSION`, `bun.lock`).
- Claude Code copies the plugin into its cache at install time, and `claude plugin
  update` compares only the version string. To test an unreleased change, uninstall
  and reinstall, or use `--plugin-dir`.
- Web console is `sil web`. On macOS `localhost` may resolve to `::1`; check
  `lsof -iTCP:<port>` on both stacks before picking a port.
- Worker under launchd needs `LITELLM_API_KEY` in its environment. A missing key
  surfaces as `ModelNotConfigured`, not as a provider error.
- Sessions run with `--no-session-persistence` leave no transcript. The hook skips
  them and the worker retires them as `skipped: transcript not persisted`, not
  `failed`. `failed` means the reflection ran and broke.

## Style

- No em or en dashes anywhere, including comments and docs. `lint:dashes` enforces
  it.
- Conventional Commits. Work in a worktree, never on `main` directly.
- Every bug fix ships a regression test that fails on the old code. Verify the red
  run, not just the green one.
