// Pure helpers for the Logs pane. The engine writes two line shapes: worker.log
// is JSON per line, the other logs are "<iso> <message>". Both parse here so the
// console can show a time column, a level colour and a text filter.

export type LogLevel = "error" | "warn" | "info";

export interface LogLine {
  /** 1-based position in the tail, shown as the gutter number. */
  index: number;
  /** Local wall clock, empty when the line carries no timestamp. */
  time: string;
  /** Full timestamp for the tooltip, empty when the line carries none. */
  iso: string;
  text: string;
  level: LogLevel;
  raw: string;
}

export interface Segment {
  text: string;
  hit: boolean;
}

const ISO_PREFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)\s+(.*)$/s;
// Prefix matches on purpose: \bfail covers failed and failure, \berror covers
// errors. The phrases carry the engine's own wording ("could not write ...").
const ERROR_WORDS = /(\berror|\bfail|\bfatal\b|\bexception\b|\btraceback\b|\bdenied\b|\brefused\b|\bcould not\b|\bcannot\b|\bunable\b)/i;
const WARN_WORDS = /(\bwarn|\bretry|\bretries\b|\bstale\b|\bslow\b|\bskip|\btimeout\b|\btimed out\b|\bexpired\b|\bnot queued\b)/i;
// "errors=0" is a healthy counter, not a failure. Zero-valued pairs go before
// the level words get a look at the line.
const ZERO_PAIRS = /\b[\w.]+\s*=\s*(0|0\.0+|false|none|null)(?=\s|$)/gi;

// One shared formatter: building an Intl.DateTimeFormat per line costs more
// than the rest of the parse on a 2000-line tail.
const CLOCK = new Intl.DateTimeFormat(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

// A one-character filter over a long line can produce thousands of segments,
// and each one becomes a DOM node. Past these caps the line renders unmarked.
const MAX_HIGHLIGHT_HITS = 50;
const MAX_HIGHLIGHT_CHARS = 4000;

/** Level from the message text alone; the engine writes no level field. */
export function levelOf(text: string): LogLevel {
  const scrubbed = text.replace(ZERO_PAIRS, " ");
  if (ERROR_WORDS.test(scrubbed)) return "error";
  if (WARN_WORDS.test(scrubbed)) return "warn";
  return "info";
}

function clockOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return CLOCK.format(date);
}

function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

/** Flattens one worker JSON record into "key=value key=value", ts excluded. */
function jsonText(record: Record<string, unknown>): string {
  return Object.entries(record)
    .filter(([key]) => key !== "ts")
    .map(([key, value]) => `${key}=${valueText(value)}`)
    .join(" ");
}

export function parseLogLine(raw: string, index: number): LogLine {
  if (raw.startsWith("{")) {
    try {
      const record = JSON.parse(raw) as unknown;
      if (record && typeof record === "object" && !Array.isArray(record)) {
        const obj = record as Record<string, unknown>;
        const iso = typeof obj["ts"] === "string" ? obj["ts"] : "";
        const text = jsonText(obj);
        return { index, time: iso ? clockOf(iso) : "", iso, text, level: levelOf(text), raw };
      }
    } catch {
      // Not JSON after all: fall through to the plain-text shapes.
    }
  }

  const match = ISO_PREFIX.exec(raw);
  if (match) {
    const iso = match[1]!;
    const text = match[2]!;
    return { index, time: clockOf(iso), iso, text, level: levelOf(text), raw };
  }

  return { index, time: "", iso: "", text: raw, level: levelOf(raw), raw };
}

export function parseLogLines(lines: string[]): LogLine[] {
  return lines.map((raw, i) => parseLogLine(raw, i + 1));
}

/** Matches what the console shows: the message plus the timestamp behind the
 * time column. Matching the raw line instead would hide lines the user can
 * see, because a worker record renders as "key=value", not as its JSON. */
export function matchesFilter(line: LogLine, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return line.text.toLowerCase().includes(needle) || line.iso.toLowerCase().includes(needle);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Splits text on every case-insensitive occurrence of query so the view can
 * mark the hits. A blank query returns one unmarked segment. */
export function highlight(text: string, query: string): Segment[] {
  const needle = query.trim();
  if (needle === "" || text.length > MAX_HIGHLIGHT_CHARS) return [{ text, hit: false }];
  // Case-insensitive search on the original string. Searching a lowercased
  // copy would shift every offset after a character that folds to two
  // (U+0130 for one), and slice the marks off by that much.
  const finder = new RegExp(escapeRegExp(needle), "gi");
  const out: Segment[] = [];
  let pos = 0;
  let hits = 0;
  for (let match = finder.exec(text); match !== null; match = finder.exec(text)) {
    if (++hits > MAX_HIGHLIGHT_HITS) return [{ text, hit: false }];
    if (match.index > pos) out.push({ text: text.slice(pos, match.index), hit: false });
    out.push({ text: match[0], hit: true });
    pos = match.index + match[0].length;
    // A zero-length match cannot happen with an escaped literal, but an empty
    // needle would loop forever if the guard above ever changes.
    if (match[0].length === 0) break;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
  return out;
}

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
