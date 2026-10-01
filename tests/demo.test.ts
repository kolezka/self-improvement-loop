// The demo recorder runs repo code against a fake home. Its child env must be
// built from scratch: anything inherited can point git at the operator's repo
// or carry their secrets into the demo processes.

import { afterEach, describe, expect, test } from "bun:test";

import { demoEnv } from "../scripts/demo/seed.ts";

const INJECTED = {
  GIT_DIR: "/operator/repo/.git",
  GIT_WORK_TREE: "/operator/repo",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/operator/hooks",
  GIT_TEMPLATE_DIR: "/operator/templates",
  SIL_DEMO_TEST_SECRET: "do-not-leak",
  XDG_DATA_HOME: "/operator/.local/share",
};

afterEach(() => {
  for (const key of Object.keys(INJECTED)) delete process.env[key];
});

describe("demoEnv", () => {
  test("keeps inherited git overrides, secrets and XDG roots out", () => {
    Object.assign(process.env, INJECTED);
    const env = demoEnv("/tmp/sil-demo-root", "/repo");
    for (const key of Object.keys(INJECTED)) expect(Object.hasOwn(env, key)).toBe(false);
  });

  test("points every home-like root inside the demo root", () => {
    const env = demoEnv("/tmp/sil-demo-root", "/repo");
    for (const key of ["HOME", "SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR", "CLAUDE_CONFIG_DIR", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"]) {
      expect(env[key]?.startsWith("/tmp/sil-demo-root/")).toBe(true);
    }
    expect(env["PATH"]).toBe(process.env["PATH"]);
  });
});
