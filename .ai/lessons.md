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
