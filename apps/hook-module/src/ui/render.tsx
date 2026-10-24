// Draws the /sil pane from the stored view state: ./views.ts decides what is
// shown, this file turns it into the surface's own elements. JSX compiles to
// the engine's global `h`; the elements come from `$.ui.resolve(e)`, so a
// surface without a Select (mobile) gets buttons instead.
//
// Drawing only reads. Every control hands its action to consoleAct in
// ./register.ts, which writes the state and reads the bridge. Those are
// imported as plain functions on purpose: `claude plugin validate` follows
// `$` into a named function, and refuses it handed to anything else (a
// method of an object passed in, say). The import cycle with ./register.ts
// is between function declarations only, so either side may load first.

import type { EngineInterface, On, RenderElement } from "claude-code";
import { drawLessons } from "./lessons-view.tsx";
import { consoleAct, readConsole } from "./register.ts";
import type { ConsoleUiState } from "./state.ts";
import { boundedErrorText, consoleView, CURRENT_MARK, NARROW_COLUMNS, selectAction, type ConsoleBlock, type ConsoleControl, type ConsoleLine } from "./views.ts";

/** The body's width as the pane reports it. Without one the narrow layout
 * is used, since it fits any width. */
function bodyColumns(props: unknown): number {
  const columns = typeof props === "object" && props !== null ? (props as { bodyColumns?: unknown }).bodyColumns : undefined;
  return typeof columns === "number" && Number.isFinite(columns) ? columns : 0;
}

type Ui = ReturnType<EngineInterface["ui"]["resolve"]>;

/** A card: a round border with room inside, or no border under
 * NARROW_COLUMNS. The title row is its first row, `meta` dim at the far end. */
export function drawCard(ui: Ui, columns: number, title: string, meta: string | undefined, children: RenderElement[]): RenderElement {
  const { Box, Text } = ui;
  const head = (
    <Box flexDirection="row" justifyContent="space-between">
      <Text bold>{title}</Text>
      {meta === undefined ? [] : [<Text dimColor>{meta}</Text>]}
    </Box>
  );
  if (columns < NARROW_COLUMNS) return <Box flexDirection="column">{[head, ...children]}</Box>;
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      {[head, ...children]}
    </Box>
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerConsoleViews(on: On): void {
  on("ui.render", { component: "Pane", requestId: "sil-console" }, async ($, e) => {
    const ui = $.ui.resolve(e);
    const { Box, Text, Button, Code } = ui;
    // By the surface, as the declared tables say: mobile has no Select. The
    // native kit's mobile table still answers to "Select" with an element
    // that draws an empty Box, so `in` alone would hide the section picker.
    const Select = e.surface !== "mobile" && "Select" in ui ? ui.Select : undefined;

    let state: ConsoleUiState;
    try {
      state = await readConsole($);
    } catch (err) {
      // The one string drawn outside consoleView: bounded and made safe the same way.
      return <Text color="error">{`Error: the console state could not be read: ${boundedErrorText(errorText(err))}`}</Text>;
    }

    const lineOf = (l: ConsoleLine): RenderElement => {
      if (l.tone === "title") return <Text bold>{l.text}</Text>;
      if (l.tone === "dim") return <Text dimColor>{l.text}</Text>;
      if (l.tone === "error") return <Text color="error">{`Error: ${l.text}`}</Text>;
      return <Text>{l.text}</Text>;
    };

    // A tone shows the current tab by color, so its label gets no mark.
    const buttonOf = (c: ConsoleControl): RenderElement => {
      const onPress = () => consoleAct($, c.action);
      if (c.tone === "primary") return <Button key={c.key} label={c.label} variant="primary" onPress={onPress} />;
      if (c.tone === "dim") return <Button key={c.key} label={c.label} dimColor onPress={onPress} />;
      return <Button key={c.key} label={c.isCurrent ? `${c.label}${CURRENT_MARK}` : c.label} onPress={onPress} />;
    };

    const blockOf = (b: ConsoleBlock): RenderElement => {
      if (b.kind === "line") return lineOf(b.line);
      if (b.kind === "card") return drawCard(ui, bodyColumns(e.props), b.title, b.meta, b.blocks.map(blockOf));
      if (b.kind === "row") {
        if (bodyColumns(e.props) < NARROW_COLUMNS) return <Box flexDirection="column">{b.blocks.map(blockOf)}</Box>;
        return (
          <Box flexDirection="row" justifyContent="space-between" gap={2}>
            {b.blocks.map(blockOf)}
          </Box>
        );
      }
      if (b.kind === "code") return b.diff ? <Code source={b.source} format="diff" /> : <Code source={b.source} />;
      if (b.kind === "select") {
        const key = b.key;
        const onSelect = (value: string) => {
          const action = selectAction(state, key, value);
          if (action !== null) consoleAct($, action);
        };
        if (Select === undefined) return <Text color="error">Error: this surface has no picker.</Text>;
        return b.value === null ? (
          <Select key={key} label={b.label} options={b.options} onSelect={onSelect} />
        ) : (
          <Select key={key} label={b.label} options={b.options} value={b.value} onSelect={onSelect} />
        );
      }
      const buttons = b.controls.map(buttonOf);
      if (b.label === undefined) return <Box key={b.key} flexDirection={b.direction} gap={1}>{buttons}</Box>;
      return (
        <Box key={b.key} flexDirection={b.direction} gap={1}>
          <Text dimColor>{b.label}</Text>
          {buttons}
        </Box>
      );
    };

    const columns = bodyColumns(e.props);
    const now = new Date();
    const blocks = consoleView(state, { columns, canSelect: Select !== undefined, now });
    const drawn = blocks.map(blockOf);
    // Curated lessons live under Activity's Lessons tab, in a card right after
    // the inbox (before the footer), or last if the budget cut the inbox.
    if (state.section === "activity" && state.activityTab === "lessons") {
      let lessons: RenderElement;
      try {
        lessons = drawCard(ui, columns, "Curated lessons", undefined, [await drawLessons($, ui, e, state.world, columns, now)]);
      } catch (err) {
        lessons = <Text color="error">{`Error: the lessons view could not be drawn: ${boundedErrorText(errorText(err))}`}</Text>;
      }
      const inbox = blocks.findIndex((b) => b.kind === "card" && b.key === "lessons");
      drawn.splice(inbox === -1 ? drawn.length : inbox + 1, 0, lessons);
    }
    return (
      <Box flexDirection="column" paddingX={1} gap={1}>
        {drawn}
      </Box>
    );
  });
}
