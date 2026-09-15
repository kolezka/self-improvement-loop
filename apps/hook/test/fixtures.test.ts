// Every fixture in tests/fixtures/hook-payloads run through the hook entry
// point as a real subprocess: exit 0, and stdout is either empty or exactly
// one valid hookSpecificOutput envelope. Ported from
// test_hook_fixture_payloads_exit_zero_with_valid_output.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupHookEnv, hookEntries, makeHookEnv, runHook } from "./helpers.ts";
import type { HookEnv } from "./helpers.ts";

const FIXTURES_DIR = join(new URL("../../../", import.meta.url).pathname, "tests/fixtures/hook-payloads");
const fixtureNames = readdirSync(FIXTURES_DIR).filter((n) => n.endsWith(".json")).sort();

let hookEnv: HookEnv;

beforeEach(() => {
  hookEnv = makeHookEnv();
});

afterEach(() => {
  cleanupHookEnv(hookEnv);
});

describe("hook fixture payloads", () => {
  test(`found the expected fixture set (${fixtureNames.length} files)`, () => {
    expect(fixtureNames.length).toBeGreaterThan(0);
  });

  for (const entry of hookEntries()) {
    describe(`entry point ${entry.endsWith(".js") ? "dist/hook.js" : "main.ts"}`, () => {
      for (const name of fixtureNames) {
        test(`${name} exits 0 with valid output`, () => {
          const payload = readFileSync(join(FIXTURES_DIR, name), "utf8");
          const result = runHook(entry, hookEnv, payload);
          expect(result.exitCode).toBe(0);

          const out = result.stdout.trim();
          if (out === "") return;

          const parsed: unknown = JSON.parse(out);
          expect(parsed && typeof parsed === "object").toBe(true);
          const obj = parsed as Record<string, unknown>;
          expect(Object.keys(obj)).toEqual(["hookSpecificOutput"]);
          const inner = obj["hookSpecificOutput"] as Record<string, unknown>;
          expect(typeof inner["hookEventName"]).toBe("string");
          expect(typeof inner["additionalContext"]).toBe("string");
          expect((inner["additionalContext"] as string).length).toBeGreaterThan(0);

          // The hook must never emit a permission decision: that is Claude
          // Code's own PreToolUse contract, not this plugin's.
          expect(JSON.stringify(obj)).not.toContain("permissionDecision");
          expect(JSON.stringify(obj)).not.toMatch(/"decision"\s*:/);
        });
      }
    });
  }
});

describe("empty and garbage stdin", () => {
  for (const entry of hookEntries()) {
    test(`${entry.endsWith(".js") ? "dist/hook.js" : "main.ts"}: empty stdin exits 0 silently`, () => {
      const result = runHook(entry, hookEnv, "");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("");
    });

    test(`${entry.endsWith(".js") ? "dist/hook.js" : "main.ts"}: garbage stdin exits 0 silently`, () => {
      const result = runHook(entry, hookEnv, "{not valid json at all");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("");
    });
  }
});
