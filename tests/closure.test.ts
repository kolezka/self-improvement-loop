import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importClosure } from "./closure.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-closure-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("importClosure", () => {
  test("reports bare side-effect imports and re-exports, beside a from-import control", () => {
    const entry = join(tmp, "entry.ts");
    writeFileSync(join(tmp, "dep.ts"), "export const x = 1;\n");
    writeFileSync(
      entry,
      ['import "@sil/statedb";', "import '@sil/nudges/gates';", 'import { logFile } from "@sil/core/paths";', 'export { x } from "./dep.ts";', "void logFile;", ""].join("\n"),
    );
    const { files, specifiers } = importClosure([entry]);
    // Control: the ordinary from-import is reported.
    expect(specifiers.has("@sil/core/paths")).toBe(true);
    expect(specifiers.has("@sil/statedb")).toBe(true);
    expect(specifiers.has("@sil/nudges/gates")).toBe(true);
    expect(files).toContain(join(tmp, "dep.ts"));
  });
});
