// Shared helpers for the curriculum and review tests.
//
// Everything is hermetic. The three SIL directories, CLAUDE_CONFIG_DIR and git's
// own global config all point inside a temp dir, so a test can never read or
// write the machine's real state.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Config,
  Config as ConfigSchema,
  type Layout,
  targetRoot,
  World as WorldSchema,
  type World,
} from "@sil/core";
import { git, setNudgeAdapter, type GateCorpusResult, type NudgeAdapter } from "@sil/curriculum";
import { writeReflection } from "@sil/store";

const ENV_KEYS = [
  "SIL_CONFIG_DIR",
  "SIL_STATE_DIR",
  "SIL_DATA_DIR",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PLUGIN_ROOT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
] as const;

export interface TestEnv {
  tmp: string;
  root: string;
  saved: Record<string, string | undefined>;
}

/** Point every root at a fresh temp dir. */
export function silEnv(): TestEnv {
  const tmp = mkdtempSync(join(tmpdir(), "sil-test-"));
  const root = join(tmp, "sil");
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];

  for (const [name, sub] of [
    ["SIL_CONFIG_DIR", "config"],
    ["SIL_STATE_DIR", "state"],
    ["SIL_DATA_DIR", "data"],
  ] as const) {
    const dir = join(root, sub);
    mkdirSync(dir, { recursive: true });
    process.env[name] = dir;
  }
  const claude = join(root, "claude");
  mkdirSync(claude, { recursive: true });
  process.env["CLAUDE_CONFIG_DIR"] = claude;
  // git must not read the operator's config: a global hooksPath, gpg signing or
  // an alias would make these tests depend on the machine they run on.
  process.env["GIT_CONFIG_GLOBAL"] = join(root, "gitconfig");
  process.env["GIT_CONFIG_SYSTEM"] = join(root, "gitconfig");
  // Unset so the payload corpus comes from this repo's own fixtures.
  delete process.env["CLAUDE_PLUGIN_ROOT"];
  return { tmp, root, saved };
}

export function cleanupEnv(env: TestEnv): void {
  for (const [key, value] of Object.entries(env.saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(env.tmp, { recursive: true, force: true });
}

// --- worlds and config -------------------------------------------------------

export function makeWorld(overrides: Partial<World> = {}): World {
  return WorldSchema.parse({ name: "default", ...overrides });
}

export const V1_LAYOUT: Layout = {
  skills_dir: "claude/skills",
  nudges_dir: "claude/hooks/nudges",
  agents_dir: "claude/agents",
  rules_file: "global.CLAUDE.md",
  ledger: "claude/skills/promotions.json",
};

export function makeCfg(
  opts: { threshold?: number; per_run_cap?: number; auto_merge?: boolean; worlds?: World[] } = {},
): Config {
  return ConfigSchema.parse({
    worlds: opts.worlds ?? [makeWorld()],
    promotion: {
      threshold: opts.threshold ?? 3,
      per_run_cap: opts.per_run_cap ?? 3,
      auto_merge: opts.auto_merge ?? false,
    },
  });
}

// --- reflections -------------------------------------------------------------

export const LESSON =
  "Before calling a change safe, run `rg` over every call site of the changed " +
  "symbol and read the graphify inventory; a single unguarded consumer is the " +
  "whole bug.";

export function reflectionBody(pattern: string, day: string, lesson: string = LESSON): string {
  return (
    `Last updated: ${day}\n\n` +
    `Pattern: ${pattern}\n\n` +
    "## What worked\n" +
    "Reading the promotions ledger before touching the branch.\n\n" +
    "## What failed & why\n" +
    "I generalised from one obvious consumer and missed an unguarded call site.\n\n" +
    "## Reusable lesson\n" +
    `${lesson}\n\n` +
    "## Verification\n" +
    "Re-ran `rg` across the repository and counted the hits.\n\n" +
    "## Not verified\n" +
    "Whether the graphify extraction covers wrapped call sites.\n"
  );
}

/** `count` reflection documents for one pattern, dated consecutively. */
export function addReflections(
  world: World,
  pattern: string,
  count: number,
  opts: { startDay?: number; lesson?: string } = {},
): string[] {
  const startDay = opts.startDay ?? 1;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const day = `2026-09-${String(startDay + i).padStart(2, "0")}`;
    const id = `${day}-${pattern}-${String(i).padStart(2, "0")}`;
    out.push(writeReflection(world.name, { id, created: day }, reflectionBody(pattern, day, opts.lesson)));
  }
  return out;
}

// --- target repos ------------------------------------------------------------

/** A git repo at the world's target, with one empty commit on main. */
export function initTarget(world: World, root?: string): string {
  return git.ensureRepo(root ?? targetRoot(world));
}

export function commitFile(repo: string, rel: string, text: string, message = "chore: fixture"): void {
  const path = join(repo, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
  git.git(repo, ["add", "--", rel]);
  git.git(repo, ["commit", "-q", "-m", message]);
}

// --- fake nudge dispatcher (group A) -----------------------------------------

export const EVENTS: NudgeAdapter["EVENTS"] = {
  PreToolUse: new Set(["Bash", "Edit", "Write", "Read", "Grep", "Glob", "Agent"]),
  PostToolUse: new Set(["Bash", "Edit", "Write", "Read", "Grep", "Glob", "Agent"]),
  Stop: null,
  SessionStart: null,
  UserPromptSubmit: null,
};

export class NudgeError extends Error {
  override name = "NudgeError";
}

/** A faithful stand-in for the dispatcher's gate interpreter.
 *
 * Real enough that the router's "execute the gate against the corpus" rule is
 * actually exercised: a stub returning true would make every hook test pass for
 * the wrong reason. */
export function evaluateGate(gate: unknown, payload: Record<string, unknown>): boolean {
  if (gate === null || typeof gate !== "object" || Array.isArray(gate)) {
    throw new NudgeError(`a gate is exactly one predicate, got: ${JSON.stringify(gate)}`);
  }
  const entries = Object.entries(gate as Record<string, unknown>);
  if (entries.length !== 1) {
    throw new NudgeError(`a gate is exactly one predicate, got: ${JSON.stringify(gate)}`);
  }
  const [name, arg] = entries[0]!;
  const rawInput = payload["tool_input"];
  const toolInput =
    rawInput !== null && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : {};
  switch (name) {
    case "always":
      return Boolean(arg);
    case "tool_is":
      if (!Array.isArray(arg)) throw new NudgeError("tool_is takes a list");
      return arg.includes(payload["tool_name"]);
    case "command_matches":
      return new RegExp(String(arg)).test(String(toolInput["command"] ?? ""));
    case "file_path_matches":
      return globMatch(String(arg), String(toolInput["file_path"] ?? ""));
    case "prompt_matches":
      return new RegExp(String(arg)).test(String(payload["prompt"] ?? ""));
    case "all":
      return (arg as unknown[]).every((child) => evaluateGate(child, payload));
    case "any":
      return (arg as unknown[]).some((child) => evaluateGate(child, payload));
    case "not":
      return !evaluateGate(arg, payload);
    default:
      throw new NudgeError(`unknown predicate ${JSON.stringify(name)}`);
  }
}

function globMatch(pattern: string, value: string): boolean {
  const re = pattern
    .split("")
    .map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${re}$`).test(value);
}

/** The corpus runner the router uses, in process. The real one forks; the
 * contract (`{results, error, timedOut}`) is what matters here. */
export function fakeGateRunner(gate: unknown, payloads: Record<string, unknown>[]): GateCorpusResult {
  const results: boolean[] = [];
  for (const payload of payloads) {
    try {
      results.push(Boolean(evaluateGate(gate, payload)));
    } catch (e) {
      return { results: [], error: (e as Error).message, timedOut: false };
    }
  }
  return { results, error: null, timedOut: false };
}

export function fakeLintNudge(payload: unknown): string[] {
  const obj = (payload ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of ["pattern", "event", "gate", "once_per", "text"]) {
    if (!(key in obj)) problems.push(`missing key ${JSON.stringify(key)}`);
  }
  if ("event" in obj && !Object.hasOwn(EVENTS, String(obj["event"]))) {
    problems.push(`unknown event ${JSON.stringify(obj["event"])}`);
  }
  if ("once_per" in obj && obj["once_per"] !== "session" && obj["once_per"] !== "always") {
    problems.push("once_per must be 'session' or 'always'");
  }
  if (String(obj["text"] ?? "").length > 400) problems.push("text is over 400 characters");
  return problems;
}

export function installFakeNudge(overrides: Partial<NudgeAdapter> = {}): void {
  setNudgeAdapter({
    EVENTS,
    lintNudge: fakeLintNudge,
    runGateCorpus: fakeGateRunner,
    ...overrides,
  });
}

export function uninstallFakeNudge(): void {
  setNudgeAdapter(null);
}

// --- fake provider -----------------------------------------------------------

export function skillBody(pattern: string, quote = ""): string {
  return (
    `---\nname: ${pattern}\n` +
    "description: Use when a change touches a shared symbol and you are about " +
    "to call it safe.\n---\n\n" +
    "## Enumerate every call site\n\n" +
    "Run `rg` over the changed symbol and read the graphify inventory before " +
    "calling the change safe. One unguarded consumer is the whole bug, and the " +
    "promotions ledger will not tell you about it.\n" +
    (quote ? `\nEvidence: ${quote}\n` : "")
  );
}

export const agentBody = skillBody;

export function ruleBody(): string {
  return "- Run `rg` over every call site of a changed symbol and read the graphify inventory before calling the change safe.";
}

export function hookBody(pattern: string): Record<string, unknown> {
  return {
    pattern,
    event: "PreToolUse",
    matcher: "Bash",
    gate: { command_matches: "git (commit|push)" },
    once_per: "session",
    text:
      "Run `rg` over every call site of the changed symbol and read the " +
      "graphify inventory before committing; the promotions ledger records only a watermark.",
  };
}

export function skillDraft(pattern: string, quote: string): Record<string, unknown> {
  return {
    trigger_event: "none",
    gate: null,
    needs_own_context: false,
    context_evidence: null,
    capability_evidence: quote,
    no_artifact: false,
    artifact: skillBody(pattern, quote),
  };
}

export function ruleDraft(): Record<string, unknown> {
  return {
    trigger_event: "none",
    gate: null,
    needs_own_context: false,
    context_evidence: null,
    capability_evidence: null,
    no_artifact: false,
    artifact: ruleBody(),
  };
}

export function hookDraft(pattern: string): Record<string, unknown> {
  return {
    trigger_event: "PreToolUse:Bash",
    gate: { command_matches: "git (commit|push)" },
    needs_own_context: false,
    context_evidence: null,
    capability_evidence: null,
    no_artifact: false,
    artifact: hookBody(pattern),
  };
}

export interface ChatCall {
  role: string;
  messages: { role: string; content: string }[];
}

/** A `chat` stand-in that records every call. */
export class FakeChat {
  readonly calls: ChatCall[] = [];
  constructor(
    private readonly opts: {
      draft?: Record<string, unknown>;
      drafts?: Record<string, unknown>[];
      verdict?: boolean;
      reason?: string;
    } = {},
  ) {}

  readonly fn = async (
    role: string,
    messages: { role: string; content: string }[],
  ): Promise<string> => {
    this.calls.push({ role, messages });
    if (role === "judge") {
      return JSON.stringify({
        verdict: (this.opts.verdict ?? true) ? "yes" : "no",
        reason: this.opts.reason ?? "quoted from a source",
      });
    }
    if (this.opts.drafts && this.opts.drafts.length > 0) return JSON.stringify(this.opts.drafts.shift());
    return JSON.stringify(this.opts.draft ?? {});
  };

  get roles(): string[] {
    return this.calls.map((c) => c.role);
  }

  promptsFor(role: string): string[] {
    return this.calls.filter((c) => c.role === role).map((c) => c.messages[c.messages.length - 1]!.content);
  }
}
