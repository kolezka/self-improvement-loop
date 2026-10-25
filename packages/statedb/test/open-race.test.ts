import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-statedb-open-race-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const PAIRS = 4;
const ROUNDS = 15;
const ROUND_MS = 60;

test(
  "two processes opening a database that does not exist yet both succeed",
  async () => {
    // Each pair of children opens ROUNDS fresh STATE dirs in lockstep, so one
    // run tries PAIRS * ROUNDS simultaneous fresh opens. Measured on 6b20c2d:
    // one fresh pair per run caught the race in about 1 run of 5.
    const src = join(import.meta.dir, "..", "src", "index.ts");
    const startAt = Date.now() + 2000;
    const program =
      `import { join } from "node:path";\nimport { paths } from "@sil/core";\nimport { openState } from ${JSON.stringify(src)};\n` +
      'const base = process.env["SIL_STATE_DIR"];\n' +
      `for (let r = 0; r < ${ROUNDS}; r++) {\n` +
      `  const at = ${startAt} + r * ${ROUND_MS};\n` +
      "  Bun.sleepSync(Math.max(0, at - 5 - Date.now()));\n" +
      "  while (Date.now() < at) {}\n" +
      '  process.env["SIL_STATE_DIR"] = join(base, "round-" + r);\n' +
      '  let out = "ok";\n' +
      '  try { openState(); } catch (e) { out = e.name + " " + e.message; }\n' +
      '  console.log(r + " " + paths.stateDir() + " " + out);\n' +
      "}\n";
    const kids = [];
    const bases: string[] = [];
    for (let pair = 0; pair < PAIRS; pair++) {
      const root = join(tmp, `pair-${pair}`);
      // Built only from tmp dirs: a child does not see process.env changes made after start.
      const env = {
        PATH: process.env["PATH"] ?? "",
        HOME: join(root, "home"),
        SIL_CONFIG_DIR: join(root, "config"),
        SIL_STATE_DIR: join(root, "state"),
        SIL_DATA_DIR: join(root, "data"),
      };
      for (let k = 0; k < 2; k++) {
        bases.push(env.SIL_STATE_DIR);
        kids.push(Bun.spawn(["bun", "-e", program], { env, cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }));
      }
    }
    const outputs = await Promise.all(kids.map(async (kid) => (await new Response(kid.stdout).text()).trim().split("\n")));
    expect(await Promise.all(kids.map((kid) => kid.exited))).toEqual(kids.map(() => 0));
    const expected = bases.map((base) => Array.from({ length: ROUNDS }, (_, r) => `${r} ${join(base, `round-${r}`)} ok`));
    // Positive control and the check in one: every line names the child's own
    // tmp STATE dir for that round, and every open succeeded.
    expect(outputs).toEqual(expected);
  },
  30_000,
);
