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

import type { On, RenderElement } from "claude-code";
import { drawLessons } from "./lessons-view.tsx";
import { consoleAct, readConsole } from "./register.ts";
import type { ConsoleUiState } from "./state.ts";
import { boundedErrorText, consoleView, CURRENT_MARK, selectAction, type ConsoleBlock, type ConsoleControl, type ConsoleLine } from "./views.ts";

/** The body's width as the pane reports it. Without one the narrow layout
 * is used, since it fits any width. */
function bodyColumns(props: unknown): number {
  const columns = typeof props === "object" && props !== null ? (props as { bodyColumns?: unknown }).bodyColumns : undefined;
  return typeof columns === "number" && Number.isFinite(columns) ? columns : 0;
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

    const buttonOf = (c: ConsoleControl): RenderElement => (
      <Button key={c.key} label={c.isCurrent ? `${c.label}${CURRENT_MARK}` : c.label} onPress={() => consoleAct($, c.action)} />
    );

    const blockOf = (b: ConsoleBlock): RenderElement => {
      if (b.kind === "line") return lineOf(b.line);
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
      if (b.label === undefined) return <Box flexDirection={b.direction} gap={1}>{buttons}</Box>;
      return (
        <Box flexDirection={b.direction} gap={1}>
          <Text dimColor>{b.label}</Text>
          {buttons}
        </Box>
      );
    };

    const blocks = consoleView(state, { columns: bodyColumns(e.props), canSelect: Select !== undefined });
    const drawn = blocks.map(blockOf);
    // Lessons live inside Activity, below its inbox, queue and log.
    if (state.section === "activity") {
      try {
        drawn.push(await drawLessons($, ui, e, state.world, bodyColumns(e.props)));
      } catch (err) {
        drawn.push(<Text color="error">{`Error: the lessons view could not be drawn: ${boundedErrorText(errorText(err))}`}</Text>);
      }
    }
    return <Box flexDirection="column">{drawn}</Box>;
  });
}
