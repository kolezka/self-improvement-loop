// Spawns the real `sil ops` in an inert fixture env: one request on stdin,
// exactly one response envelope on stdout, and no writes anywhere under the
// fixture root.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Database } from "bun:sqlite";
import { CONTROL_MAX_REQUEST_BYTES, decodeControlResponse } from "@sil/core/control-protocol";
import {
  createControlFixture,
  FIXTURE_CLAUDE_MARKER,
  FIXTURE_LAST_RUN,
  FIXTURE_LOG_LINE,
  FIXTURE_QUEUE,
  type ControlFixture,
} from "../../../tests/control-fixture.ts";

import { applyConsoleRead, initialConsoleState, switchConsoleWorld } from "../../hook-module/src/ui/state.ts";
import { consoleLines } from "../../hook-module/src/ui/views.ts";
import { cmdOps } from "../src/commands/ops.ts";

const CLI = join(import.meta.dir, "..", "src", "main.ts");

let fx: ControlFixture;

beforeEach(() => {
  fx = createControlFixture();
});

afterEach(() => {
  fx.cleanup();
});

// A local stand-in for any HTTP model endpoint: counts every request.
let server: ReturnType<typeof Bun.serve>;
let httpHits = 0;
beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      httpHits += 1;
      return new Response("{}", { status: 500 });
    },
  });
});
afterAll(() => {
  server.stop(true);
});

/** Every file under the fixture root, with its content hash, size and mtime. */
function inventory(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        out.set(relative(root, p) + "/", "dir");
        walk(p);
      } else {
        const hash = createHash("sha256").update(readFileSync(p)).digest("hex");
        out.set(relative(root, p), `${hash}:${st.size}:${st.mtimeMs}`);
      }
    }
  };
  walk(root);
  return out;
}

const LOOP_STATE_FILES = ["state/loop-state.sqlite", "state/loop-state.sqlite-wal", "state/loop-state.sqlite-shm"];

/** The inventory without the loop-state database files. */
function inventoryWithoutDb(root: string): Map<string, string> {
  const out = inventory(root);
  for (const name of LOOP_STATE_FILES) out.delete(name);
  return out;
}

/** Every loop-state row a read must leave alone, read from the fixture's
 * database. meta stays out: the opener refreshes fs_probed_at. */
function loopStateRows(): Record<string, unknown[]> {
  const db = new Database(join(fx.env["SIL_STATE_DIR"]!, "loop-state.sqlite"), { readonly: true });
  try {
    return {
      docs: db.query("SELECT * FROM docs ORDER BY name, world").all(),
      log_records: db.query("SELECT * FROM log_records ORDER BY id").all(),
      legacy_imports: db.query("SELECT * FROM legacy_imports ORDER BY id").all(),
      quarantine: db.query("SELECT * FROM quarantine ORDER BY id").all(),
      aliases: db.query("SELECT * FROM aliases ORDER BY world, alias").all(),
    };
  } finally {
    db.close();
  }
}

function addHttpEndpoint(): void {
  // Point a second endpoint at the counting server and make it active.
  const llm = join(fx.env["SIL_CONFIG_DIR"]!, "llm.yaml");
  const text = readFileSync(llm, "utf8").replace(
    "active: fixture-cli",
    [
      "  - name: fixture-http",
      "    kind: openai",
      `    base_url: http://127.0.0.1:${server.port}/v1`,
      "    api_key_env: SIL_FIXTURE_UNSET_KEY",
      "    models:",
      "      critic: fixture-model",
      "active: fixture-http",
    ].join("\n"),
  );
  writeFileSync(llm, text, "utf8");
}

// Async spawn: a sync spawn would block this process's event loop, and with it
// the counting server, so a child that did call it would hang, not count.
async function runOps(input: Uint8Array | string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, "ops"], {
    env: fx.env,
    cwd: fx.root,
    stdin: typeof input === "string" ? new TextEncoder().encode(input) : input,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

function request(reads: { id: string; op: string; args?: Record<string, unknown> }[], requestId = "req-1"): string {
  return JSON.stringify({ version: 1, requestId, reads: reads.map((r) => ({ id: r.id, op: r.op, args: r.args ?? {} })) });
}

describe("instrument check", () => {
  test("the fixture env can reach both model stand-ins, so a zero count means something", async () => {
    const before = httpHits;
    const probe = Bun.spawn(
      ["bun", "-e", `await fetch("http://127.0.0.1:${server.port}/v1/x").catch(() => {}); Bun.spawnSync(["claude", "-p", "x"]);`],
      { env: fx.env, cwd: fx.root },
    );
    expect(await probe.exited).toBe(0);
    expect(httpHits).toBe(before + 1);
    expect(existsSync(join(fx.root, FIXTURE_CLAUDE_MARKER))).toBe(true);
  });

  test("the inventory sees a write made by a CLI child in this env", async () => {
    const before = inventory(fx.root);
    const proc = Bun.spawn(["bun", CLI, "hook-snapshot"], { env: fx.env, cwd: fx.root, stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(0);
    const after = inventory(fx.root);
    expect(after).not.toEqual(before);
    expect(after.has("state/hook-config.json")).toBe(true);
    expect(before.has("state/hook-config.json")).toBe(false);
  });
});

describe("sil ops", () => {
  test("decodes the seeded worker status and a log line, with no writes and no model calls", async () => {
    addHttpEndpoint();
    const hitsBefore = httpHits;
    // The opener refreshes meta.fs_probed_at on every first open, so the DB bytes are not a "no writes" signal; the row snapshot is.
    const before = inventoryWithoutDb(fx.root);
    const rowsBefore = loopStateRows();
    expect(rowsBefore["docs"]!.map((d) => (d as { name: string }).name)).toContain("worker_status");
    const { code, stdout, stderr } = await runOps(
      request([
        { id: "status", op: "worker.status" },
        { id: "log", op: "logs.tail", args: { name: "worker", lines: 5 } },
        { id: "worlds", op: "worlds.list" },
        { id: "queue", op: "queue.list" },
      ]),
    );
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout.endsWith("\n")).toBe(true);
    const resp = decodeControlResponse(stdout.trimEnd(), "req-1");

    const status = resp.results["status"]!;
    if (!status.ok) throw new Error(`worker.status failed: ${JSON.stringify(status.error)}`);
    const s = status.value as { pending: number; done: number; failed: number; last_run: string };
    expect({ pending: s.pending, done: s.done, failed: s.failed }).toEqual({ ...FIXTURE_QUEUE });
    expect(s.last_run).toBe(FIXTURE_LAST_RUN);

    const log = resp.results["log"]!;
    expect(log.ok).toBe(true);
    expect(JSON.stringify(log)).toContain(FIXTURE_LOG_LINE);

    const worlds = resp.results["worlds"]!;
    expect(worlds.ok && (worlds.value as { name: string }[]).map((w) => w.name)).toEqual(["fixture"]);
    expect(resp.results["queue"]!.ok).toBe(true);

    expect(inventoryWithoutDb(fx.root)).toEqual(before);
    expect(loopStateRows()).toEqual(rowsBefore);
    expect(httpHits).toBe(hitsBefore);
    expect(existsSync(join(fx.root, FIXTURE_CLAUDE_MARKER))).toBe(false);
  });

  test("a forbidden op returns a valid envelope with a per-read error and exit 0", async () => {
    const before = inventory(fx.root);
    const { code, stdout } = await runOps(
      request([
        { id: "w", op: "worker.status" },
        { id: "c", op: "config.set", args: { config: { worlds: [] } } },
      ]),
    );
    expect(code).toBe(0);
    const resp = decodeControlResponse(stdout.trimEnd(), "req-1");
    const c = resp.results["c"]!;
    expect(!c.ok && c.error.code).toBe("OpNotAllowed");
    const w = resp.results["w"]!;
    expect(!w.ok && w.error.code).toBe("BatchRejected");
    expect(inventory(fx.root)).toEqual(before);
  });

  test("an op name with no dot is a per-read error in a valid envelope, not exit 2", async () => {
    const before = inventory(fx.root);
    const { code, stdout, stderr } = await runOps(
      request([
        { id: "w", op: "worker.status" },
        { id: "b", op: "bogus" },
      ]),
    );
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const resp = decodeControlResponse(stdout.trimEnd(), "req-1");
    const b = resp.results["b"]!;
    expect(!b.ok && b.error.code).toBe("OpNotAllowed");
    expect(JSON.stringify(b)).not.toContain("bogus");
    const w = resp.results["w"]!;
    expect(!w.ok && w.error.code).toBe("BatchRejected");
    expect(inventory(fx.root)).toEqual(before);
  });

  test("health.report is refused, so no provider is probed", async () => {
    addHttpEndpoint();
    const hitsBefore = httpHits;
    const { code, stdout } = await runOps(request([{ id: "h", op: "health.report" }]));
    expect(code).toBe(0);
    const h = decodeControlResponse(stdout.trimEnd(), "req-1").results["h"]!;
    expect(!h.ok && h.error.code).toBe("OpNotAllowed");
    expect(httpHits).toBe(hitsBefore);
    expect(existsSync(join(fx.root, FIXTURE_CLAUDE_MARKER))).toBe(false);
  });

  test.each([
    ["invalid JSON", "{nope"],
    ["unknown version", JSON.stringify({ version: 2, requestId: "r", reads: [{ id: "a", op: "worker.status", args: {} }] })],
    ["zero reads", request([])],
    ["duplicate ids", request([{ id: "a", op: "worker.status" }, { id: "a", op: "worker.status" }])],
    ["empty stdin", ""],
  ])("%s exits 2 with nothing on stdout", async (_name, input) => {
    const { code, stdout, stderr } = await runOps(input);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toStartWith("sil ops: invalid request: ");
    expect(stderr.trimEnd().split("\n").length).toBe(1);
  });

  test("malformed UTF-8 exits 2", async () => {
    const bytes = new TextEncoder().encode(request([{ id: "a", op: "logs.tail", args: { name: "worker" } }]));
    const at = new TextDecoder().decode(bytes).indexOf("worker\"}");
    bytes[at] = 0xff;
    const { code, stdout, stderr } = await runOps(bytes);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("UTF-8");
  });

  test("a request of 131073 bytes exits 2; 131072 bytes is read", async () => {
    const shell = request([{ id: "a", op: "worker.status", args: {} }]);
    const pad = CONTROL_MAX_REQUEST_BYTES - new TextEncoder().encode(shell).length;
    // Trailing whitespace is valid JSON, so the at-limit request decodes.
    const atLimit = shell + " ".repeat(pad);
    expect(new TextEncoder().encode(atLimit).length).toBe(CONTROL_MAX_REQUEST_BYTES);
    const ok = await runOps(atLimit);
    expect(ok.code).toBe(0);
    expect(decodeControlResponse(ok.stdout.trimEnd(), "req-1").results["a"]!.ok).toBe(true);

    const over = await runOps(atLimit + " ");
    expect(over.code).toBe(2);
    expect(over.stdout).toBe("");
    expect(over.stderr).toContain("too large");
  });
});

// A queue that exists but cannot be read must reach the pane as a failed read,
// never as a drained, healthy queue. Seeded records first prove the reader
// decodes real entries, so a failure afterwards is the queue's, not the probe's.
describe("sil ops queue reads", () => {
  const QUEUE_READS = request([
    { id: "worker", op: "worker.status" },
    { id: "queue", op: "queue.list" },
    { id: "worlds", op: "worlds.list" },
  ]);

  async function queueReads() {
    const { code, stdout, stderr } = await runOps(QUEUE_READS);
    expect(code).toBe(0);
    return { resp: decodeControlResponse(stdout.trimEnd(), "req-1"), stderr };
  }

  function rendered(resp: ReturnType<typeof decodeControlResponse>): string {
    const state = switchConsoleWorld(initialConsoleState(), "fixture");
    return consoleLines(applyConsoleRead(state, state.generation, resp, "2026-10-22T12:00:00Z"))
      .map((l) => l.text)
      .join("\n");
  }

  test("positive control: the seeded queue decodes", async () => {
    const { resp } = await queueReads();
    const worker = resp.results["worker"]!;
    const queue = resp.results["queue"]!;
    if (!worker.ok || !queue.ok) throw new Error(JSON.stringify(resp.results));
    expect((worker.value as { pending: number }).pending).toBe(FIXTURE_QUEUE.pending);
    expect((queue.value as { pending: { session_id: string }[] }).pending.map((e) => e.session_id).sort()).toEqual(["fixture-pending-1", "fixture-pending-2"]);
  });

  test("a pending bucket that cannot be listed fails both queue reads, and the pane says so", async () => {
    const pending = join(fx.env["SIL_STATE_DIR"]!, "queue", "pending");
    // Moved aside, not deleted: the records stay intact for inspection.
    renameSync(pending, join(fx.root, "saved-pending"));
    writeFileSync(pending, "not a directory\n");
    const { resp } = await queueReads();
    for (const id of ["worker", "queue"]) {
      const r = resp.results[id]!;
      expect(r.ok).toBe(false);
      expect(r.ok ? null : r.error.code).toBe("QueueReadError");
      expect(r.ok ? "" : r.error.message).toContain("pending");
      expect(r.ok ? "" : r.error.message).toContain("ENOTDIR");
    }
    // A read that does not touch the queue is unaffected.
    expect(resp.results["worlds"]!.ok).toBe(true);
    const text = rendered(resp);
    expect(text).not.toContain("Last complete refresh");
    expect(text).not.toMatch(/Pending: 0/);
    expect(text).toContain("QueueReadError");
    expect(readdirSync(join(fx.root, "saved-pending")).sort()).toEqual(["fixture-pending-1.json", "fixture-pending-2.json"]);
  });

  test("an entry that cannot be parsed fails the count instead of shrinking it", async () => {
    writeFileSync(join(fx.env["SIL_STATE_DIR"]!, "queue", "done", "corrupt.json"), "{");
    const { resp } = await queueReads();
    for (const id of ["worker", "queue"]) {
      const r = resp.results[id]!;
      expect(r.ok).toBe(false);
      expect(r.ok ? null : r.error.code).toBe("QueueReadError");
      expect(r.ok ? "" : r.error.message).toContain("corrupt.json");
    }
  });

  test("a bucket that does not exist yet still reads as empty", async () => {
    const pending = join(fx.env["SIL_STATE_DIR"]!, "queue", "pending");
    renameSync(pending, join(fx.root, "saved-pending"));
    const { resp } = await queueReads();
    const worker = resp.results["worker"]!;
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    expect((worker.value as { pending: number; done: number }).pending).toBe(0);
    expect((worker.value as { pending: number; done: number }).done).toBe(FIXTURE_QUEUE.done);
    expect(resp.results["queue"]!.ok).toBe(true);
    mkdirSync(pending);
  });
});

describe("cmdOps stdin bound", () => {
  // Finite on purpose: with the bound removed the read still ends, and the
  // pulled-bytes assertion fails instead of the runner hanging.
  const CHUNK = 4096;
  const TOTAL_CHUNKS = (4 * 1024 * 1024) / CHUNK;

  test("an oversized stream is refused after the byte limit, not read to the end", async () => {
    let pulled = 0;
    const big = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (pulled >= TOTAL_CHUNKS * CHUNK) {
            controller.close();
            return;
          }
          pulled += CHUNK;
          controller.enqueue(new Uint8Array(CHUNK).fill(0x20));
        },
      },
      { highWaterMark: 0 },
    );
    const writes: string[] = [];
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
    let code: number;
    try {
      code = await cmdOps(big, async (t) => writes.push(t));
    } finally {
      console.error = realError;
    }
    expect(code).toBe(2);
    expect(writes).toEqual([]);
    expect(errors).toEqual([`sil ops: invalid request: request: too large (over ${CONTROL_MAX_REQUEST_BYTES} bytes)`]);
    expect(pulled).toBeGreaterThan(CONTROL_MAX_REQUEST_BYTES);
    expect(pulled).toBeLessThanOrEqual(CONTROL_MAX_REQUEST_BYTES + 2 * CHUNK);
  });
});

describe("cmdOps output failure", () => {
  test("a failed write resolves to exit 1 with one bounded diagnostic and no stack", async () => {
    const body = new TextEncoder().encode(request([{ id: "a", op: "health.build" }]));
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    });
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
    let code: number;
    try {
      code = await cmdOps(input, async () => {
        const e = new Error("EPIPE: broken pipe, write api_key=fixture-secret-value");
        e.stack = "Error: EPIPE\n    at write (/Users/someone/x.ts:1:1)";
        throw e;
      });
    } finally {
      console.error = realError;
    }
    expect(code).toBe(1);
    expect(errors.length).toBe(1);
    expect(errors[0]).toStartWith("sil ops: could not write the response: ");
    expect(errors[0]).not.toContain("fixture-secret-value");
    expect(errors[0]).not.toContain("    at ");
    expect(errors[0]!.length).toBeLessThan(700);
  });
});
