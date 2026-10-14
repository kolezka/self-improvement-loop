# Capture a lesson from this session

In Codex there is no slash command; the operator asks to capture a lesson and
you follow this file. In Claude Code, `/learn [note]` sends you here. Follow
the steps in order. Do not skip a confirmation. Every `sil` call after step 2
passes `--world <w>`, the world the operator confirmed.

## 1. Locate

Find the correction in the conversation: the operator's question, your wrong
answer, and the evidence that contradicted it. A note from the operator, when
given, overrides your guess. State the failure in one sentence, then the check
that would have caught it. Wait for the operator to confirm: a wrong reading
here poisons every later step.

## 2. Pick the world

Run `sil status` and `sil worlds list`. Propose the world whose target this
lesson belongs to, and get it confirmed. Never rely on cwd resolution: it can
record a global lesson in an unrelated project's world.

## 3. Dedupe

Run these (no model calls):

```sh
sil artifacts --world <w> --json
sil curriculum plan --world <w>
```

Then `rg` the candidate targets: the project `CLAUDE.md`, `.claude/`,
`~/.claude/CLAUDE.md`, `~/.claude/skills/`, `~/.claude/agents/`. If an artifact
or a pending cluster covers the same failure, propose extending it and reuse
its pattern slug. Never extend a tagged `<!--rule:slug-->` line: the loop owns
it, so vote on it with `/feedback`.

## 4. Pick a type, and state the reason

- rule: a short invariant that is always true in its scope.
- skill: a procedure with a trigger ("before claiming no X, grep all of Y").
- agent: a reusable role with its own context, such as a reviewer.
- nudge: a tool-event reminder, context only; register it as `--type hook`.

## 5. Pick a scope

Suggest one: a trap specific to this repo goes to the project, a behaviour that
applies everywhere goes to `~/.claude/`. The operator confirms or changes it.
If the project repo is also the world's target repo, a rule, skill or agent
cannot live there (register refuses paths inside the target repo): use
`~/.claude/`, or let the loop handle it via `/reflect`. A nudge has no scope
choice: the hook only loads nudges from the world's `nudges_dir` in its target
repo. Write the nudge JSON to a scratch file; register copies it into
`nudges_dir` in the same commit as the ledger row.

## 6. Preflight, draft and show the diff

For a rule, skill or agent, `--path` is the final absolute path in the
project's main checkout or in `~/.claude/`, never a worktree path. The file
need not exist yet. A skill directory name and an agent name must equal the
pattern slug. For a nudge, write the draft JSON into a fresh `mktemp -d`
directory and use that path: register reads and lints it. That scratch file is
the only write allowed before the yes. Run the preflight:

```sh
sil artifacts register --world <w> --type <rule|skill|agent|hook> \
  --pattern <slug> --path <absolute path> --note "<one-line lesson>" --dry-run
```

It runs every refusal check and prints the ledger row it would commit, without
writing. Show the operator the artifact diff (for a nudge, the scratch JSON)
and that row. Write nothing else. Wait for an explicit yes to both; a yes
before they were shown does not count. On a no, delete the scratch directory
and stop.

## 7. Write

Commit a file inside a git repo on a worktree branch, never on the default
branch directly. Edit in place a file in a project directory without git, or
one that only works at its installed path (`~/.claude/*`); commit the latter on
its own if its directory is a repo. Run the repo's dash lint when it has one.
Register copies a nudge in step 8.

## 8. Register

Register with the step 6 preflight minus `--dry-run`. Do it now for a nudge
(register commits it) or a file edited in place (under `~/.claude/`, or in a
project directory without git). A project artifact in a git repo, new or
edited, is on a branch: do not register yet. Report the branch and the exact
command; do not merge or push it yourself. When the operator says it is merged,
check it landed. Either exit 0 counts (the second covers squash and rebase):

```sh
git -C <repo> merge-base --is-ancestor <branch> <default-branch>
git -C <repo> diff --quiet <branch> <default-branch> -- <repo-relative path>
```

`<repo-relative path>` is `--path` with `<repo>/` removed; never type it by
hand. Register only if one exits 0. Otherwise report the pending command, do
not register, and tell the operator to pull the default branch locally first if
they merged remotely. Never claim it is recorded before register succeeds.

If `sil` is not on PATH (try `~/.local/bin/sil`, and in Claude Code
`"${CLAUDE_PLUGIN_ROOT}/scripts/sil"`), say so and stop. If register refuses
(for example, the target checkout moved off its default branch, or got dirty
under the artifact paths since the preflight), report the refusal verbatim and
the exact command to re-run.

For a nudge, remove the scratch directory only after register succeeds or the
operator says no. If register refuses, keep it: the retry needs the same
approved bytes at the same path. Report its path with the retry command, and
tell the operator to delete it after a successful retry or once they give up.

## Guardrails and report

Never edit a tagged `<!--rule:...-->` line. Never write a blocking hook. Never
put secrets, or transcript excerpts that contain secrets, into the artifact.

Tell the operator three things: the file written, the branch or commit, and
the register result verbatim, or the pending register command if not run yet.
