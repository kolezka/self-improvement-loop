// Draws the Lessons view inside Activity from ./lessons.ts. Drawing only reads:
// every control hands its action to lessonsAct or lessonsInput, and a related
// proposal opens through the parent's consoleAct into the read-only Review.
//
// Everything shown from the store or the person is data: made printable and
// bounded here, never interpreted. Inputs are drawn with the editor's current
// text, so a redraw shows what was typed and never an older value.

import type { EngineInterface, RenderElement, RenderSurface } from "claude-code";
import { flatProject } from "@sil/core/curation-client";
import { isLessonEditorStale } from "@sil/core/lesson-curation-ui";
import { encodeLessonKey } from "@sil/core/lesson-curation";
import { consoleAct } from "./register.ts";
import {
  editorErrorText,
  LESSON_FILTERS,
  MAX_FIELD_CHARS,
  lessonsAct,
  lessonsInput,
  lessonsViewModel,
  type LessonAction,
  type LessonFilter,
  type LessonsViewModel,
} from "./lessons.ts";
import { NARROW_COLUMNS, printable } from "./views.ts";

const FILTER_LABELS: Record<LessonFilter, string> = { saved: "Saved", inbox: "Delivery inbox", archived: "Archived", important: "Important" };
const ROW_CHARS = 200;
const TEXT_CHARS = 4000;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Project choices drawn at once; the rest are a window away. */
export const PROJECT_WINDOW = 24;

/** Beside a field whose typed text was dropped: it now shows older text. */
function dropNote(name: string): string {
  return `The ${name} you typed was over ${MAX_FIELD_CHARS} characters and was not kept. This field shows the earlier text; edit it before saving.`;
}

function shown(text: string, max = ROW_CHARS): string {
  const p = printable(text).text;
  return p.length > max ? `${p.slice(0, max)}... (shortened)` : p;
}

/** The transcript in view, from the pane's props, or null when not given. */
export function paneView(props: unknown): { agentId?: string } | null {
  if (typeof props !== "object" || props === null) return null;
  const view = (props as { view?: unknown }).view;
  if (typeof view !== "object" || view === null || Array.isArray(view)) return null;
  const agentId = (view as { agentId?: unknown }).agentId;
  if (agentId === undefined) return {};
  return typeof agentId === "string" ? { agentId } : null;
}

/** The element table `$.ui.resolve(e)` gives: one per surface in the real contract. */
type Ui = ReturnType<EngineInterface["ui"]["resolve"]>;
type InputElement = Extract<Ui, { Input?: unknown }>["Input"];

export async function drawLessons(
  $: EngineInterface,
  ui: Ui,
  e: { surface: RenderSurface; props: unknown },
  world: string | null,
  columns: number,
): Promise<RenderElement> {
  const { Box, Text, Button } = ui;
  // By the surface, as render.tsx picks Select: mobile has no Input.
  const Input: InputElement | undefined = e.surface !== "mobile" && "Input" in ui ? (ui.Input as InputElement) : undefined;
  const Select = e.surface !== "mobile" && "Select" in ui ? ui.Select : undefined;
  // Read while drawing, so every write of the lesson state draws this again.
  await $.state.get({ plugin: "self-improvement-loop", key: "lessons" });
  const vm = lessonsViewModel();
  const narrow = columns < NARROW_COLUMNS;
  const direction = narrow ? "column" : "row";
  const view = paneView(e.props);

  const act = (action: LessonAction) => () => {
    void lessonsAct($, action, world).then((done) => {
      if (done.switchWorld !== null) consoleAct($, { kind: "world", world: done.switchWorld });
    });
  };
  const button = (key: string, label: string, action: LessonAction): RenderElement => <Button key={key} label={label} onPress={act(action)} />;
  const line = (text: string, tone: "plain" | "dim" | "error" | "title" = "plain", max = ROW_CHARS): RenderElement => {
    const t = shown(text, max);
    if (tone === "error") return <Text color="error">{`Error: ${t}`}</Text>;
    if (tone === "dim") return <Text dimColor>{t}</Text>;
    if (tone === "title") return <Text bold>{t}</Text>;
    return <Text>{t}</Text>;
  };
  const row = (children: RenderElement[]): RenderElement => <Box flexDirection={direction} gap={1}>{children}</Box>;

  if (!vm.open) {
    return (
      <Box flexDirection="column">
        {line("Curated lessons: capture, edit wording and mark important.", "dim")}
        {row([button("lessons-open", "Open lessons", { kind: "open" }), button("lesson-capture", "Capture selection", { kind: "capture", view })])}
      </Box>
    );
  }

  const out: RenderElement[] = [line("Curated lessons", "title")];
  out.push(row([button("lessons-close", "Close lessons", { kind: "close" }), button("lessons-refresh", "Refresh lessons", { kind: "refresh" })]));
  if (vm.restoreNote !== null) out.push(line(vm.restoreNote, "error"));
  if (vm.persistWarning !== null) out.push(line(vm.persistWarning, "error"));
  if (world === null) {
    out.push(line("Choose a world to see its curated lessons.", "dim"));
    return <Box flexDirection="column">{out}</Box>;
  }
  // Bound to the world it was opened in: a console world change made without a
  // person (the bootstrap) does not move it, and any action asks first when dirty.
  if (vm.world !== null && vm.world !== world) out.push(line(`These lessons are from world ${vm.world}. Refresh lessons to follow the console to ${world}.`, "error"));
  if (vm.handshakeError !== null) out.push(line(vm.handshakeError, "error"));
  if (vm.block !== null) out.push(line(vm.block, "error"));
  if (vm.notice !== null) out.push(line(vm.notice.text, vm.notice.tone === "error" ? "error" : vm.notice.tone === "ok" ? "plain" : "dim"));
  if (vm.reading) out.push(line("Reading lessons...", "dim"));
  if (vm.prompt !== null || vm.editor.blocked !== null) {
    out.push(line("This lesson has unsent wording. Stay to keep editing, or Discard it and continue.", "error"));
    out.push(row([button("lesson-stay", "Stay", { kind: "stay" }), button("lesson-discard", "Discard", { kind: "discard" })]));
  }

  // Project, filters and search. While a save is in flight the project stays put.
  const value = vm.project === null ? undefined : flatProject(vm.project);
  const currentChoice = vm.project === null ? undefined : vm.choices.find((c) => flatProject(c.scope.project) === value);
  if (vm.sending && vm.choices.length > 0) {
    out.push(line(`Project: ${currentChoice?.label ?? "none chosen"} (held while the save runs).`, "dim"));
  } else if (vm.choices.length > 0) {
    // A window of choices, the current one always among them, so the drawn
    // tree stays bounded however many projects the host lists.
    const all = vm.choices.map((c) => ({ value: flatProject(c.scope.project), label: shown(`${c.label}${c.available ? "" : " (unavailable here)"}`) }));
    const last = Math.max(0, Math.floor((all.length - 1) / PROJECT_WINDOW) * PROJECT_WINDOW);
    const from = Math.min(vm.projectOffset - (vm.projectOffset % PROJECT_WINDOW), last);
    const options = all.slice(from, from + PROJECT_WINDOW);
    const current = all.find((o) => o.value === value);
    if (current !== undefined && !options.includes(current)) options.push(current);
    if (all.length > PROJECT_WINDOW) out.push(line(`Projects ${from + 1}-${Math.min(from + PROJECT_WINDOW, all.length)} of ${all.length}.`, "dim"));
    if (Select !== undefined) {
      out.push(
        value === undefined ? (
          <Select key="lessons-project" label="Project" options={options} onSelect={(v: string) => act({ kind: "project", project: v })()} />
        ) : (
          <Select key="lessons-project" label="Project" options={options} value={value} onSelect={(v: string) => act({ kind: "project", project: v })()} />
        ),
      );
    } else {
      out.push(row(options.map((o, i) => button(`lessons-project-${i}`, o.value === value ? `${o.label} (current)` : o.label, { kind: "project", project: o.value }))));
    }
    const windows: RenderElement[] = [];
    if (from > 0) windows.push(button("lessons-projects-prev", "Previous projects", { kind: "projects", offset: Math.max(0, from - PROJECT_WINDOW) }));
    if (from + PROJECT_WINDOW < all.length) windows.push(button("lessons-projects-next", "More projects", { kind: "projects", offset: from + PROJECT_WINDOW }));
    if (windows.length > 0) out.push(row(windows));
  }
  if (vm.contextNote !== null) out.push(line(vm.contextNote, "dim"));
  if (vm.project === null && vm.choices.length > 0) out.push(line("Choose a project to see its lessons.", "dim"));
  out.push(row(LESSON_FILTERS.map((f) => button(`lessons-filter-${f}`, vm.filter === f ? `${FILTER_LABELS[f]} (current)` : FILTER_LABELS[f], { kind: "filter", filter: f }))));
  if (Input !== undefined) {
    out.push(
      <Input
        key="lessons-search"
        label="Search"
        value={vm.searchDraft ?? vm.search}
        submitLabel="search"
        onInput={(v: string) => void lessonsInput($, "search", v, "change")}
        onSubmit={(v: string) => void lessonsInput($, "search", v, "submit")}
      />,
    );
  } else {
    out.push(line("This surface has no text field: search, capture and edit with `sil web`.", "dim"));
  }
  if (!vm.sending) out.push(row([button("lesson-capture", "Capture selection", { kind: "capture", view })]));
  if (vm.captureNote !== null) out.push(line(vm.captureNote, "dim"));

  // The list.
  if (vm.listError !== null) out.push(line(`Lessons unavailable: ${vm.listError}`, "error"));
  if (vm.list !== null) {
    const l = vm.list;
    out.push(line(l.total === 0 ? `No ${FILTER_LABELS[vm.filter].toLowerCase()} lessons here.` : `${FILTER_LABELS[vm.filter]}, page ${vm.page}: ${l.items.length} shown of ${l.total}, read ${l.readAt}.`, "dim"));
    // One page at a time. While a save is in flight rows are shown, not opened.
    const label = (item: (typeof l.items)[number]) => shown(`${item.important ? "[important] " : ""}${item.effectiveText ?? item.originalText ?? "(no text)"} (${item.sourceStatus})`);
    const rows = l.items.map((item, i) => (vm.sending ? line(label(item), "dim") : button(`lesson-row-${i}`, label(item), { kind: "record", index: i })));
    if (rows.length > 0) out.push(<Box flexDirection="column">{rows}</Box>);
    const pages: RenderElement[] = [];
    if (vm.page > 1) pages.push(button("lessons-first", "First page", { kind: "first" }), button("lessons-prev", "Previous page", { kind: "prev" }));
    if (l.nextCursor !== null) pages.push(button("lessons-more", "Next page", { kind: "more" }));
    if (pages.length > 0) out.push(row(pages));
  }

  const field = (name: "text" | "quote" | "reference") => ({
    change: (v: string) => void lessonsInput($, name, v, "change"),
    submit: (v: string) => void lessonsInput($, name, v, "submit"),
  });
  // A related proposal opens in the parent's read-only Review, at its pattern.
  const related = (pattern: string): RenderElement => (
    <Button
      key="lesson-related"
      label={`Open related proposal ${shown(pattern, 64)} in Review`}
      onPress={() => {
        consoleAct($, { kind: "section", section: "review" });
        consoleAct($, { kind: "select", pattern });
      }}
    />
  );
  out.push(...editorBlocks(vm, { Input, line, row, button, field, related }));
  return <Box flexDirection="column">{out}</Box>;
}

type Parts = {
  Input: InputElement | undefined;
  line: (text: string, tone?: "plain" | "dim" | "error" | "title", max?: number) => RenderElement;
  row: (children: RenderElement[]) => RenderElement;
  button: (key: string, label: string, action: LessonAction) => RenderElement;
  field: (name: "text" | "quote" | "reference") => { change: (v: string) => void; submit: (v: string) => void };
  related: (pattern: string) => RenderElement;
};

function editorBlocks(vm: LessonsViewModel, p: Parts): RenderElement[] {
  const { Input, line, row, button, field } = p;
  const ed = vm.editor;
  const target = ed.target;
  if (target === null) return [];
  const out: RenderElement[] = [];
  const capture = ed.mode === "capture";
  out.push(line(capture ? "New capture (not saved yet)" : `Lesson ${shown(encodeLessonKey(target.key), 80)}`, "title"));
  if (ed.error !== null) out.push(line(editorErrorText(ed.error.code, ed.error.fields), "error"));
  if (ed.phase === "purged") {
    out.push(line("This lesson was purged. Its curated wording, quotes and history are gone.", "dim"));
    out.push(line(vm.purgeCheck === "verified" ? "A fresh read confirmed the purge." : vm.purgeCheck === "pending" ? "Checking the purge..." : "The purge has not been confirmed by a fresh read yet.", "dim"));
    out.push(row([button("lesson-close", "Close lesson", { kind: "close-editor" })]));
    return out;
  }
  if (ed.phase === "unknown" && ed.pending !== null) {
    out.push(line(`Save outcome unknown for request ${ed.pending.requestId}. It may have been stored. Check before trying again.`, "error"));
    const actions = [button("lesson-check", "Check outcome", { kind: "check" })];
    if (vm.canRetry) actions.push(button("lesson-retry", "Send the same request again", { kind: "retry" }));
    out.push(row(actions));
  }
  if (vm.sending && ed.pending !== null) out.push(line(`Saving... (request ${ed.pending.requestId})`, "dim"));
  if (vm.captureExists) out.push(row([button("lesson-open-existing", "Open the stored lesson", { kind: "open-existing" })]));
  if (isLessonEditorStale(ed)) {
    out.push(line("This lesson changed elsewhere since you started editing. Your wording is kept.", "error"));
    out.push(row([button("lesson-rebase", "Edit from the newer version", { kind: "rebase" })]));
  }
  if (vm.detailError !== null) out.push(line(`Lesson detail unavailable: ${vm.detailError}`, "error"));

  const draft = ed.draft;
  if (draft === null) {
    if (ed.gate !== "ready") out.push(line("Checking which store holds this lesson...", "dim"));
  } else if (vm.sending) {
    out.push(line("Lesson wording (held while the save runs):", "dim"));
    out.push(line(draft.text, "plain", TEXT_CHARS));
  } else if (Input !== undefined) {
    out.push(
      <Input
        key="lesson-text"
        label="Lesson wording"
        value={vm.refused.text ?? draft.text}
        rows={4}
        autoFocus
        submitLabel="keep"
        onInput={field("text").change}
        onSubmit={field("text").submit}
      />,
    );
    if (vm.dropped.text) out.push(line(dropNote("wording"), "error"));
  } else {
    out.push(line(draft.text, "plain", TEXT_CHARS));
  }

  // Provenance: kept apart from the wording, and never claimed as verified.
  const source = draft?.source ?? null;
  if (capture && source !== null) {
    if (source.kind === "native_selection") {
      out.push(line("Quote (selected text as the terminal reported it, not verified against a transcript):", "dim"));
      out.push(line(source.quote ?? "", "plain", TEXT_CHARS));
    } else if (vm.sending) {
      out.push(line(`Quote: ${source.quote ?? "(none)"}`, "dim", TEXT_CHARS));
      out.push(line(`Reference: ${source.reference ?? "(none)"}`, "dim", TEXT_CHARS));
    } else if (Input !== undefined) {
      out.push(<Input key="lesson-quote" label="Quote" value={vm.refused.quote ?? source.quote ?? ""} rows={3} submitLabel="keep" onInput={field("quote").change} onSubmit={field("quote").submit} />);
      if (vm.dropped.quote) out.push(line(dropNote("quote"), "error"));
      out.push(<Input key="lesson-reference" label="Reference (yours, not verified)" value={vm.refused.reference ?? source.reference ?? ""} submitLabel="keep" onInput={field("reference").change} onSubmit={field("reference").submit} />);
      if (vm.dropped.reference) out.push(line(dropNote("reference"), "error"));
    }
    if (vm.scopeToConfirm !== null) {
      const c = vm.scopeToConfirm;
      const label = vm.choices.find((x) => flatProject(x.scope.project) === c.project)?.label ?? c.project;
      out.push(
        line(
          c.restored
            ? `World ${c.world} and project ${label} came back from a reload and could not be checked against this directory. This capture is saved only after you confirm both.`
            : `World ${c.world} was inferred as the catch-all for this directory, with project ${label}. This capture is saved only after you confirm both.`,
          "error",
        ),
      );
      out.push(row([button("lesson-confirm-scope", shown(`Confirm world ${c.world}, project ${label}`), { kind: "confirm-scope" })]));
    }
    const id = (value: string | null) => (value === null ? "unknown" : value);
    out.push(line(`Captured in session ${id(source.captureSessionId)}. Source conversation: ${id(source.sourceConversationId)}. Row: ${id(source.sourceRowId)}. Agent: ${id(source.sourceAgentId)}.`, "dim"));
  }
  const loaded = ed.loaded;
  if (!capture && loaded !== null) {
    out.push(line(`Revision ${loaded.revision}. ${loaded.important ? "Marked important." : "Not marked important."} Source: ${loaded.sourceStatus}.`, "dim"));
    if (loaded.originalText !== null && loaded.originalText !== (loaded.effectiveText ?? loaded.originalText)) out.push(line(`Original: ${loaded.originalText}`, "dim", TEXT_CHARS));
    if (loaded.source !== null) out.push(line(`Quote: ${loaded.source.quote ?? "(none kept)"}${loaded.source.reference ? `. Reference: ${loaded.source.reference}` : ""}`, "dim", TEXT_CHARS));
    const d = vm.detail;
    if (d !== null) {
      if (d.provenance.kind === "existing_lesson" && d.provenance.state === "available") out.push(line(`From inbox lesson ${d.provenance.pattern} (${d.provenance.location}), created ${d.provenance.created}.`, "dim"));
      if (d.provenance.kind === "existing_lesson" && d.provenance.state === "unavailable") out.push(line(`Source unavailable (${d.provenance.problem}). The curated wording is kept.`, "error"));
      if (d.provenance.kind === "existing_lesson" && d.provenance.state === "conflict") out.push(line(`Source conflict: ${d.provenance.copies.length} copies disagree. Nothing can be acknowledged until they are reconciled.`, "error"));
      for (const diag of d.diagnostics.slice(0, 5)) out.push(line(`Diagnostic: ${diag.code}`, "dim"));
      if (d.historyError) out.push(line("History unavailable.", "error"));
      if (d.history !== null) {
        out.push(line(`History, newest first (${d.history.length} of ${d.historyTotal ?? d.history.length}):`, "dim"));
        for (const h of d.history) out.push(line(`r${h.revision} ${h.kind} ${h.at}${h.text !== null ? `: ${h.text}` : ""}${h.important !== null ? ` important=${h.important}` : ""}`, "dim"));
      }
      out.push(line(`Read ${d.readAt}.`, "dim"));
    }
  }

  if (!vm.sending) {
    const actions: RenderElement[] = [];
    if (draft !== null && (capture || vm.dirty)) actions.push(button("lesson-save", capture ? "Save capture" : "Save wording", { kind: "save" }));
    if (!capture && ed.base !== null) actions.push(button("lesson-important", ed.base.important ? "Unmark important" : "Mark important", { kind: "important" }));
    if (!capture && loaded !== null && loaded.sourceStatus === "changed" && loaded.sourceDigest !== null) actions.push(button("lesson-acknowledge", "Accept current source", { kind: "acknowledge" }));
    if (!capture && ed.base !== null && vm.purgeConfirm === null) actions.push(button("lesson-purge", "Purge", { kind: "purge" }));
    if (!capture && loaded !== null && loaded.relatedPattern !== null && SLUG.test(loaded.relatedPattern)) {
      actions.push(p.related(loaded.relatedPattern));
    }
    actions.push(button("lesson-close", capture ? "Cancel capture" : "Close lesson", { kind: "close-editor" }));
    out.push(row(actions));
    if (vm.purgeConfirm !== null) {
      const k = vm.purgeConfirm;
      out.push(line(`Purge lesson ${k.kind} ${k.id} in world ${k.world}? This clears its curated wording, quotes and history from this installation. It cannot be undone.`, "error", 600));
      out.push(row([button("lesson-purge-confirm", "Purge permanently", { kind: "purge-confirm" }), button("lesson-purge-cancel", "Keep it", { kind: "purge-cancel" })]));
    }
  }
  return out;
}
