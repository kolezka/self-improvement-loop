// Find OpenClaw session transcripts.
//
// One JSONL file per session under <openclawDir>/agents/<agentId>/sessions/.
// The first record of a transcript is the header: it carries the session id
// and the cwd the agent ran in, which is what maps a session to a sil world.

import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fsx } from "@sil/core";
import * as ocPaths from "./paths.ts";

export interface OpenclawSession {
  agent_id: string;
  session_id: string;
  file: string;
  cwd: string;
  mtime_ms: number;
}

function readDirOr(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** The cwd from the transcript header, or null when the file has no header. */
export function sessionCwd(file: string): string | null {
  let text: string;
  try {
    text = fsx.readText(file);
  } catch {
    return null;
  }
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n")).trim();
  if (!firstLine) return null;
  try {
    const rec: unknown = JSON.parse(firstLine);
    if (rec && typeof rec === "object" && !Array.isArray(rec)) {
      const cwd = (rec as Record<string, unknown>)["cwd"];
      if (typeof cwd === "string" && cwd) return cwd;
    }
  } catch {
    // a torn first line means no header, not a broken transcript
  }
  return null;
}

/** Every session transcript on disk, newest last. */
export function listSessions(env: NodeJS.ProcessEnv = process.env): OpenclawSession[] {
  const root = ocPaths.agentsDir(env);
  const fallbackCwd = ocPaths.workspaceDir(env);
  const out: OpenclawSession[] = [];

  for (const agentId of readDirOr(root)) {
    const sessionsDir = join(root, agentId, "sessions");
    for (const name of readDirOr(sessionsDir)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(sessionsDir, name);
      let mtime: number;
      try {
        mtime = statSync(file).mtimeMs;
      } catch {
        continue;
      }
      out.push({
        agent_id: agentId,
        session_id: basename(name, ".jsonl"),
        file,
        cwd: sessionCwd(file) ?? fallbackCwd,
        mtime_ms: mtime,
      });
    }
  }
  out.sort((a, b) => a.mtime_ms - b.mtime_ms);
  return out;
}

/** One session by id, optionally scoped to an agent. */
export function findSession(sessionId: string, agentId?: string, env: NodeJS.ProcessEnv = process.env): OpenclawSession | null {
  for (const session of listSessions(env)) {
    if (session.session_id !== sessionId) continue;
    if (agentId && session.agent_id !== agentId) continue;
    return session;
  }
  return null;
}
