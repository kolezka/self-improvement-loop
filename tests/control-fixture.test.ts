// The fake `claude` in the control fixture is the instrument behind every
// "no model call" assertion. Prove it records a call, including when the
// fixture root contains a single quote, before any test trusts its silence.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createControlFixture, FIXTURE_CLAUDE_MARKER, type ControlFixture } from "./control-fixture.ts";
import { createCurationFixture } from "./curation-fixture.ts";

let fx: ControlFixture | null = null;

afterEach(() => {
  fx?.cleanup();
  fx = null;
});

/** Call `claude` the way a provider would: by name, through PATH, from a shell. */
function callFakeClaude(fixture: ControlFixture, args: string[]): number {
  const quoted = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
  const run = Bun.spawnSync(["/bin/sh", "-c", `claude ${quoted}`], { env: fixture.env, cwd: fixture.root, stdout: "pipe", stderr: "pipe" });
  return run.exitCode;
}

describe("fake claude marker", () => {
  test.each([
    ["a plain root", "sil-control-"],
    ["a root with a single quote", "sil-control-it's-"],
    ["a root with a space and a dollar sign", "sil-control-a $HOME b-"],
  ])("records a call under %s", (_name, prefix) => {
    fx = createControlFixture({ rootPrefix: prefix });
    expect(fx.root).toContain(prefix.slice("sil-control-".length, -1));
    const marker = join(fx.root, FIXTURE_CLAUDE_MARKER);
    expect(existsSync(marker)).toBe(false);
    expect(callFakeClaude(fx, ["--print", "positive control"])).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("--print positive control\n");
  });

  test("the curation fixture carries the same working marker", () => {
    const cf = createCurationFixture();
    fx = cf;
    expect(callFakeClaude(cf, ["-p", "x"])).toBe(0);
    expect(readFileSync(join(cf.root, FIXTURE_CLAUDE_MARKER), "utf8")).toBe("-p x\n");
  });
});
