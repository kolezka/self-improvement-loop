# OpenClaw Skill Workshop and sil

Status: analysis and proposals, 2026-10-31. Nothing here is approved for
implementation yet; open decisions are listed at the end.

OpenClaw has its own learning loop, Skill Workshop with Self-learning. This page
compares it with sil, lists what sil should take from it, what it must not take,
and how the two should split the work on an OpenClaw host such as Synergy.

## Sources

- Workshop: the docs bundled with the installed OpenClaw 2026.10.8 (dc2523e) on
  Synergy, `docs/tools/skill-workshop.md` and `docs/tools/self-learning.md`, read
  on the host on 2026-10-31. Live docs on docs.openclaw.ai can differ: they still
  describe a draft-and-approve mode that 2026.10.8 removed (see below).
- Synergy state (read only, names and counts, no content): agent
  `software-factory` has 140 learned skills under
  `~/.openclaw/agents/software-factory/agent/workshop-skills/`; the shared
  `skills.load.extraDirs` is `~/.openclaw/skills-live` with 54 entries (a real
  directory, not a link to `synergy-brain/skills`); `skills.workshop.autonomous.mode`
  is unset, so the default `auto` applies.
- sil: this repo and `docs/ARCHITECTURE.md`.

Not verified: how Workshop behaves in practice on Synergy (change rate, quality
of learned skills). The comparison is from docs and listings.

## What Workshop is (2026.10.8)

- Learned skills are procedures for one agent. Facts go to memory; knowledge about
  a codebase goes to that repo's docs or `AGENTS.md`, not into learned skills.
- Learned skills are always visible to their agent and bypass the agent's skill
  allowlists. Workspace, managed, ClawHub, plugin and bundled skills are not
  Workshop skills and are edited at their source.
- The agent learns in four ways: in the same turn (patches a skill that misled it,
  or saves a procedure after hard multi-step work); a background review after 10
  model iterations in a session, or right after a turn that used a learned skill;
  `/learn`; and "Learn from history" in the Control UI.
- The background review forks the conversation and reuses the foreground provider,
  model and auth, with model fallbacks off. It can only change things through the
  `skill_workshop` tool and never re-runs the task.
- Every change applies at once, is announced in the conversation and can be
  undone. A version is saved before every change; the newest 10 per skill are
  kept, and a change feed keeps the newest 500 entries per agent.
- Learned skills unused for 30 days are archived.
- On `create`, the agent sees its other learned skills and decides itself whether
  to merge.
- Surfaces: Control UI page Plugins, Skill workshop (diff, history, Undo, Archive,
  Restore); `openclaw skills workshop list | changes | show | archive | restore`;
  Gateway methods `skills.workshop.list`, `.changes`, `.read` (`operator.read`)
  and `.archive`, `.restore` (`operator.admin`); the `skill_changed` plugin hook.
- Earlier releases staged drafts for review. 2026.10.8 removed that: `openclaw
  doctor --fix` exports pending drafts, and the `skills.proposals.*` methods and
  the `skill_proposal_*` hooks are gone.

## Comparison

| | Skill Workshop | sil |
| --- | --- | --- |
| Output | Learned skills (procedures) only | Rules, lessons, skills; hooks, agents and nudges on Claude Code only |
| Scope | One agent | A world: many sessions and agents |
| When it learns | Same turn, background review every 10 iterations or after a skill use, `/learn`, history | After a session ends, one critic reflection; curriculum promotes a recurring pattern |
| Human gate | None; undo afterwards | Required; accept is bound to the `reviewed_state` digest |
| Duplicates | The agent decides on `create` | Critic sees existing artifacts, today only the world's Claude Code `skills_dir` |
| Removal | Automatic archive after 30 idle days | Human retire; the planner surfaces `retire-candidate` (`packages/curriculum/src/plan.ts:462`) |
| History | 10 versions per skill, change feed, Undo | An accepted redraft overwrites the artifact |
| Cost | Foreground model, every eligible session | One reflection per session on the configured model |
| Proof it helps | None, the review does not re-run the task | Recurrence after promotion, usage, votes |

Where they overlap: both write skills from sessions. Two writers of the same kind
of skill for the same agent produce duplicates and conflicting procedures.

What only Workshop has: a fix in the same turn, a native diff and Undo UI, and
automatic cleanup.

What only sil has: a human gate, rules that reach every turn, and patterns across
many sessions and agents.

## Proposed split of roles on an OpenClaw host

- Workshop stays the agent's fast procedural memory. sil does not write learned
  skills and does not create single-agent procedure skills.
- sil does rules and lessons, and shared skills that span agents. Shared skills
  reach the host as a pull request to the repo that owns the shared skill
  directory, reviewed by a human.
- sil adds the review layer Workshop lacks: it reads Workshop changes
  (`skill_changed`, `skills.workshop.changes`) and shows them in the console, and
  flags a learned skill when the error pattern it was meant to fix keeps coming
  back after it was used. Restore and archive from the console call the Gateway
  methods and need `operator.admin`.

## What sil should take from Workshop

1. Version history and Restore for accepted artifacts. Save the previous version
   before every accept, show a diff in the console, and restore through the same
   human accept with a digest. This closes the known proposal-overwrite and
   evidence-loss gaps found in the cumulative learning review (Outline task
   `cumulative-learning-review`). Size: medium.
2. Review after use. When a session used artifact X and the same error pattern
   came back, the reflection gets "X was active" in its evidence and the planner
   marks X for refinement. This is the one way to tell whether an artifact helps.
   Size: medium.
3. One change feed in the console: accept, reject, retire, restore, with who, when
   and why. Today the receipts are spread out. Size: small.
4. Non-blocking authoring advisories on drafts in Review: description over 160
   bytes, body over 250 lines or 12 KB, three or more "Never" steps. Size: small.
5. A console action that reflects on selected past sessions, like "Learn from
   history". The CLI already has import and backfill. Size: small.
6. One skill inventory for the drafter, across Claude Code skills, OpenClaw shared
   skills and Workshop learned skills, so a draft refines instead of duplicating.
   Size: small. Already part of the OpenClaw plugin plan.

Recommended first: 1, 2 and 6.

## What sil must not take

- Applying a change with no human in between. Breaks design rule 4.
- Automatic archive of unused artifacts. Breaks rule 5; sil already surfaces
  `retire-candidate` for a human instead.
- A background review on the conversation's own model every few iterations.
  Breaks rule 2 (one critic, in the worker) and costs a foreground-model call per
  review.
- Self-edit in the same turn. A Claude Code hook may not call a model (rule 1);
  `/learn` already covers an explicit request.

## Open decisions

- Whether the split of roles above is accepted for Synergy.
- Whether items 1 and 2 go on their own branch (proposed: they are generic sil
  features, not Synergy specific) or into `feat/openclaw-sdk-plugin`. Item 6 stays
  in the OpenClaw plugin plan either way.
