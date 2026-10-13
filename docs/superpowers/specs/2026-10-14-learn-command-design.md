# `/learn`: capture a lesson from the current session

Date: 2026-10-14. Branch: `feat/learn-command`.

## Problem

The loop needs three reflections before a lesson becomes an artifact. Some
failures are obvious the moment they happen: the operator asks "are we doing X?",
the agent answers "no", and the operator has to point at file Y where it does X.
Its own review missed it too. Waiting for that to recur two more times is the
wrong cost. The operator wants one command, run in that session, that turns the
correction into a skill, agent, rule, nudge or CLAUDE.md edit.

## Decisions taken

1. **Inline drafting.** The agent in the session drafts the artifact. It already
   holds the correction in context. No worker, no critic, no model config. Works
   in Claude Code and Codex alike. Cost: it skips the loop's critic and judge,
   and the agent that made the mistake writes its own lesson. The human diff
   review in step 5 is the check that replaces them.
2. **Scope asked per run.** The command suggests project or global scope and
   the operator confirms.
3. **Recorded in the loop.** Every written artifact gets a ledger row, so votes,
   scorecards and dedupe see it, and curriculum never stages a second copy.

## Goals

- `/learn [note]` in Claude Code, and the same procedure reachable from Codex
  through the existing `self-improvement-loop` skill.
- Output is one of: rule (CLAUDE.md line), skill, agent, nudge. Or an edit to an
  existing one.
- Nothing is written before the operator approves the exact diff.
- The lesson names the check that would have caught the mistake, not only
  "don't do X".
- `sil artifacts register` records the artifact in the world's ledger.

## Non-goals

- No `settings.json` hooks. A "hook" here is a loop nudge (`nudges_dir`), which
  only adds context. Design rule 1 stands: no `decision: block`, no deny.
- No usage counting for inline rules. See "Known gaps".
- No automated refine or retire of inline artifacts. The scorecard can propose
  `refine` or `retire-candidate`. A human edits or deletes the file.
- No background or worker path. `/reflect` stays the way to feed the loop.

## Surface

| Piece | Path | Role |
| --- | --- | --- |
| Slash command | `commands/learn.md` | Claude Code entry, takes optional `[note]` |
| Procedure | `skills/self-improvement-loop/learn.md` | The steps below. `commands/learn.md` points at it, so the two cannot drift. Kept out of `SKILL.md`, which has a 120 line budget (`tests/plugin-manifest.test.ts`) |
| Codex copy | `apps/cli/src/commands/codex.ts` | `sil codex install` copies `learn.md` next to `SKILL.md`; today it copies `SKILL.md` only (`codex.ts:24`) |
| Skill index | `skills/self-improvement-loop/SKILL.md` | One row in the quick reference: "capture a lesson now: read `learn.md`" |
| CLI | `sil artifacts register` | Ledger write |
| Op | `packages/review` `register()` | The single write point the CLI calls |

## Procedure (prompt, run by the session agent)

1. **Locate.** Find the correction in the conversation: the operator's question,
   the wrong answer, the evidence that contradicted it. `[note]`, when given,
   overrides the guess. State the failure in one sentence and the check that
   would have caught it in a second. Wait for the operator to confirm. A wrong
   reading here poisons every later step.
2. **Pick the world.** Run `sil status` and `sil worlds list`, propose the
   world whose target this lesson belongs to, and get it confirmed. Every later
   `sil` call passes `--world <name>`; never rely on cwd resolution, which can
   record a global lesson in an unrelated project's world.
3. **Dedupe.** Run `sil artifacts --json` and `sil curriculum plan` (no model
   calls), then `rg` the candidate targets: project `CLAUDE.md`, `.claude/`,
   `~/.claude/CLAUDE.md`, `~/.claude/skills/`, `~/.claude/agents/`. If an
   artifact or a pending cluster covers the same failure, propose extending it
   and reuse its pattern slug. A tagged `<!--rule:slug-->` line is never the
   thing extended. The loop owns it; vote on it with `/feedback` instead.
4. **Pick a type, with the reason stated.**
   - rule: a short invariant that is always true in its scope.
   - skill: a procedure with a trigger ("before claiming no X, grep all of Y").
   - agent: a reusable role with its own context, such as a reviewer.
   - nudge: a reminder bound to a tool event, context only. Registered as
     `--type hook`, the ledger's name for it.
5. **Pick a scope.** Suggest one: a trap specific to this repo goes to the
   project, a behaviour that applies everywhere goes to `~/.claude/`. The
   operator confirms or changes it. A nudge has no scope choice: the hook only
   loads nudges from the world's `nudges_dir` in its target repo
   (`apps/hook/src/handlers.ts:136`). The agent writes the approved nudge JSON
   to a scratch file and `sil artifacts register` copies it into `nudges_dir`
   in the same commit as the ledger row, so it is live on that commit.
6. **Preflight, draft and show the diff.** Run `sil artifacts register ...
   --dry-run` with the path the artifact will be written to. It runs every
   refusal check and prints the ledger row it would commit, without writing.
   For a rule, skill or agent the file need not exist yet. A nudge draft is
   first written to a fresh `mktemp -d` directory, since register reads and
   lints it; that is the only write allowed before the yes, its contents are
   part of the diff shown, and the directory is removed after register or a
   no. Show the artifact diff and that row together. Write
   nothing yet. Wait for an explicit yes to both. A yes given before they were
   shown does not count.
7. **Write.** A file inside a git repo goes on a worktree branch, committed,
   never on the default branch directly. A file that only works at its
   installed path (`~/.claude/*`) is edited in place and committed on its own
   if that directory is a repo. Run the repo's dash lint when it has one.
8. **Register.** `sil artifacts register --world <w> --type <t> --pattern
   <slug> --path <absolute path> --note "<one-line lesson>"`. If `sil` is not
   on PATH, say the artifact is not recorded in the loop and stop. Never claim
   it was. If register refuses after the write (the target checkout moved off
   its default branch or got dirty under the artifact paths since the
   preflight), report the refusal verbatim and the exact command to re-run.

Report: the file written, the branch or commit, and the register result
verbatim.

Prompt guardrails: never edit a tagged `<!--rule:...-->` line, never write a
blocking hook, never put secrets or transcript excerpts with secrets into the
artifact.

## `sil artifacts register`

```
sil artifacts register --type rule|skill|agent|hook --pattern <slug>
                       --path <abs> --note <text> [--world <name>] [--dry-run]
```

World: `resolveWorld` from cwd unless `--world` is given (rule 6: filter by
world first). Slug: must pass `isSlug`, the same check as `artifactRel`.

### Ledger schema change

`PromotionEntry` gains three optional fields. Absent on every existing row, so old rows parse and save unchanged:

```ts
// Absent means "loop". Optional, not defaulted: a default would be written
// into every row on the next save and churn the whole ledger file.
origin: z.enum(["loop", "inline"]).optional(),
// Absolute path of an inline artifact outside the target repo. Never in
// served_by.path, which repair.ts reads as a repo-relative blob path.
external_path: z.string().optional(),
// One-line lesson for an inline row. The knowledge map uses it as the gist,
// since an inline rule lives in a whole CLAUDE.md, not a file of its own.
note: z.string().optional(),
```

The row register writes:

```ts
{
  pattern, status: "promoted", origin: "inline",
  artifact_type: type,
  // skill, agent, rule: the file lives outside the repo.
  served_by: { type, path: null }, external_path: abs,
  // hook: the nudge is copied into the repo, so it has a repo path instead.
  // served_by: { type: "hook", path: artifactRel(world, "hook", pattern) },
  promoted_at: now, revised_at: now,
  // Reflections already on disk for this pattern are the evidence that led
  // here, not new recurrence. Same count reject and retire use.
  promoted_at_count: max(prior?.promoted_at_count ?? 0,
    reflections(world).filter((r) => r.pattern === pattern).length),
  last_updated: now,
}
```

### Write path

`register()` lives in `@sil/review` next to reject and retire. It runs under
`withWorkerLock` and writes through `commitOnDefault`: one local commit on the
target repo's default branch, message `chore(ledger): register inline
<type> <pattern>`, with the note as its body. No push. That keeps rule 4: the operator approved the
artifact diff in the session, and nothing goes to a remote.

Refusals, each a non-zero exit with the reason:

- the slug fails `isSlug`;
- `--path` is not absolute, or the file does not exist (a `--dry-run` for a
  rule, skill or agent skips the existence check; a nudge draft must exist);
- the pattern already has a loop row with status `promoted`, or a curriculum
  branch `curriculum/<world>/<pattern>` exists (a staged loop row lives only
  on that branch). The loop owns it, so the operator votes or re-homes
  instead. A `rejected` or `retired` loop row may be replaced: a human already
  said no to the loop's version;
- `--type hook` and the file is not JSON, its `pattern` field is not the slug,
  or `lintHook` reports a problem;
- the pattern has an `inline` row with a different `external_path`. Re-running
  with the same path updates `revised_at` and `revisions`. That is the "extend
  an existing lesson" case.

### Planner and review guards

Inline rows must never be redrafted into the target repo. That would leave two
copies, one the loop rewrites and one it cannot see.

- `plan.ts`: a row with `origin: "inline"` plans as `done`, whatever its
  recurrence. A scorecard proposal of `refine` or `retire-candidate` is still
  reported, tagged `inline: edit <external_path> by hand`.
- `run.ts`: refuses to stage a pattern whose live row is `inline`, right after
  `prior` is read (`run.ts:288`). A second lock in case a plan bug lets one
  through.
- `review accept`: refuses when the live row is `inline`, so an older staged
  branch cannot overwrite it. `register` already refuses while such a branch
  exists; this covers a branch created after.
- `review retire|rehome`: refuse an inline row and print `external_path`.
- `repair.ts`: skips inline rows explicitly. Today it would still compute
  dates for them from ledger history.
- `feedback` `propose()`: never `retire-candidate` for an inline rule, since
  its usage is not counted. Complaints can still propose `refine`.
- `context.ts`: an inline row's gist is its `note`, so drafts of neighbouring
  patterns see the lesson text for dedupe.
- `RouterRow` gains `origin`, and `inventory()` puts `external_path` in its
  `served_by` column when set. `sil artifacts` prints `origin=inline`. The web
  Artifacts pane already renders `served_by`, so it needs no change.

## Usage and feedback

| Type | Counted | How |
| --- | --- | --- |
| skill | yes | `Skill` tool ref `skill:<name>`, so the skill directory name must equal the slug |
| agent | yes | `Agent` ref `agent:<subagent_type>`, so the agent name must equal the slug |
| hook (nudge) | yes | the nudge fire log, ref `hook:<pattern>` from the JSON `pattern` field, so that field and the file name must equal the slug |
| rule | no | see below |

The procedure enforces "name equals slug" in step 5. `/feedback <type>:<slug>
good|bad` works for all four.

## Known gaps

- **Inline rules get no usage count.** Rule usage is the tagged line in the
  block the loop injects (`apps/hook/src/handlers.ts:82`). An inline rule lives
  in CLAUDE.md, which Claude Code loads itself, and it must stay untagged
  because the loop rewrites tagged lines. Its scorecard shows `uses_30d 0`, and
  the planner must not read that as a retire signal for `origin: "inline"` rules.
  `propose()` skips zero-use retirement for them. A later change could add an
  `<!--lesson:slug-->` tag that the SessionStart hook counts from CLAUDE.md
  files.
- **Same failure, different slug.** If the critic later names the same failure
  differently, a loop cluster can grow beside the inline artifact. Step 3's
  `sil curriculum plan` check catches the clusters that exist today. A later one
  needs `sil aliases` like any other duplicate.
- **Codex nudges.** Codex runs no loop hooks, so a nudge written from Codex
  only fires in Claude Code sessions.

## Testing

- `packages/core`: old ledger rows parse with `origin`, `external_path` and
  `note` absent, and a save writes none of those keys. A V1 fixture still
  round-trips.
- `packages/review` `register()`:
  - writes exactly one commit on the default branch, and the target repo's
    working tree is unchanged;
  - refuses each case in "Refusals";
  - re-running with the same path bumps `revisions` and does not create a
    second row;
  - refuses while the worker lock is held.
- `packages/curriculum`: with an inline row and enough new reflections to pass
  `threshold`, `plan` returns `done` and `run` stages nothing. A fixture with a
  `loop` row and the same counts still refines, as the control.
- `review retire` and `rehome` on an inline row: refuse, exit non-zero, name
  the path.
- `apps/cli`: `sil artifacts register` argument parsing, and `sil artifacts`
  output shows `origin=inline`.
- `tests/e2e.test.ts`: register an inline skill, invoke the `Skill` tool via
  the hook bundle, rebuild scorecards, and assert `uses_30d 1` for
  `skill:<slug>`. One run through real modules.
- Tests that spawn processes build `env` from tmp dirs, and worker tests set
  `worker.auto_kick` off (CLAUDE.md traps).
- The prompt files have no unit test. Acceptance is a manual run: in a scratch
  session, reproduce an "are we doing X" miss, run `/learn`, and check the
  confirm, diff, write and register steps happen in order with nothing written
  before the yes.

## Docs

- `docs/ARCHITECTURE.md`: one section on inline artifacts and the three ledger
  fields.
- `docs/OPERATIONS.md`: `/learn` and `sil artifacts register`.
- `README.md` command table.
- `.ai/todo.md`, `.ai/lessons.md` when it lands.
