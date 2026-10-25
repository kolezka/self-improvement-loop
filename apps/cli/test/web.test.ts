// `sil web` when its port is already bound. The launchd/systemd web job keeps
// one instance up, and `/loop web` from any Claude session (any config dir)
// runs `sil web` again. That second start must not crash with EADDRINUSE: a
// running SIL web UI on the port is the normal case and gets its URL printed
// with exit 0; a foreign listener is a clear error with exit 1, no stack trace.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../server/src/main.ts";
import { cmdWeb } from "../src/commands/web.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};
const stops: Array<() => void> = [];
let out: string[];
let err: string[];
const realLog = console.log;
const realError = console.error;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-web-cmd-"));
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR", "CLAUDE_PLUGIN_ROOT"]) {
    saved[k] = process.env[k];
    process.env[k] = join(tmp, k.toLowerCase());
    mkdirSync(process.env[k]!, { recursive: true });
  }
  writeFileSync(join(process.env["SIL_CONFIG_DIR"]!, "config.yaml"), "version: 1\nworlds: []\n");
  out = [];
  err = [];
  console.log = (...args: unknown[]) => void out.push(args.join(" "));
  console.error = (...args: unknown[]) => void err.push(args.join(" "));
});

afterEach(() => {
  console.log = realLog;
  console.error = realError;
  for (const stop of stops.splice(0)) stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("sil web on a port that is already bound", () => {
  test("a running SIL web UI: prints its URL and exits 0", async () => {
    const running = createServer({ port: 0, host: "127.0.0.1", token: null });
    stops.push(() => running.stop(true));
    const port = running.port!;

    const code = await cmdWeb({ port, host: "127.0.0.1", watch: false });

    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("already running");
    expect(text).toContain(`http://127.0.0.1:${port}/`);
    expect(err).toEqual([]);
  });

  test("a foreign listener: names the port, exits 1, no throw", async () => {
    const other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("not sil", { status: 404 }) });
    stops.push(() => other.stop(true));
    const port = other.port!;

    const code = await cmdWeb({ port, host: "127.0.0.1", watch: false });

    expect(code).toBe(1);
    const text = err.join("\n");
    expect(text).toContain(`${port}`);
    expect(text).toContain("not the SIL web UI");
    expect(text).not.toContain("    at ");
    expect(out.join("\n")).not.toContain("http://");
  });
});
