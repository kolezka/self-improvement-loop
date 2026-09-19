import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateToken, newToken } from "../src/token.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-token-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("loadOrCreateToken", () => {
  test("creates the file once and returns the same token after that", () => {
    const file = join(tmp, "nested", "web-token");
    const first = loadOrCreateToken(file);
    expect(first.length).toBeGreaterThan(20);
    expect(existsSync(file)).toBe(true);
    // The contract a restart depends on: an already open tab keeps working.
    expect(loadOrCreateToken(file)).toBe(first);
  });

  test("keeps the file owner only", () => {
    const file = join(tmp, "web-token");
    loadOrCreateToken(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("tightens the mode of a too permissive existing file", () => {
    const file = join(tmp, "web-token");
    writeFileSync(file, "", { mode: 0o644 });
    const token = loadOrCreateToken(file);
    expect(token.length).toBeGreaterThan(20);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("newToken", () => {
  test("is not reused", () => {
    expect(newToken()).not.toBe(newToken());
  });
});
