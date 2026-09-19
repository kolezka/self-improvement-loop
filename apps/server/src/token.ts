// The web UI token, kept in a 0600 file under the state dir.
//
// It used to be random per start. `sil web` now exits on a plugin update so
// the supervisor restarts it on the new version, and a new token each time
// would break every tab that is already open (the UI keeps the token from the
// URL fragment in sessionStorage). Rotate by deleting the file and restarting.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "@sil/core";

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Read the stored token, or create one. Never returns an empty string. */
export function loadOrCreateToken(file: string = paths.webTokenFile()): string {
  try {
    const stored = readFileSync(file, "utf8").trim();
    if (stored) return stored;
  } catch {
    // no file yet, or unreadable: write a fresh one below
  }
  const token = newToken();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, token + "\n", { mode: 0o600 });
  // writeFileSync only applies mode when it creates the file; an existing
  // unreadable or world readable one keeps its old bits without this.
  chmodSync(file, 0o600);
  return token;
}
