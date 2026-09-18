# Lessons

- 2026-09-14: Parallel implementers wrote tests that locked their own guess of a
  shared contract (ops passed world NAME strings, review expected World objects).
  Every group was green; the integration was broken. Fix: the orchestrator writes
  the cross-module signatures into the brief as code, not prose, and runs one
  end-to-end test through the real modules before trusting "all green".
- 2026-09-14: Three independent reviewers found four blockers the implementers'
  green suites did not (cwd as nudge source, accept merging a moving ref, import
  failure exiting 1, lock file never released). Unit tests prove the contract the
  author imagined; a reviewer probes the contract the code actually has. Budget
  the review pass, do not treat it as optional.
- 2026-09-14: A hook that spawns a background worker will race any test that
  drives the worker in-process. Tests must disable `worker.auto_kick` after
  `sil init`; the first e2e run lost its queue entry to a real detached worker.
- 2026-09-14: `Path("") == Path(".")`. Any "path or empty string" default in a hook
  turns the session cwd into a data source. V1 had documented this exact trap and
  V2 reintroduced it; read the predecessor's landmine comments before porting.
- 2026-09-14 (TS port): a "regex made safe by a heuristic" is only as safe as the
  heuristic's coverage. Glob to regex translation without atomic groups and an
  alternation form `(a|aa)+` both slipped past a nested quantifier check. Bound
  the input at load time and prefer linear matchers over clever regexes.
- 2026-09-14 (TS port): a subprocess test that does not pass `env` explicitly
  runs against the operator's real home dirs; Bun.spawn snapshots env at start.
  Every test that spawns must build its env from the tmp dirs.
- 2026-09-14 (TS port): `x in obj` accepts Object.prototype keys; use
  Object.hasOwn for any lookup keyed by untrusted strings (events, matchers).
- 2026-09-19: A worktree 22 commits behind `origin/main` made a stale `dist/` look
  like a live shipping hole. `git archive origin/main` into a temp tree ran
  `tests/dist.test.ts` at 6 pass, 0 fail, so main was in sync the whole time. Fetch
  and re-check every candidate hole against `origin/main` before naming it one; a
  worktree's own state is not evidence about the branch.
- 2026-09-19: A subagent named the untimed regex gate the most dangerous open hole
  while quoting the very comment block that documents the 4000 character subject cap
  defending it. Read the primary source before repeating a subagent's severity call.
- 2026-09-19: `bun install --frozen-lockfile` exits 0 on a lockfile whose workspace
  versions are stale, then a plain `bun install` rewrites it. With `bun.lock` as a
  build-hash input that turns every contributor's first local run red for a reason
  they did not cause. A freshness flag is not a freshness check; diff the file.
- 2026-09-19: The `x in obj` trap above was recorded on 2026-09-14 and then written
  again, five days later, in `sil aliases set` and `rm`. A lesson only pays off if it
  is re-read before writing the same kind of code. Grep `.ai/lessons.md` for the
  construct, not for the feature.
- 2026-09-19: A guard placed at one caller is not an invariant. The alias two-hop
  check lived in the CLI and covered one direction of the chain, while the ops
  handler and the web pane wrote whole maps with no check at all. Enforce an
  invariant at the single write point every caller passes through, and make the
  caller collapse the conflict rather than refuse, when refusing leaves the data in
  the broken state the feature exists to fix.
- 2026-09-19: `last_updated` is not "when this happened". Reject, re-home and retire
  all bumped it, so a refused redraft restarted the retire clock on an artifact
  nobody used, and the reason string named the rejection date while claiming it was
  the promotion. When a decision depends on when an event happened, store that
  event's own timestamp.
