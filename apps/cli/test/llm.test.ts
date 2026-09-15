import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLlm } from "@sil/core";
import type { Deps } from "../src/deps.ts";
import { run } from "../src/main.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-llm-"));
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"]) {
    saved[k] = process.env[k];
    process.env[k] = join(tmp, k.toLowerCase());
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

/** Providers are the only dep `sil llm` touches, and only for reachability. */
function fakeDeps(): Deps {
  return {
    worker: {} as Deps["worker"],
    feedback: {} as Deps["feedback"],
    providers: {
      status: async () => ({
        endpoint: "litellm",
        kind: "openai",
        base_url: "http://100.64.0.3:4000",
        models: { critic: "zai/glm-5.3-flash", drafter: "zai/glm-5.3-flash", judge: "zai/glm-5.3-flash" },
        reachable: true,
        error: null,
        endpoints: [
          { name: "litellm", kind: "openai", base_url: "http://100.64.0.3:4000", active: true, roles: ["critic", "drafter", "judge"], models: {}, reachable: true, error: null },
          { name: "claude", kind: "claude-cli", base_url: null, active: false, roles: [], models: { critic: "sonnet" }, reachable: false, error: "not installed" },
        ],
      }),
    } as unknown as Deps["providers"],
    review: {} as Deps["review"],
    curriculum: {} as Deps["curriculum"],
  };
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => out.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => err.push(args.map(String).join(" "));
  try {
    const code = await fn();
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

async function init(): Promise<void> {
  const r = await capture(() => run(["init", "--model", "zai/glm-5.3-flash"]));
  expect(r.code).toBe(0);
}

describe("sil llm use", () => {
  test("switches every role and clears the per role overrides", async () => {
    await init();
    let r = await capture(() => run(["llm", "use", "litellm", "--role", "drafter"]));
    expect(r.code).toBe(0);
    expect(loadLlm().role_endpoints).toEqual({ drafter: "litellm" });

    r = await capture(() => run(["llm", "use", "claude"]));
    expect(r.code).toBe(0);
    const llm = loadLlm();
    expect(llm.active).toBe("claude");
    expect(llm.role_endpoints).toEqual({});
    expect(r.out).toContain("critic  -> claude: sonnet");
  });

  test("--role sets only that role and leaves active alone", async () => {
    await init();
    let r = await capture(() => run(["llm", "use", "claude"]));
    expect(r.code).toBe(0);

    r = await capture(() => run(["llm", "use", "litellm", "--role", "drafter"]));
    expect(r.code).toBe(0);
    const llm = loadLlm();
    expect(llm.active).toBe("claude");
    expect(llm.role_endpoints).toEqual({ drafter: "litellm" });
    expect(r.out).toContain("critic  -> claude: sonnet");
    expect(r.out).toContain("drafter -> litellm: zai/glm-5.3-flash");
  });

  test("an unknown endpoint exits 2 and writes nothing", async () => {
    await init();
    const before = loadLlm();
    const r = await capture(() => run(["llm", "use", "nope"]));
    expect(r.code).toBe(2);
    expect(r.err).toContain("nope");
    expect(loadLlm().active).toBe(before.active);
  });

  test("an unknown role exits 2", async () => {
    await init();
    const r = await capture(() => run(["llm", "use", "claude", "--role", "painter"]));
    expect(r.code).toBe(2);
    expect(r.err).toContain("painter");
  });
});

describe("sil llm set-model", () => {
  test("writes the model onto the named endpoint", async () => {
    await init();
    const r = await capture(() => run(["llm", "set-model", "critic", "opus", "--endpoint", "claude"]));
    expect(r.code).toBe(0);
    const claude = loadLlm().endpoints.find((e) => e.name === "claude")!;
    expect(claude.models.critic).toBe("opus");
    // the other endpoint is untouched
    expect(loadLlm().endpoints.find((e) => e.name === "litellm")!.models.critic).toBe("zai/glm-5.3-flash");
  });

  test("without --endpoint it writes to the endpoint that currently serves the role", async () => {
    await init();
    let r = await capture(() => run(["llm", "use", "claude", "--role", "judge"]));
    expect(r.code).toBe(0);

    r = await capture(() => run(["llm", "set-model", "judge", "haiku"]));
    expect(r.code).toBe(0);
    expect(loadLlm().endpoints.find((e) => e.name === "claude")!.models.judge).toBe("haiku");
  });

  test("an unknown endpoint exits 2", async () => {
    await init();
    const r = await capture(() => run(["llm", "set-model", "critic", "x", "--endpoint", "nope"]));
    expect(r.code).toBe(2);
  });
});

describe("sil llm list", () => {
  test("--json reports endpoints and role routing", async () => {
    await init();
    let r = await capture(() => run(["llm", "use", "claude", "--role", "critic"]));
    expect(r.code).toBe(0);

    r = await capture(() => run(["llm", "list", "--json"], fakeDeps()));
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.out) as {
      active: string | null;
      endpoints: { name: string; kind: string; base_url: string | null; active: boolean; reachable: boolean | null }[];
      roles: { role: string; endpoint: string | null; model: string | null; error: string | null }[];
    };
    expect(payload.active).toBe("litellm");
    expect(payload.endpoints.map((e) => e.name)).toEqual(["litellm", "claude"]);
    expect(payload.endpoints[0]!.reachable).toBe(true);
    expect(payload.endpoints[1]!.reachable).toBe(false);
    expect(payload.roles).toEqual([
      { role: "critic", endpoint: "claude", model: "sonnet", error: null },
      { role: "drafter", endpoint: "litellm", model: "zai/glm-5.3-flash", error: null },
      { role: "judge", endpoint: "litellm", model: "zai/glm-5.3-flash", error: null },
    ]);
  });

  test("the table names each endpoint, the active one and the role routing", async () => {
    await init();
    const r = await capture(() => run(["llm", "list"], fakeDeps()));
    expect(r.code).toBe(0);
    expect(r.out).toContain("litellm");
    expect(r.out).toContain("http://100.64.0.3:4000");
    expect(r.out).toContain("claude -p");
    expect(r.out).toContain("critic  -> litellm: zai/glm-5.3-flash");
  });
});
