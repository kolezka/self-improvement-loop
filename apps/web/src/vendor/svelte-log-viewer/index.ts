// Vendored from github.com/kolezka/svelte-log-viewer@ef28afc (private, same author). Edit upstream first.
export { default as LogViewer } from "./LogViewer.svelte";

export type { LogLine, LogStream } from "./types.ts";
export type { StreamFilter, LineTone, LineTint } from "./lines.ts";
export type { LogViewerLabels } from "./labels.ts";

export {
  filterLines,
  toneOf,
  tintOf,
  formatClock,
  toPlainText,
  wrapText,
  shortSourceId,
} from "./lines.ts";
