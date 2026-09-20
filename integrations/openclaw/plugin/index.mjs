// self-improvement-loop plugin for OpenClaw.
//
// Three jobs, all of them thin. The work happens in the sil CLI:
//   session_start / gateway_start  ->  sil openclaw sync    (lessons in, workspace file)
//   session_end                    ->  sil openclaw enqueue (session out, reflection queue)
//   after_tool_call                ->  one usage event when a skill file is read
//
// Every handler is fire and forget. A slow or missing sil must never delay an
// agent turn, so the CLI is spawned detached and nothing is awaited.

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(HERE, "sil-config.json");

// A read of a skill file is how a skill gets used in OpenClaw: there is no
// Skill tool, the agent just opens SKILL.md.
const SKILL_PATH_RE = /(?:^|\/)skills\/([A-Za-z0-9][A-Za-z0-9._-]*)\/SKILL\.md$/;

function readInstallConfig() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/** Install time config file, overridden by plugins.entries.<id>.config. */
function resolveSettings(api) {
  const file = readInstallConfig();
  const user = api.pluginConfig ?? {};
  return {
    sil: user.sil ?? file.sil ?? "sil",
    world: user.world ?? file.world ?? "",
    stateDir: user.stateDir ?? file.state_dir ?? "",
    bootstrapFile: user.bootstrapFile ?? file.bootstrap_file ?? "",
    sync: user.sync !== false,
    reflect: user.reflect !== false,
  };
}

function runSil(api, settings, args) {
  const argv = settings.world ? [...args, "--world", settings.world] : args;
  try {
    const child = spawn(settings.sil, argv, { detached: true, stdio: "ignore" });
    child.on("error", (err) => api.logger.warn(`sil ${argv[0]} ${argv[1]} failed: ${err.message}`));
    child.unref();
  } catch (err) {
    api.logger.warn(`sil spawn failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function appendUsageEvent(api, settings, event) {
  if (!settings.stateDir) return;
  const path = join(settings.stateDir, "usage", "events.jsonl");
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
  } catch (err) {
    api.logger.warn(`usage event write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export default function register(api) {
  const settings = resolveSettings(api);

  // session_start only fires on a new session (/new, /reset, auto-reset), so
  // `sil openclaw scan` stays the safety net for everything else.
  if (settings.sync) {
    const sync = () => {
      const args = ["openclaw", "sync"];
      if (settings.bootstrapFile) args.push("--file", settings.bootstrapFile);
      runSil(api, settings, args);
    };
    api.on("session_start", sync);
    api.on("gateway_start", sync);
  }

  if (settings.reflect) {
    api.on("session_end", (event, ctx) => {
      const sessionId = event?.sessionId;
      if (!sessionId) return;
      const args = ["openclaw", "enqueue", "--session", String(sessionId), "--ended"];
      if (ctx?.agentId) args.push("--agent", String(ctx.agentId));
      runSil(api, settings, args);
    });
  }

  api.on("after_tool_call", (event, ctx) => {
    if (event?.error) return;
    if (event?.toolName !== "read") return;
    const path = event?.params?.path;
    if (typeof path !== "string") return;
    const match = SKILL_PATH_RE.exec(path);
    if (!match) return;

    // No params beyond the skill name: tool params are free text and can carry
    // anything the agent was working on.
    appendUsageEvent(api, settings, {
      ts: new Date().toISOString(),
      session_id: ctx?.sessionKey ?? "",
      world: settings.world || "default",
      kind: "skill",
      ref: `skill:${match[1]}`,
      detail: {},
    });
  });
}
