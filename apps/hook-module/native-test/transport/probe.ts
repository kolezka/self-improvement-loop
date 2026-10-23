// Test-only hooks module for the transport native tests. Never shipped: it is
// bundled only into the throwaway probe plugin scripts/test-native.ts lays out.
//
// An inline test plugin closes over nothing of its test file, so it cannot
// call the real readControl. This entry imports the production helper and
// answers one literal command with what it returned or threw, so the native
// engine runs the actual transport against the test's mocked process.run.

import type { On } from "claude-code";
import { readControl, runControlProcess } from "../../src/ui/transport.ts";

const SENTINEL = "sk-probe-private-0123456789 at /private/probe/path";

function outcome(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown; message?: unknown; stack?: unknown };
  return JSON.stringify({
    ok: false,
    name: String(e?.name),
    code: String(e?.code),
    message: String(e?.message),
    leaked: String(e?.stack).includes(SENTINEL) || String(e?.message).includes(SENTINEL),
  });
}

/** Args that pass shape validation but cannot be encoded. Built here, in the
 * probe, because a command's text argument can only carry JSON. */
function badArgs(kind: string): Record<string, unknown> {
  if (kind === "toJSON") return { filter: { toJSON: () => { throw new Error(SENTINEL); } } };
  if (kind === "bigint") return { lines: BigInt(10) };
  if (kind === "cyclic") {
    const args: Record<string, unknown> = { name: "worker" };
    args["self"] = args;
    return args;
  }
  throw new Error(`probe: unknown bad args kind ${kind}`);
}

// A top level function declaration: `claude plugin validate` wants it so.
export function register(on: On): void {
  on("command.run", { command: "sil-transport-probe" }, async ($, e) => {
    try {
      const input = JSON.parse(e.args) as { raw?: string; request?: unknown; bad?: string };
      if (typeof input.bad === "string") {
        const args = badArgs(input.bad);
        const response = await readControl($, {
          version: 1,
          requestId: "probe-bad",
          reads: [{ id: "a", op: "logs.tail", args }],
        });
        return { text: JSON.stringify({ ok: true, response }) };
      }
      if (typeof input.raw === "string") {
        const text = await runControlProcess($, input.raw);
        return { text: JSON.stringify({ ok: true, text }) };
      }
      const response = await readControl($, input.request as Parameters<typeof readControl>[1]);
      return { text: JSON.stringify({ ok: true, response }) };
    } catch (err) {
      return { text: outcome(err) };
    }
  });
}
