# Web UI design plan

Subject: `sil` is a local operator console for a background agent that watches
coding sessions, writes reflections, clusters them into patterns and stages
artifacts for a human to accept. Audience: the engineer running it, plus the
people they show it to. Primary job: triage. Is the loop alive, what did it
learn, what is waiting for me, accept or reject it.

## Color

Six named values per scheme. Paper and graphite base, one petrol signal, three
status colors. Petrol reads as instrumentation and keeps the default product
blue (#2563eb) and the warm clay accent out of the picture.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--bg` | `#f7f7f5` | `#12161a` | page |
| `--surface` | `#ffffff` | `#171c21` | panels, rows |
| `--fg` | `#16191c` | `#e3e7ea` | text |
| `--muted` | `#5f6a73` | `#94a0aa` | secondary text |
| `--accent` | `#0d6f72` | `#4cc2bd` | petrol signal, focus, active nav |
| `--ok` / `--warn` / `--err` | `#2f7a43` / `#9a6408` / `#b2372c` | `#79c47c` / `#e0a95c` / `#ee7a6f` | status only |

## Type

One family for the interface (system sans), one for machine text
(`ui-monospace`). Monospace is restricted to content a person may copy or
compare: paths, ids, model names, diffs, log lines. It never labels anything.
Scale: 0.75 / 0.8125 / 0.875 / 1 / 1.25 / 1.625 rem, weights 400/500/600.
Sentence case everywhere, no tracked-out caps, no eyebrow labels.

## Layout

A narrow left rail groups the nine panes by what the operator is doing
(Watch, Decide, Configure). The content column carries a sticky head with the
pane title, a one-line description, the world selector and a live worker dot.
Master and detail panes keep a two-column split with a sticky detail side.

```
+---------------+--------------------------------------------------+
| sil  (o) idle |  Review                      world [default v]   |
|               |  Accept or reject staged proposals               |
| Watch         +--------------------------------------------------+
|  Overview     |  +-------------+  +---------------------------+  |
|  Queue        |  | staged list |  | proposal, diff, actions   |  |
|  Reflections  |  |             |  |                           |  |
| Decide        |  |             |  |                           |  |
|  Review   (3) |  |             |  |                           |  |
|  Artifacts    |  +-------------+  +---------------------------+  |
| Configure     |                                                  |
|  Loop, Models |                                                  |
|  Worlds, Logs |                                                  |
+---------------+--------------------------------------------------+
```

Overview leads with the one bold element: the loop drawn as a loop.

```
 sessions      reflections     patterns       waiting        live
 waiting                        ready        for review    artifacts
 [  4  ] ----- [  128  ] ----- [   2   ] === [   3   ] ==== [  11  ]
   ^                                            gate                |
   |                                                                |
   +------- 5 lessons queued for your next session -----------------+
```

Alignment is left throughout. Numbers are tabular and right aligned in tables.

## Principles

1. Density over whitespace. This is an instrument, not a landing page.
2. Spend boldness once: the loop band on Overview. Every other pane is quiet.
3. Structure carries state. A left border color means severity, a pill means
   lifecycle state, the review gate is tinted only while it holds work.
4. Empty states say what to do next, errors say how to fix the problem.
5. Buttons name their effect: "Run worker", "Accept proposal", "Save models".

## Critique against generic defaults

- Not cream plus terracotta, not near black plus acid green, not a broadsheet,
  not one rounded card style repeated for every block. Panels, rows, chips and
  the loop band each get their own radius and weight.
- No all caps labels, no middle dot meta strings (the Models pane had them), no
  arrow glyphs appended to buttons, no monospace used as decoration.
- A left rail plus top bar is itself the admin default, so the identity comes
  from what sits inside it: the loop band, the petrol palette, the density, and
  a wordmark that doubles as the worker state light. The rail stays typographic
  with grouped verbs instead of an icon strip.
- The stage numbering on Overview is justified because the content really is a
  sequence: a session becomes a reflection, a reflection joins a pattern, a
  pattern at threshold becomes a staged proposal, an accepted proposal becomes
  an artifact, and the lesson returns to the next session.
