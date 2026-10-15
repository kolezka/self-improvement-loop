# Turn a working answer into a reusable skill

In Codex there is no slash command; the operator asks to save the last answer
as a tool and you follow this file. In Claude Code, `/toolify [note]` sends you
here. The result is a skill: a SKILL.md that lets a later session repeat the
work (a query, a sequence of API calls, a set of commands) without finding it
again. Follow the steps in order. Do not skip a confirmation. Every `sil` call
after step 2 passes `--world <w>`, the world the operator confirmed.

## 1. Locate

Find the most recent answer in the conversation that worked. A note from the
operator, when given, says which one and overrides your guess. Extract only
facts that tool output in this session confirmed:

- what the operator wanted, in one sentence;
- the exact query, request or commands, in the order they ran;
- fixed values: IDs, URLs, endpoints, data sources, table and column names;
- values that change between runs (dates, names, limits), as parameters;
- what a good result looked like.

If several attempts ran, keep only the one that worked. Drop anything you
inferred but never ran. Show this summary and wait for the operator to confirm
it: a wrong fact here becomes a skill that repeats the mistake.

## 2. Pick the world

Run `sil status` and `sil worlds list`. Propose the world this tool belongs to
and get it confirmed. Never rely on cwd resolution.

## 3. Dedupe

Run `sil artifacts --world <w> --json`, then `rg` the skill directories:
`~/.claude/skills/` and the project's `.claude/skills/`. If a skill already
covers the same task, propose extending it and reuse its slug.

## 4. Pick a scope and a slug

Suggest one: a tool tied to this project's systems goes to the project
(`<project>/.claude/skills/<slug>/SKILL.md`), one useful everywhere goes to
`~/.claude/skills/<slug>/SKILL.md`. The operator confirms or changes it. The
slug is lowercase words joined by hyphens, names the task (`redash-latest-releases`),
and is the pattern slug, the directory name and the frontmatter `name`. If the
project repo is also the world's target repo, register refuses a path inside
it: use `~/.claude/skills/`.

## 5. Draft

Write the skill in this shape:

````markdown
---
name: <slug>
description: Use when <the request that should trigger it, in the operator's words>.
---

# <Title>

<One sentence: what it produces.>

## Parameters

- `<name>`: <meaning>, default `<value>`.

## Steps

1. <Exact step.>

```<lang>
<the exact query or command that worked, with parameters marked>
```

## Expected result

<What a correct result looks like, so a wrong one is noticed.>

## When it stops working

<What to check first: the ID, the schema, the endpoint, the access.>
````

The `description` must contain "Use when" and name the request, not the
implementation. Keep the query byte for byte as it ran, except for the
parameters. Never write a secret: a token, key or password becomes the name of
the environment variable that holds it (`$REDASH_API_KEY`). Leave out
transcript excerpts that contain secrets or personal data.

## 6. Preflight and show the diff

`--path` is the final absolute path of SKILL.md, never a worktree path. The
file need not exist yet. Run:

```sh
sil artifacts register --world <w> --type skill \
  --pattern <slug> --path <absolute path to SKILL.md> \
  --note "<one line: what the tool does>" --dry-run
```

Show the operator the full SKILL.md and the ledger row. Write nothing yet.
Wait for an explicit yes to both; a yes before they were shown does not count.
On a no, stop.

## 7. Write and register

Follow steps 7 and 8 of `learn.md` next to this file: a project file in a git
repo goes on a worktree branch and is registered only after it merges; a file
under `~/.claude/` is written in place and registered now. Run the repo's dash
lint when it has one.

## Report

Tell the operator four things: the file written, the branch or commit, the
register result verbatim (or the pending register command), and the request
that will trigger the skill. Mention that `/feedback skill:<slug> bad` records
a misfire when the tool goes stale.
