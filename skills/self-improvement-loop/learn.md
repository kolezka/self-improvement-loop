# Capture a lesson from this session

In Codex there is no slash command; the operator asks to capture a lesson and
you follow this file. In Claude Code, `/learn [note]` sends you here.

Follow the steps in order. Do not skip a confirmation. Every `sil` call after
step 2 passes `--world <w>`, the world the operator confirmed.

## 1. Locate

Find the correction in the conversation: the operator's question, your wrong
answer, and the evidence that contradicted it. A note from the operator, when
given, overrides your guess. State the failure in one sentence. State the
check that would have caught it in a second sentence. Wait for the operator to
confirm. A wrong reading here poisons every later step.

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
`~/.claude/CLAUDE.md`, `~/.claude/skills/`, `~/.claude/agents/`. If an
artifact or a pending cluster covers the same failure, propose extending it
and reuse its pattern slug. Never extend a tagged `<!--rule:slug-->` line. The
loop owns it; vote on it with `/feedback` instead.

## 4. Pick a type, and state the reason

- rule: a short invariant that is always true in its scope.
- skill: a procedure with a trigger ("before claiming no X, grep all of Y").
- agent: a reusable role with its own context, such as a reviewer.
- nudge: a reminder bound to a tool event, context only. Register it as
  `--type hook`, the ledger's name for it.

A skill directory name and an agent name must equal the pattern slug.

## 5. Pick a scope

Suggest one: a trap specific to this repo goes to the project, a behaviour
that applies everywhere goes to `~/.claude/`. The operator confirms or changes
it. A nudge has no scope choice: the hook only loads nudges from the world's
`nudges_dir` in its target repo. You write the nudge JSON to a scratch file,
and `sil artifacts register` copies it into `nudges_dir` in the same commit as
the ledger row.

## 6. Preflight, draft and show the diff

Decide the final absolute path the artifact will be written to. For a rule,
skill or agent the file need not exist yet. For a nudge, write the draft JSON
into a fresh `mktemp -d` directory and use that path: register reads and lints
it. That scratch file is the only write allowed before the yes.

Run the preflight:

```sh
sil artifacts register --world <w> --type <rule|skill|agent|hook> \
  --pattern <slug> --path <absolute path> --note "<one-line lesson>" --dry-run
```

It runs every refusal check and prints the ledger row it would commit,
without writing. Show the operator the artifact diff (for a nudge, the scratch
file contents) and that row together. Write nothing else. Wait for an explicit
yes to both. A yes given before they were shown does not count. On a no,
remove the scratch directory and stop.

## 7. Write

A file inside a git repo goes on a worktree branch, committed, never on the
default branch directly. A file that only works at its installed path
(`~/.claude/*`) is edited in place, and committed on its own if that directory
is a repo. Run the repo's dash lint when it has one. A nudge is not written
here: register copies it in step 8.

## 8. Register

```sh
sil artifacts register --world <w> --type <rule|skill|agent|hook> \
  --pattern <slug> --path <absolute path> --note "<one-line lesson>"
```

If `sil` is not on PATH (try `~/.local/bin/sil`, and in Claude Code
`"${CLAUDE_PLUGIN_ROOT}/scripts/sil"`), say the artifact is not recorded in the
loop and stop. Never claim it was. If register refuses (for example, the
target checkout moved off its default branch, or got dirty under the artifact
paths since the preflight), report the refusal verbatim and the exact command
to re-run.

For a nudge, remove the scratch directory only after register succeeds or the
operator says no. If register refuses, keep it: the retry needs the same
approved bytes at the same path. Report the directory's path with the retry
command, and tell the operator to delete it after a successful retry or once
they give up.

## Guardrails

Never edit a tagged `<!--rule:...-->` line. Never write a blocking hook. Never
put secrets, or transcript excerpts that contain secrets, into the artifact.

## Report

Tell the operator three things: the file written, the branch or commit, and
the register result verbatim.
