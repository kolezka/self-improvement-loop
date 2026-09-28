// Vendored from github.com/kolezka/svelte-log-viewer@ef28afc (private, same author). Edit upstream first.
/** One line of output from a log source. */
export interface LogLine {
  /** Which source produced this line, when a view mixes more than one. */
  source?: string;
  /** 1-based, dense, per source. */
  seq: number;
  ts: string;
  stream: LogStream;
  text: string;
}

export type LogStream = "stdout" | "stderr" | "system";
