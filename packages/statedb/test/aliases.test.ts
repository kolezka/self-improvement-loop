import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateReadError, ValidationError } from "@sil/core";
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
});
