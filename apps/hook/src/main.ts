// Hook fast path entry. Runs as `bun ${CLAUDE_PLUGIN_ROOT}/dist/hook.js` on
// every Claude Code hook event. Must always exit 0 and print at most one
// JSON object, only for OUTPUT_EVENTS. Ported from sil/hook.py's module
// guard and main().
//
// Only node: builtins are imported statically. Every @sil/* and local
// module is loaded with a dynamic import inside main()'s try/catch: a
// static top-level `import` that throws crashes the whole entry point
// before any try/catch here gets a chance to run, exactly the "broken
// partial install" case sil/hook.py guards with its own module-level
// try/except around `from sil import ...`.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

const OUTPUT_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"]);
const SLOW_INVOCATION_MS = 150;

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return `${homedir()}${p.slice(1)}`;
  return p;
}

/** Reimplements paths.stateDir()'s precedence without importing @sil/core:
 * this only runs once loading @sil/* has already failed. */
function fallbackStateDir(): string {
  const raw = process.env["SIL_STATE_DIR"];
  if (raw) return expandHome(raw);
  const xdg = process.env["XDG_STATE_HOME"];
  const base = xdg ? expandHome(xdg) : `${homedir()}/.local/state`;
  return `${base}/self-improvement-loop`;
}

function fallbackLog(msg: string): void {
  try {
    const dir = `${fallbackStateDir()}/logs`;
    mkdirSync(dir, { recursive: true });
    appendFileSync(`${dir}/hook.log`, `${new Date().toISOString()} ${msg}\n`, "utf8");
  } catch {
    // a broken install with an unwritable state dir has nowhere left to go
  }
}

async function readPayload(): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await Bun.stdin.text();
  } catch {
    return {};
  }
  if (!raw || !raw.trim()) return {};
  try {
    const obj: unknown = JSON.parse(raw);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const started = performance.now();
  let text = "";
  let event = "";
  let logMod: typeof import("./log.ts") | null = null;

  try {
    const payload = await readPayload();
    event = typeof payload["hook_event_name"] === "string" ? payload["hook_event_name"] : "";

    const [handlersMod, snapshotMod, worldsMod, loaded] = await Promise.all([
      import("./handlers.ts"),
      import("./snapshot.ts"),
      import("./worlds.ts"),
      import("./log.ts"),
    ]);
    logMod = loaded;

    const snapshot = snapshotMod.loadSnapshot();
    const cwd = typeof payload["cwd"] === "string" && payload["cwd"] ? payload["cwd"] : process.cwd();
    const world = worldsMod.resolveWorld(snapshot, cwd);

    const handler = handlersMod.getHandler(event);
    if (handler) {
      try {
        text = handler(payload, world, snapshot) || "";
      } catch (e) {
        logMod.log(`${event} handler failed: ${logMod.excSummary(e)}`);
        text = "";
      }
    }
  } catch (e) {
    if (logMod) {
      (logMod as typeof import("./log.ts")).log(`hook invocation failed: ${(logMod as typeof import("./log.ts")).excSummary(e)}`);
    } else {
      const name = e instanceof Error ? e.constructor.name : "Error";
      fallbackLog(`hook unavailable: import failed: ${name}`);
    }
    text = "";
  }

  if (text && OUTPUT_EVENTS.has(event)) {
    try {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
    } catch {
      // stdout failure: nothing left to report it to
    }
  }

  const elapsedMs = performance.now() - started;
  if (elapsedMs > SLOW_INVOCATION_MS && logMod) {
    (logMod as typeof import("./log.ts")).log(`slow hook invocation: event=${event} elapsed_ms=${elapsedMs.toFixed(1)}`);
  }
}

try {
  await main();
} catch {
  // main() already catches everything internally; this is the last resort.
}
process.exit(0);
