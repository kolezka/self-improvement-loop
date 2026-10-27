// main.ts loads every @sil and local module with a dynamic import, so the
// walk follows literal import() specifiers too.
//
// The command hook may reach loop state only through @sil/statedb/hook, whose
// closure is bun:sqlite, @sil/core subpaths and the pure stream table (design D5).
// The opener, the probe and the importer must never ride along into dist/hook.js.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ROOT } from "../scripts/build.ts";
import { importClosure } from "./closure.ts";

const STATEDB = join(ROOT, "packages/statedb/src");
const HOOK_ENTRY = join(ROOT, "apps/hook/src/main.ts");
const FORBIDDEN = ["open", "import", "status", "docs", "aliases", "stores"].map((name) => join(STATEDB, `${name}.ts`));

describe("@sil/statedb/hook", () => {
  test("its closure holds none of the opener, importer, status or document modules", () => {
    const { files, specifiers } = importClosure([join(STATEDB, "hook.ts")]);
    // Positive control: the walker followed the subpath's own relative imports.
    for (const name of ["hook-io", "spill", "stream-table", "migrations"]) expect(files).toContain(join(STATEDB, `${name}.ts`));
    expect(files.filter((file) => FORBIDDEN.includes(file))).toEqual([]);
    expect([...specifiers].filter((s) => s.startsWith("@sil/") && !s.startsWith("@sil/core/"))).toEqual([]);
  });
});

describe("apps/hook import closure", () => {
  test("the walker sees the hook's own sources", () => {
    const { files, specifiers } = importClosure([HOOK_ENTRY], { dynamic: true });
    expect(files).toContain(join(ROOT, "apps/hook/src/log.ts"));
    expect(specifiers.has("@sil/core/paths")).toBe(true);
  });

  test("reaches @sil/statedb/hook and none of the opener, importer or status modules", () => {
    const { files } = importClosure([HOOK_ENTRY], { dynamic: true });
    expect(files).toContain(join(STATEDB, "hook.ts"));
    expect(files.filter((file) => FORBIDDEN.includes(file))).toEqual([]);
  });

  test("names @sil/statedb only as @sil/statedb/hook", () => {
    const { specifiers } = importClosure([HOOK_ENTRY], { dynamic: true });
    expect([...specifiers].filter((s) => s === "@sil/statedb" || s.startsWith("@sil/statedb/"))).toEqual(["@sil/statedb/hook"]);
  });
});
