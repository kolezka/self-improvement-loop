// Vendored from github.com/kolezka/svelte-log-viewer@ef28afc (private, same author). Edit upstream first.
import { formatNumber } from "./internal/format.ts";

/** Toolbar, footer and notice strings the viewer shows. Override any subset via the `labels` prop. */
export interface LogViewerLabels {
  follow: string;
  followAria: string;
  streamAria: string;
  allStreams: string;
  filterPlaceholder: string;
  clearFilter: string;
  lines: string;
  wrapOn: string;
  wrapOff: string;
  timestampsOn: string;
  timestampsOff: string;
  lineNumbersOn: string;
  lineNumbersOff: string;
  copy: string;
  copied: string;
  download: string;
  loadingHistory: string;
  cappedNotice: string;
  noMatchTitle: string;
  /** `buffered` is the line count before the filter narrowed it down. */
  noMatchDescription: (buffered: number) => string;
  jumpToLatest: string;
  following: string;
}

export const DEFAULT_LABELS: LogViewerLabels = {
  follow: "Follow",
  followAria: "Follow new lines",
  streamAria: "Stream",
  allStreams: "All streams",
  filterPlaceholder: "Filter lines",
  clearFilter: "Clear filter",
  lines: "lines",
  wrapOn: "Wrap long lines",
  wrapOff: "Stop wrapping lines",
  timestampsOn: "Show timestamps",
  timestampsOff: "Hide timestamps",
  lineNumbersOn: "Show line numbers",
  lineNumbersOff: "Hide line numbers",
  copy: "Copy visible lines",
  copied: "Copied",
  download: "Download the full log",
  loadingHistory: "Loading history…",
  cappedNotice: "Older lines dropped from memory. The download has the whole log.",
  noMatchTitle: "No line matches the filter",
  noMatchDescription: (buffered) =>
    `${formatNumber(buffered)} lines are buffered. Clear the filter to see them.`,
  jumpToLatest: "Jump to latest",
  following: "Following",
};
