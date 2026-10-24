// Coarse credential check for human-reviewed text. A guard, not a guarantee.
// Pure, so the native console can screen a field before it enters state.

import { redactCredentials } from "./samples.ts";

// Coarse secret sniff. High-signal tokens only. Moved unchanged from
// curriculum/lint.ts, which re-exports it.
export const SECRET_RE =
  /(AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(api[_-]?key|secret|token|password)\s*[:=]\s*['"]?[A-Za-z0-9/+_-]{16,})/i;

export function containsSensitiveText(text: string): boolean {
  return SECRET_RE.test(text) || redactCredentials(text) !== text;
}
