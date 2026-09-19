// Handler behavior through invoke(), with @sil/review, @sil/providers,
// @sil/worker, @sil/feedback and node:child_process swapped via the deps
// seam. Each test restores deps in a finally block so a failure never leaks
// a fake into a later test.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmConfig, loadLlm, paths, QueueEntry, saveLlm, type World } from "@sil/core";
import { writeEntry, type Bucket } from "@sil/store";
import { deps, invoke, setDeps, type Deps } from "../src/index.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-ops-handlers-"));
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR", "CLAUDE_PLUGIN_ROOT"]) {
    saved[k] = process.env[k];
    process.env[k] = join(tmp, k.toLowerCase());
  }
  delete process.env["SIL_TEST_SECRET"];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete process.env["SIL_TEST_SECRET"];
  rmSync(tmp, { recursive: true, force: true });
});

describe("llm.get", () => {
  test("never returns the value behind an env var, only its name", async () => {
    process.env["SIL_TEST_SECRET"] = "sk-super-secret-value";
    saveLlm(LlmConfig.parse({ endpoints: [{ name: "e1", base_url: "http://x", api_key_env: "SIL_TEST_SECRET" }] }));

    const result = await invoke("llm.get", {});
    const asText = JSON.stringify(result);
    expect(asText).not.toContain("sk-super-secret-value");
    expect(asText).toContain("SIL_TEST_SECRET");

    const llm = result as { endpoints: { api_key_env: string | null }[] };
    expect(llm.endpoints[0]!.api_key_env).toBe("SIL_TEST_SECRET");
  });

  test("round trips through loadLlm directly (sanity check on the fixture)", () => {
    saveLlm(LlmConfig.parse({ endpoints: [{ name: "e1" }] }));
    expect(loadLlm().endpoints[0]!.name).toBe("e1");
  });
});

function fakeSpawn(captured: { cmd: string; args: string[]; opts: unknown }[]) {
  return (cmd: string, args: readonly string[], opts: unknown) => {
    captured.push({ cmd, args: [...args], opts });
    return { pid: 4242, unref: () => {} } as unknown as ReturnType<Deps["spawn"]>;
  };
}

describe("loop.run", () => {
  test("spawns detached, falling back to source when dist/cli.js is missing", async () => {
    const captured: { cmd: string; args: string[]; opts: unknown }[] = [];
    const restore = setDeps({ spawn: fakeSpawn(captured) as unknown as Deps["spawn"] });
    try {
      const result = (await invoke("loop.run", { world: "default" })) as { pid: number; log: string };
      expect(result.pid).toBe(4242);
      expect(result.log).toBe(paths.logFile("worker"));
      expect(captured).toHaveLength(1);
      const call = captured[0]!;
      expect(call.cmd).toBe("bun");
      expect(call.args).toEqual(["run", join(paths.pluginRoot(), "apps", "cli", "src", "main.ts"), "worker", "--once", "--world", "default"]);
      expect((call.opts as { detached?: boolean }).detached).toBe(true);
    } finally {
      restore();
    }
  });

  test("prefers dist/cli.js when the bundle exists", async () => {
    const distCli = join(paths.pluginRoot(), "dist", "cli.js");
    await Bun.write(distCli, "// fake bundle for the test\n");
    expect(existsSync(distCli)).toBe(true);

    const captured: { cmd: string; args: string[]; opts: unknown }[] = [];
    const restore = setDeps({ spawn: fakeSpawn(captured) as unknown as Deps["spawn"] });
    try {
      await invoke("loop.run", { world: "default" });
      const call = captured[0]!;
      expect(call.cmd).toBe("bun");
      expect(call.args).toEqual([distCli, "worker", "--once", "--world", "default"]);
    } finally {
      restore();
    }
  });
});

describe("curriculum.run", () => {
  test("spawns a detached curriculum run --apply for the world", async () => {
    const captured: { cmd: string; args: string[]; opts: unknown }[] = [];
    const restore = setDeps({ spawn: fakeSpawn(captured) as unknown as Deps["spawn"] });
    try {
      const result = (await invoke("curriculum.run", { world: "default" })) as { pid: number; log: string };
      expect(result.log).toBe(paths.logFile("curriculum"));
      const call = captured[0]!;
      expect(call.args).toEqual(["run", join(paths.pluginRoot(), "apps", "cli", "src", "main.ts"), "curriculum", "run", "--apply", "--world", "default"]);
    } finally {
      restore();
    }
  });
});

describe("skill.accept", () => {
  test("passes a World object (not a bare name) and the exact digest to review.accept", async () => {
    const seen: { world: unknown; pattern: string; reviewedState: string }[] = [];
    const restore = setDeps({
      review: {
        ...deps.review,
        accept: (world: World, _cfg, pattern: string, reviewedState: string) => {
          seen.push({ world, pattern, reviewedState });
          return { merged: true, status: "promoted", pattern, branch: "b", artifact_type: "skill", commit: "abc", link: null, branch_deleted: true } as never;
        },
      },
    });
    try {
      const digest = "a".repeat(64);
      await invoke("skill.accept", { world: "default", pattern: "foo-bar", reviewed_state: digest });
      expect(seen).toHaveLength(1);
      const call = seen[0]!;
      expect(typeof call.world).toBe("object");
      expect(call.world).not.toBeNull();
      expect((call.world as World).name).toBe("default");
      expect((call.world as World).layout).toBeDefined();
      expect(call.pattern).toBe("foo-bar");
      expect(call.reviewedState).toBe(digest);
    } finally {
      restore();
    }
  });
});

describe("router.retire", () => {
  test("passes a World object and the pattern through to review.retire", async () => {
    const seen: { world: unknown; pattern: string }[] = [];
    const restore = setDeps({
      review: {
        ...deps.review,
        retire: (world: World, _cfg, pattern: string) => {
          seen.push({ world, pattern });
          return { branch: "b", pattern, removed: "path" } as never;
        },
      },
    });
    try {
      await invoke("router.retire", { world: "default", pattern: "foo-bar", confirm: true });
      expect(seen).toHaveLength(1);
      expect((seen[0]!.world as World).name).toBe("default");
      expect(seen[0]!.pattern).toBe("foo-bar");
    } finally {
      restore();
    }
  });
});

describe("health.report", () => {
  test("passes World objects, never bare names, to providers.status", async () => {
    const seen: unknown[] = [];
    const restore = setDeps({
      providers: {
        ...deps.providers,
        status: async (world: World) => {
          seen.push(world);
          return { endpoint: null, kind: null, base_url: null, models: {}, reachable: true, error: null, endpoints: [] };
        },
      },
    });
    try {
      const report = (await invoke("health.report", {})) as { providers: Record<string, unknown>; worlds: string[] };
      expect(report.worlds).toEqual(["default"]);
      expect(seen).toHaveLength(1);
      const world = seen[0];
      expect(typeof world).toBe("object");
      expect(world).not.toBeNull();
      expect((world as World).name).toBe("default");
      expect((world as World).layout).toBeDefined();
      // Guard against the historical bug: a bare world name string also has
      // typeof "object"? No, it does not; this assertion would catch it.
      expect(typeof world).not.toBe("string");
    } finally {
      restore();
    }
  });

  test("captures a provider error per world instead of failing the whole report", async () => {
    const restore = setDeps({
      providers: {
        ...deps.providers,
        status: async () => {
          throw new Error("boom");
        },
      },
    });
    try {
      const report = (await invoke("health.report", {})) as { providers: Record<string, { error?: string }> };
      expect(report.providers["default"]!.error).toContain("boom");
    } finally {
      restore();
    }
  });
});

describe("worker.status op", () => {
  test("delegates to deps.worker.status()", async () => {
    const fixed = { lock_held: false, lock_pid: null, pending: 0, done: 0, failed: 0, last_run: null, last_summary: null, last_curriculum: {} };
    const restore = setDeps({ worker: { ...deps.worker, status: () => fixed } });
    try {
      const result = await invoke("worker.status", {});
      expect(result).toEqual(fixed);
    } finally {
      restore();
    }
  });
});

function fakeEntry(sessionId: string, lastStop: string) {
  return QueueEntry.parse({
    session_id: sessionId,
    transcript_path: "/tmp/t.jsonl",
    cwd: "/tmp",
    world: "default",
    first_stop: lastStop,
    last_stop: lastStop,
  });
}

describe("queue.list", () => {
  test("caps each bucket at 200 and returns newest first by last_stop", async () => {
    const bucket: Bucket = "pending";
    for (let i = 0; i < 250; i++) {
      const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      writeEntry(bucket, fakeEntry(`s${String(i).padStart(4, "0")}`, ts));
    }
    const result = (await invoke("queue.list", {})) as { pending: { session_id: string; last_stop: string }[] };
    expect(result.pending).toHaveLength(200);
    // Newest last_stop values (the last 200 written) come first.
    expect(result.pending[0]!.session_id).toBe("s0249");
    expect(result.pending[199]!.session_id).toBe("s0050");
  });
});

describe("config.set", () => {
  test("validates, saves config.yaml and refreshes the hook snapshot", async () => {
    const result = (await invoke("config.set", { config: { worlds: [{ name: "w1" }] } })) as { worlds: { name: string }[] };
    expect(result.worlds[0]!.name).toBe("w1");
    expect(existsSync(paths.configFile())).toBe(true);
    expect(existsSync(paths.hookSnapshotFile())).toBe(true);
  });

  test("rejects an invalid config shape", async () => {
    await expect(invoke("config.set", { config: { worlds: "not-an-array" } })).rejects.toThrow();
  });
});

describe("feedback.add", () => {
  test("stamps a server side timestamp and routes through feedback.recordHuman", async () => {
    const seen: { ref: string; vote: string; note: string; ts: string }[] = [];
    const restore = setDeps({
      feedback: {
        ...deps.feedback,
        recordHuman: (fb) => {
          seen.push(fb as never);
          return "/tmp/fb.jsonl";
        },
      },
    });
    try {
      await invoke("feedback.add", { world: "default", ref: "skill:foo-bar", vote: "good", note: "worked well" });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.ref).toBe("skill:foo-bar");
      expect(seen[0]!.vote).toBe("good");
      expect(seen[0]!.note).toBe("worked well");
      expect(typeof seen[0]!.ts).toBe("string");
      expect(seen[0]!.ts.length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });
});

describe("llm.use", () => {
  function twoEndpoints() {
    saveLlm(
      LlmConfig.parse({
        endpoints: [
          { name: "litellm", kind: "openai", base_url: "http://100.64.0.3:4000", models: { critic: "zai/glm-5.3-flash", drafter: "zai/glm-5.3-flash", judge: "zai/glm-5.3-flash" } },
          { name: "claude", kind: "claude-cli", models: { critic: "sonnet", drafter: "sonnet", judge: "sonnet" } },
        ],
        active: "litellm",
      }),
    );
  }

  test("switching every role sets active and clears the role overrides", async () => {
    twoEndpoints();
    await invoke("llm.use", { endpoint: "claude", role: "drafter" });
    expect(loadLlm().role_endpoints).toEqual({ drafter: "claude" });

    const result = (await invoke("llm.use", { endpoint: "claude" })) as { active: string | null };
    expect(result.active).toBe("claude");
    const llm = loadLlm();
    expect(llm.active).toBe("claude");
    expect(llm.role_endpoints).toEqual({});
  });

  test("a role switch leaves active alone", async () => {
    twoEndpoints();
    await invoke("llm.use", { endpoint: "claude", role: "critic" });
    const llm = loadLlm();
    expect(llm.active).toBe("litellm");
    expect(llm.role_endpoints).toEqual({ critic: "claude" });
  });

  test("an unknown endpoint is a ConfigError and writes nothing", async () => {
    twoEndpoints();
    await expect(invoke("llm.use", { endpoint: "nope" })).rejects.toThrow(/nope/);
    expect(loadLlm().active).toBe("litellm");
  });

  test("an unknown role fails validation before any handler runs", async () => {
    twoEndpoints();
    await expect(invoke("llm.use", { endpoint: "claude", role: "painter" })).rejects.toThrow();
    expect(loadLlm().role_endpoints).toEqual({});
  });
});

describe("llm.status", () => {
  test("reports one row per endpoint plus the critic endpoint at the top level", async () => {
    // No base_url and no claude-cli endpoint: the probe never touches the
    // network or spawns anything.
    saveLlm(
      LlmConfig.parse({
        endpoints: [
          { name: "a", kind: "openai", models: { critic: "m-a" } },
          { name: "b", kind: "openai", models: { drafter: "m-b", judge: "m-b" } },
        ],
        active: "a",
        role_endpoints: { drafter: "b", judge: "b" },
      }),
    );

    const result = (await invoke("llm.status", { world: "default" })) as {
      endpoint: string | null;
      models: Record<string, string | null>;
      endpoints: { name: string; kind: string; active: boolean; roles: string[]; models: Record<string, string>; reachable: boolean | null; error: string | null }[];
    };

    expect(result.endpoint).toBe("a");
    expect(result.models).toEqual({ critic: "m-a", drafter: "m-b", judge: "m-b" });
    expect(result.endpoints.map((e) => e.name)).toEqual(["a", "b"]);
    expect(result.endpoints[0]!.active).toBe(true);
    expect(result.endpoints[0]!.roles).toEqual(["critic"]);
    expect(result.endpoints[1]!.active).toBe(false);
    expect(result.endpoints[1]!.roles).toEqual(["drafter", "judge"]);
    expect(result.endpoints[1]!.models).toEqual({ drafter: "m-b", judge: "m-b" });
    expect(result.endpoints[0]!.reachable).toBe(false);
    expect(result.endpoints[0]!.error).toContain("base_url");
  });
});

// health.build answers two different questions with one call: the browser can
// fix a new build by reloading, the server process cannot.
describe("health.build", () => {
  function writeSrcHash(hash: string, mtimeMs: number): void {
    const dist = join(paths.pluginRoot(), "dist");
    mkdirSync(dist, { recursive: true });
    const file = join(dist, ".srchash");
    writeFileSync(file, hash + "\n");
    utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  }

  test("reports the hash on disk, trimmed", async () => {
    writeSrcHash("deadbeef", Date.now());
    const info = (await invoke("health.build", {})) as { build: string };
    expect(info.build).toBe("deadbeef");
  });

  test("reports a null build when there is no dist/, not an error", async () => {
    const info = (await invoke("health.build", {})) as { build: string | null; server_stale: boolean };
    expect(info.build).toBeNull();
    expect(info.server_stale).toBe(false);
  });

  test("calls the server stale when dist/ was written after the process started", async () => {
    writeSrcHash("newbuild", Date.now());
    const info = (await invoke("health.build", {})) as { server_stale: boolean };
    expect(info.server_stale).toBe(true);
  });

  test("does not call the server stale for a build older than the process", async () => {
    const started = Date.now() - process.uptime() * 1000;
    writeSrcHash("oldbuild", started - 60_000);
    const info = (await invoke("health.build", {})) as { server_stale: boolean };
    expect(info.server_stale).toBe(false);
  });

  test("reads disk on every call, so an update mid run is seen", async () => {
    writeSrcHash("first", Date.now());
    expect(((await invoke("health.build", {})) as { build: string }).build).toBe("first");
    writeSrcHash("second", Date.now());
    expect(((await invoke("health.build", {})) as { build: string }).build).toBe("second");
  });
});
