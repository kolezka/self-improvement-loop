// The shape of one recorded PreToolUse payload sample.
//
// Lives here rather than in the hook because two writers produce the file: the
// hook records a sample per live tool call, and `sil import payloads` backfills
// from old session transcripts. One definition keeps both byte-identical.
// Pure and dependency free, so the hook fast path pays nothing to import it.

// The only tool_input keys a gate predicate reads: command_matches reads
// `command`, file_path_matches reads `file_path` (tool_is reads the top-level
// tool name). Nothing else can change a gate result, so nothing else is
// sampled. `command` is free text the model wrote and does carry credentials
// at times (`curl -H "Authorization: Bearer ..."`, `export GH_TOKEN=...`);
// the feature does not exist without it, so it is kept and the usual
// credential shapes are blanked before the write.
export const SAMPLED_INPUT_KEYS = ["command", "file_path"] as const;
export const SAMPLE_VALUE_MAX_CHARS = 500;
export const SAMPLES_ROTATE_AT_BYTES = 2 * 1024 * 1024;
export const SAMPLES_KEEP_LINES = 2000;

// A gate matches flags and subcommands, never the value after them.
const CREDENTIAL_RE =
  /((?:authorization:\s*(?:bearer|basic|token)?\s*|bearer\s+|(?:token|api[_-]?key|password|passwd|secret)=)['"]?)[^\s'"]+/gi;

export function redactCredentials(text: string): string {
  return text.replace(CREDENTIAL_RE, "$1<redacted>");
}

export interface PayloadSample {
  ts: string;
  session_id: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, string>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One sample from a hook payload: allowlisted keys only, string values
 * truncated and redacted. Returns null when tool_name is not a non-empty
 * string, which is the only case with nothing to record. */
export function sampleRecord(payload: Record<string, unknown>, ts: string): PayloadSample | null {
  const toolName = payload["tool_name"];
  if (typeof toolName !== "string" || !toolName) return null;

  const rawInput = payload["tool_input"];
  const toolInput: Record<string, string> = {};
  if (isRecord(rawInput)) {
    for (const key of SAMPLED_INPUT_KEYS) {
      const value = rawInput[key];
      if (typeof value === "string") toolInput[key] = redactCredentials(value.slice(0, SAMPLE_VALUE_MAX_CHARS));
    }
  }

  const sessionId = payload["session_id"];
  const eventName = payload["hook_event_name"];
  return {
    ts,
    session_id: typeof sessionId === "string" && sessionId ? sessionId : "unknown",
    hook_event_name: typeof eventName === "string" ? eventName : "",
    tool_name: toolName,
    tool_input: toolInput,
  };
}
