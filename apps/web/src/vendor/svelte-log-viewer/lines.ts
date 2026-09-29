// Vendored from github.com/kolezka/svelte-log-viewer@ef28afc (private, same author). Edit upstream first.
/**
 * Row level helpers for the log viewer. Pure functions so the component only
 * has to worry about scrolling.
 */

import type { LogLine, LogStream } from "./types.ts";

export type StreamFilter = "all" | LogStream;

/** What a row is tinted as, from its own text. */
export type LineTint = "plain" | "command" | "pass" | "fail";

/** How a row is drawn once stream and text have both had their say. */
export type LineTone = LineTint | "stderr" | "system";

const COMMAND_PREFIX = "$ ";
const VERDICT = /^(PASS|FAIL)(\b|$)/;

/** A command the pipeline echoed, or a PASS/FAIL verdict at the start of a line. */
export function tintOf(text: string): LineTint {
  if (text.startsWith(COMMAND_PREFIX)) return "command";
  const verdict = VERDICT.exec(text);
  if (verdict === null) return "plain";
  return verdict[1] === "PASS" ? "pass" : "fail";
}

/** The text tint wins over the stream, so a stderr FAIL still reads as a failure. */
export function toneOf(line: LogLine): LineTone {
  const tint = tintOf(line.text);
  if (tint !== "plain") return tint;
  if (line.stream === "stderr") return "stderr";
  if (line.stream === "system") return "system";
  return "plain";
}

/** Local wall clock as HH:MM:SS.mmm. Unparseable input comes back as dashes.
 * Local patch (not upstream): a line with no ts at all passes "", which reads
 * better blank than as a row of dashes; a malformed non-empty timestamp still
 * shows dashes. Port this to upstream if lines.ts is refreshed from there. */
export function formatClock(iso: string): string {
  if (iso === "") return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "--:--:--.---";
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return (
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}` +
    `.${pad(at.getMilliseconds(), 3)}`
  );
}

/** Enough of a source id to tell two sources apart in a mixed view. */
export function shortSourceId(id: string): string {
  const tail = id.slice(id.lastIndexOf("-") + 1);
  return tail.length > 0 ? tail : id;
}

/** Case insensitive substring over the line text. */
export function matches(line: LogLine, stream: StreamFilter, needle: string): boolean {
  if (stream !== "all" && line.stream !== stream) return false;
  if (needle.length === 0) return true;
  return line.text.toLowerCase().includes(needle);
}

/**
 * Filtered view of the buffer. With no filter set this hands back the same
 * array, so the common case costs nothing.
 */
export function filterLines(lines: LogLine[], stream: StreamFilter, text: string): LogLine[] {
  const needle = text.trim().toLowerCase();
  if (stream === "all" && needle.length === 0) return lines;
  return lines.filter((line) => matches(line, stream, needle));
}

/**
 * Split a line into fixed width chunks. The face is monospace, so a chunk is
 * exactly one visual row and the scroller can predict the height. Counts UTF-16
 * units, which is right for the ASCII the pipeline emits.
 */
export function wrapText(text: string, columns: number): string[] {
  if (columns <= 0 || text.length <= columns) return [text];
  const chunks: string[] = [];
  for (let at = 0; at < text.length; at += columns) chunks.push(text.slice(at, at + columns));
  return chunks;
}

/** Longest line in the buffer, for the width of the horizontal scroll area. */
export function longestLine(lines: LogLine[]): number {
  let longest = 0;
  for (const line of lines) if (line.text.length > longest) longest = line.text.length;
  return longest;
}

/** The buffer as plain text, in the shape the rows render. */
export function toPlainText(
  lines: LogLine[],
  options: { timestamps: boolean; seq: boolean },
): string {
  return lines
    .map((line) => {
      const parts: string[] = [];
      if (options.seq) parts.push(String(line.seq).padStart(6, " "));
      if (options.timestamps) parts.push(formatClock(line.ts));
      parts.push(line.text);
      return parts.join(" ");
    })
    .join("\n");
}
