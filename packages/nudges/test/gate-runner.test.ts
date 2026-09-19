import { describe, expect, test } from "bun:test";
import { runGateCorpus } from "../src/gate-runner.ts";

describe("runGateCorpus", () => {
  test("evaluates a well-formed gate against every payload", () => {
    const result = runGateCorpus({ tool_is: ["Bash"] }, [{ tool_name: "Bash" }, { tool_name: "Edit" }]);
    expect(result.timedOut).toBe(false);
    expect(result.error).toBeNull();
    expect(result.results).toEqual([true, false]);
  });

  test("the runner process itself reports a protocol error for malformed stdin, not a throw", async () => {
    const runnerPath = new URL("../src/gate-runner.ts", import.meta.url).pathname;
    const proc = Bun.spawnSync(["bun", runnerPath], {
      stdin: Buffer.from("not json", "utf8"),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const out: unknown = JSON.parse((proc.stdout ?? Buffer.alloc(0)).toString("utf8").trim());
    expect(out).toHaveProperty("error");
  });

  // One catastrophic payload is not enough to outrun the budget on every
  // machine. JSC caps backtracking, so `(a+)+$` costs a few hundred ms and
  // then returns false, whatever the input length: measured 410ms at 30
  // characters and 409ms at 200 on the dev box, while the same payload
  // finished inside a 300ms budget on a CI runner and failed this test. The
  // corpus is what the caller controls, so the cost is scaled there instead:
  // 100 payloads are ~100x one payload on any machine, which no budget in the
  // hundreds of ms can absorb.
  test("a corpus that outruns the budget is killed instead of hanging", () => {
    const gate = { command_matches: "(a+)+$" };
    const adversarial = { tool_input: { command: "a".repeat(30) + "!" } };
    const corpus = Array.from({ length: 100 }, () => adversarial);
    const started = performance.now();
    const result = runGateCorpus(gate, corpus, 300);
    const elapsed = performance.now() - started;
    expect(result.timedOut).toBe(true);
    expect(result.results).toBeNull();
    expect(result.error).not.toBeNull();
    // Generous slack over the 300ms budget for process spawn overhead.
    expect(elapsed).toBeLessThan(2000);
  });
});
