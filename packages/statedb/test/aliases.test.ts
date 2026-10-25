import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, StateReadError, StateWriteError, ValidationError } from "@sil/core";
import { closeState, openState, readAliases, replaceAliases } from "../src/index.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-statedb-aliases-"));
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"]) {
    saved[k] = process.env[k];
    process.env[k] = join(tmp, k.toLowerCase());
  }
});

afterEach(() => {
  try {
    closeState();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

const caught = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
};

describe("readAliases and replaceAliases", () => {
  test("replaced aliases read back sorted by alias", () => {
    replaceAliases("default", { zeta: "z", alpha: "a", mid: "m" });
    const read = readAliases("default", "strict");
    expect(read).toEqual({ alpha: "a", mid: "m", zeta: "z" });
    expect(Object.keys(read)).toEqual(["alpha", "mid", "zeta"]);
    replaceAliases("default", { only: "one" });
    expect(readAliases("default", "strict")).toEqual({ only: "one" });
  });

  test("a chain is refused with the core one-hop message and the old rows stay", () => {
    replaceAliases("default", { old: "new" });
    const error = caught(() => replaceAliases("default", { a: "b", b: "c" }));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toBe('"b" is a key (-> "c") and also the value of "a" (-> "b"); aliases resolve one hop only');
    expect(readAliases("default", "strict")).toEqual({ old: "new" });
  });

  test("an NFD world name writes the NFC world", () => {
    replaceAliases("koleżka".normalize("NFD"), { a: "b" });
    expect(readAliases("koleżka".normalize("NFC"), "strict")).toEqual({ a: "b" });
  });

  test("a quarantine row for one world leaves another world's strict read working", () => {
    replaceAliases("b", { x: "y" });
    openState()
      .query("INSERT INTO quarantine (store, world, source, line_no, reason, raw, quarantined_at) VALUES ('aliases', 'a', 'src', NULL, 'not JSON', 'x', 't')")
      .run();
    const error = caught(() => readAliases("a", "strict"));
    expect(error).toBeInstanceOf(StateReadError);
    expect((error as Error).message).toBe('the aliases of world "a" could not be imported; see sil state quarantine');
    expect(readAliases("a", "tolerant")).toEqual({});
    expect(readAliases("b", "strict")).toEqual({ x: "y" });
  });

  test("a __proto__ row reads back as an own key, and replaceAliases refuses a non-slug key", () => {
    replaceAliases("default", { safe: "s" });
    closeState();
    const raw = new Database(paths.loopStateDb());
    raw.query("INSERT INTO aliases (world, alias, canonical) VALUES ('default', '__proto__', 'x')").run();
    raw.close();
    const read = readAliases("default", "strict");
    expect(Object.hasOwn(read, "__proto__")).toBe(true);
    expect(Object.keys(read)).toEqual(["__proto__", "safe"]);
    const bad: Record<string, string> = Object.fromEntries([["__proto__", "y"]]);
    const error = caught(() => replaceAliases("default", bad));
    expect(error).toBeInstanceOf(StateWriteError);
    expect((error as Error).message).toBe('the aliases of world "default" cannot be written (not a map of names)');
  });

  test("a malformed map is a labeled StateWriteError, not a raw TypeError", () => {
    const error = caught(() => replaceAliases("default", null as unknown as Record<string, string>));
    expect(error).toBeInstanceOf(StateWriteError);
    expect((error as Error).message.startsWith('the aliases of world "default" cannot be written (')).toBe(true);
  });
});
