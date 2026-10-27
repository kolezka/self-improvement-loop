import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fsx, paths } from "@sil/core";
import { closeState, readRecords, stateStatus, STREAMS } from "../src/index.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-first-import-race-"));
  for (const key of ["SIL_STATE_DIR", "SIL_DATA_DIR", "SIL_CONFIG_DIR"]) saved[key] = process.env[key];
});
afterEach(() => {
  closeState();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

test("paired first opens leave no false failed import rows", async () => {
  const src = join(import.meta.dir, "..", "src", "index.ts");
  for (let round = 0; round < 4; round++) {
    closeState();
    for (const key of ["SIL_STATE_DIR", "SIL_DATA_DIR", "SIL_CONFIG_DIR"]) process.env[key] = join(tmp, `${round}-${key}`);
    const expected = { critic: 14_000, reflect_runs: 3_000 };
    for (const [stream, count] of Object.entries(expected) as [keyof typeof expected, number][]) {
      const file = STREAMS[stream].legacyPath(null);
      fsx.ensureDir(dirname(file));
      writeFileSync(file, Array.from({ length: count }, (_, i) => JSON.stringify({ stream, i })).join("\n") + "\n");
    }
    const env = {
      PATH: process.env["PATH"] ?? "", HOME: join(tmp, `${round}-home`),
      SIL_STATE_DIR: process.env["SIL_STATE_DIR"]!, SIL_DATA_DIR: process.env["SIL_DATA_DIR"]!,
      SIL_CONFIG_DIR: process.env["SIL_CONFIG_DIR"]!,
    };
    const start = Date.now() + 250;
    const program = `import { paths } from "@sil/core"; import { readRecords } from ${JSON.stringify(src)};
      if (paths.stateDir() !== process.env.SIL_STATE_DIR || paths.dataDir() !== process.env.SIL_DATA_DIR || paths.configDir() !== process.env.SIL_CONFIG_DIR) throw Error("fixture escaped");
      console.log("CONTROL " + paths.stateDir());
      Bun.sleepSync(Math.max(0, ${start} - Date.now()));
      console.log(JSON.stringify(Object.fromEntries(["critic", "reflect_runs"].map((stream) => {
        const records = readRecords(stream, "strict").records;
        return [stream, { count: records.length, first: records[0], last: records.at(-1) }];
      }))));`;
    const kids = [0, 1].map(() => Bun.spawn([process.execPath, "-e", program], {
      cwd: join(import.meta.dir, ".."), env, stdout: "pipe", stderr: "pipe",
    }));
    const results = await Promise.all(kids.map(async (kid) => ({
      exit: await kid.exited, output: await new Response(kid.stdout).text(), error: await new Response(kid.stderr).text(),
    })));
    expect(results.map((result) => result.exit)).toEqual([0, 0]);
    expect(results.map((result) => result.error)).toEqual(["", ""]);
    for (const result of results) {
      expect(result.output).toContain(`CONTROL ${env.SIL_STATE_DIR}\n`);
      const data = JSON.parse(result.output.split("\n")[1]!) as Record<string, { count: number; first: { stream: string; i: number }; last: { stream: string; i: number } }>;
      for (const [stream, count] of Object.entries(expected)) {
        expect(data[stream]).toEqual({ count, first: { stream, i: 0 }, last: { stream, i: count - 1 } });
      }
    }
    const status = stateStatus();
    expect(status.dbPath).toBe(paths.loopStateDb());
    expect(status.imports.filter((row) => row.state === "failed")).toEqual([]);
    for (const [stream, count] of Object.entries(expected)) {
      const backup = status.imports.find((row) => row.store === stream && row.state === "verified")!;
      expect(backup.backupCheck).toBe("ok");
      expect(JSON.parse(readFileSync(backup.backupPath!, "utf8").trimEnd().split("\n").at(-1)!)).toEqual({ stream, i: count - 1 });
      expect(readRecords(stream as keyof typeof expected, "strict").records).toHaveLength(count);
    }
  }
}, 30_000);
