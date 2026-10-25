import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fsx, paths } from "@sil/core";
import { closeState, openState, readRecords, setImportIoForTest, stateStatus } from "../src/index.ts";
import { importStreamOn } from "../src/import.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-finalize-race-"));
  for (const key of ["SIL_STATE_DIR", "SIL_DATA_DIR", "SIL_CONFIG_DIR"]) {
    saved[key] = process.env[key];
    process.env[key] = join(tmp, key);
  }
});
afterEach(() => {
  setImportIoForTest(null);
  closeState();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function child(code: string): { exit: number; output: string; error: string } {
  const env = {
    PATH: process.env["PATH"] ?? "",
    HOME: join(tmp, "home"),
    SIL_STATE_DIR: process.env["SIL_STATE_DIR"]!,
    SIL_DATA_DIR: process.env["SIL_DATA_DIR"]!,
    SIL_CONFIG_DIR: process.env["SIL_CONFIG_DIR"]!,
  };
  const src = join(import.meta.dir, "..", "src", "index.ts");
  const program = `import { paths } from "@sil/core"; import { readRecords, setImportIoForTest } from ${JSON.stringify(src)};
    import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
    if (paths.stateDir() !== process.env.SIL_STATE_DIR || paths.dataDir() !== process.env.SIL_DATA_DIR || paths.configDir() !== process.env.SIL_CONFIG_DIR) throw Error("fixture escaped");
    console.log("CONTROL " + paths.stateDir()); ${code}`;
  const result = Bun.spawnSync([process.execPath, "-e", program], { env, cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  return { exit: result.exitCode ?? -1, output: result.stdout.toString(), error: result.stderr.toString() };
}

function interleave(newClaim: boolean): { backup: string; original: string; next: string } {
  const db = openState();
  const path = paths.criticFeedbackFile();
  const claim = `${path}.importing`;
  fsx.ensureDir(dirname(path));
  const original = '{"n":1}\n';
  const next = '{"n":2}\n';
  writeFileSync(path, original);
  const run = db.run.bind(db);
  let triggered = false;
  db.run = ((sql: string, ...args: unknown[]) => {
    const result = args.length ? run(sql, args as string[]) : run(sql);
    if (sql === "COMMIT" && !triggered && existsSync(claim) &&
        (db.query("SELECT count(*) AS n FROM log_records WHERE stream = 'critic'").get() as { n: number }).n === 1) {
      triggered = true;
      const script = newClaim
        ? `console.log(JSON.stringify(readRecords("critic", "strict").records)); const path = paths.criticFeedbackFile();
           writeFileSync(path, ${JSON.stringify(next)});
           setImportIoForTest({ stat: statSync, readFile: readFileSync, rename: (from, to) => {
             renameSync(from, to); if (from === path) process.exit(17);
           }});
           readRecords("critic", "strict");`
        : `console.log(JSON.stringify(readRecords("critic", "strict").records));`;
      const response = child(script);
      expect(response.error).toBe("");
      expect(response.output).toContain(`CONTROL ${process.env["SIL_STATE_DIR"]}\n`);
      expect(response.output).toContain('[{"n":1}]');
      expect(response.exit).toBe(newClaim ? 17 : 0);
    }
    return result;
  }) as typeof db.run;
  let outcomes: ReturnType<typeof importStreamOn> = [];
  let importError: unknown = null;
  try {
    outcomes = importStreamOn(db, "critic");
  } catch (error) {
    importError = error;
  } finally {
    db.run = run;
  }
  expect(triggered).toBe(true);
  expect(importError).toBeNull();
  return { backup: outcomes[0]!.backupPath, original, next };
}

test("another importer finalizes our claim before we resume without a failed row", () => {
  const { backup, original } = interleave(false);
  expect(readRecords("critic", "strict").records).toEqual([{ n: 1 }]);
  expect(readFileSync(backup, "utf8")).toBe(original);
  expect(stateStatus().imports.filter((row) => row.state === "failed")).toEqual([]);
  expect(stateStatus().imports.find((row) => row.backupPath === backup)?.backupCheck).toBe("ok");
});

test("a new claim at the same path and size cannot replace the first backup", () => {
  const { backup, original, next } = interleave(true);
  expect(readFileSync(backup, "utf8")).toBe(original);
  expect(readRecords("critic", "strict").records).toEqual([{ n: 1 }, { n: 2 }]);
  const verified = stateStatus().imports.filter((row) => row.state === "verified" && row.store === "critic");
  expect(verified).toHaveLength(2);
  expect(verified.map((row) => readFileSync(row.backupPath!, "utf8"))).toEqual([original, next]);
  expect(verified.map((row) => row.backupCheck)).toEqual(["ok", "ok"]);
  expect(stateStatus().imports.filter((row) => row.state === "failed")).toEqual([]);
});
