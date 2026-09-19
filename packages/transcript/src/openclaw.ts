// Translate an OpenClaw session transcript into the record shape the evidence
// parser already reads (Claude Code JSONL).
//
// OpenClaw writes ~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl with
// record types `session`, `message`, `model_change`, `thinking_level_change`
// and `custom`. A `message` carries `message.role` of user | assistant |
// toolResult; assistant content holds `toolCall` blocks. Translating here
// keeps one parser instead of two.

const SKILL_PATH_RE = /(?:^|\/)skills\/([A-Za-z0-9][A-Za-z0-9._-]*)\/SKILL\.md$/;

// OpenClaw runs shell commands through `exec`. The parser keys its bash and
// test detection off the Claude Code tool name, so this one name is mapped.
const TOOL_NAMES: Record<string, string> = { exec: "Bash" };

type Rec = Record<string, unknown>;

function asRecord(v: unknown): Rec | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null;
}

/** True for the first record of an OpenClaw transcript, or for any OpenClaw
 * message record (a transcript that lost its header still detects). */
export function isOpenclawRecord(rec: Rec): boolean {
  if (rec["type"] === "session" && typeof rec["id"] === "string" && rec["message"] === undefined) return true;
  if (rec["type"] !== "message") return false;
  const message = asRecord(rec["message"]);
  return message !== null && typeof message["role"] === "string" && rec["sessionId"] === undefined;
}

function textBlocks(content: unknown): Rec[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: Rec[] = [];
  for (const raw of content) {
    const block = asRecord(raw);
    if (block && block["type"] === "text") out.push({ type: "text", text: String(block["text"] ?? "") });
  }
  return out;
}

/** A skill is "used" in OpenClaw by reading its SKILL.md: there is no Skill
 * tool. The parser counts a skill only from a `Skill` tool call, so the read
 * is renamed instead of duplicated. One tool call stays one tool call, and the
 * id still joins the read's tool result. */
function skillBlock(id: string | null, name: string, args: Rec): Rec | null {
  if (name !== "read") return null;
  const path = args["path"];
  if (typeof path !== "string") return null;
  const m = SKILL_PATH_RE.exec(path);
  return m ? { type: "tool_use", id, name: "Skill", input: { skill: m[1] } } : null;
}

function assistantBlocks(content: unknown): Rec[] {
  if (!Array.isArray(content)) return [];
  const out: Rec[] = [];
  for (const raw of content) {
    const block = asRecord(raw);
    if (!block) continue;
    if (block["type"] === "text") {
      out.push({ type: "text", text: String(block["text"] ?? "") });
      continue;
    }
    if (block["type"] !== "toolCall") continue;
    const name = String(block["name"] ?? "");
    const args = asRecord(block["arguments"]) ?? {};
    const id = block["id"] != null ? String(block["id"]) : null;
    out.push(skillBlock(id, name, args) ?? { type: "tool_use", id, name: TOOL_NAMES[name] ?? name, input: args });
  }
  return out;
}

function toolResultBlock(message: Rec): Rec {
  return {
    type: "tool_result",
    tool_use_id: message["toolCallId"] != null ? String(message["toolCallId"]) : "",
    is_error: message["isError"] === true,
    content: message["content"],
  };
}

/** Map OpenClaw records to Claude Code shaped records. Thinking blocks, model
 * changes and custom records carry no evidence and are dropped. */
export function* adaptOpenclawRecords(records: Iterable<Rec>): Generator<Rec> {
  let sessionId = "";
  for (const rec of records) {
    const type = rec["type"];
    if (type === "session") {
      if (typeof rec["id"] === "string") sessionId = rec["id"];
      continue;
    }
    if (type !== "message") continue;
    const message = asRecord(rec["message"]);
    if (!message) continue;
    const role = message["role"];

    if (role === "user") {
      yield { type: "user", sessionId, message: { content: textBlocks(message["content"]) } };
    } else if (role === "assistant") {
      yield { type: "assistant", sessionId, message: { content: assistantBlocks(message["content"]) } };
    } else if (role === "toolResult") {
      yield { type: "user", sessionId, message: { content: [toolResultBlock(message)] } };
    }
  }
}
