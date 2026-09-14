// Out-of-process gate evaluation. Bundled separately (dist/gate-runner.js)
// and run under an OS-level timeout by runGateCorpus: the one real defense
// against a catastrophic regex that already made it past lint (see gates.ts's
// comment on regex safety). The curriculum router uses this to check a
// drafted gate against the payload corpus before it is ever written to a
// nudges/*.json file.
//
// Contract: reads `{"gate": <gate>, "payloads": [<payload>...]}` from stdin,
// prints `{"results": [true|false...]}`, exits 0. Any error prints
// `{"error": "<message>"}` and still exits 0: the caller reads stdout, not
// the exit code, to tell success from failure.

import { existsSync } from "node:fs";
import { join } from "node:path";
import * as paths from "@sil/core/paths";
import { evaluate } from "./gates.ts";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function runFromStdin(): Promise<void> {
  try {
    const raw = await Bun.stdin.text();
    const input: unknown = JSON.parse(raw);
    if (!isRecord(input) || !Array.isArray(input["payloads"])) {
      throw new Error("expected {gate, payloads: [...]}");
    }
    const gate = input["gate"];
    const results = input["payloads"].map((p) => evaluate(gate, isRecord(p) ? p : {}));
    console.log(JSON.stringify({ results }));
  } catch (e) {
    console.log(JSON.stringify({ error: (e as Error).message }));
  }
}

export interface GateCorpusResult {
  results: boolean[] | null;
  error: string | null;
  timedOut: boolean;
}

function resolveRunner(): string {
  const built = join(paths.pluginRoot(), "dist", "gate-runner.js");
  if (existsSync(built)) return built;
  return join(paths.pluginRoot(), "packages", "nudges", "src", "gate-runner.ts");
}

/** Evaluate a drafted `gate` against `payloads` in a fresh `bun` subprocess,
 * killed after `timeoutMs` if it has not finished. Never throws: a timeout
 * or a malformed gate both come back as a populated result object. */
export function runGateCorpus(gate: unknown, payloads: Record<string, unknown>[], timeoutMs = 250): GateCorpusResult {
  const runner = resolveRunner();
  const input = JSON.stringify({ gate, payloads });
  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync(["bun", runner], { stdin: Buffer.from(input, "utf8"), stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  } catch (e) {
    return { results: null, error: (e as Error).message, timedOut: false };
  }
  if (proc.exitCode === null) {
    return { results: null, error: `gate corpus evaluation exceeded ${timeoutMs}ms`, timedOut: true };
  }
  const out = (proc.stdout ?? Buffer.alloc(0)).toString("utf8").trim();
  try {
    const parsed: unknown = JSON.parse(out);
    if (isRecord(parsed) && typeof parsed["error"] === "string") {
      return { results: null, error: parsed["error"], timedOut: false };
    }
    if (isRecord(parsed) && Array.isArray(parsed["results"])) {
      return { results: parsed["results"] as boolean[], error: null, timedOut: false };
    }
    return { results: null, error: `unexpected gate-runner output: ${out.slice(0, 200)}`, timedOut: false };
  } catch {
    return { results: null, error: `unparseable gate-runner output: ${out.slice(0, 200)}`, timedOut: false };
  }
}

if (import.meta.main) {
  await runFromStdin();
}
