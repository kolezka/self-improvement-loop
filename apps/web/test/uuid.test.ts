// The console must run outside a secure context (DSH serves it over plain HTTP
// on a LAN address), where crypto.randomUUID is undefined.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { uuid } from "../src/lib/uuid.ts";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SRC = join(import.meta.dir, "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "vendor" ? [] : sourceFiles(path);
    return /\.(ts|svelte)$/.test(entry.name) ? [path] : [];
  });
}

describe("uuid", () => {
  test("works without crypto.randomUUID", () => {
    const insecure = { getRandomValues: <T extends ArrayBufferView | null>(a: T) => crypto.getRandomValues(a) };
    const ids = new Set(Array.from({ length: 200 }, () => uuid(insecure)));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(V4);
  });

  test("uses crypto.randomUUID when it exists", () => {
    const secure = { getRandomValues: crypto.getRandomValues.bind(crypto), randomUUID: () => "from-native" };
    expect(uuid(secure)).toBe("from-native");
  });

  test("no browser source calls crypto.randomUUID except the uuid helper", () => {
    const callers = sourceFiles(SRC)
      .filter((file) => !file.endsWith(join("lib", "uuid.ts")))
      .filter((file) => /crypto\.randomUUID/.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC, file));
    expect(sourceFiles(SRC).length).toBeGreaterThan(10);
    expect(callers).toEqual([]);
  });
});
