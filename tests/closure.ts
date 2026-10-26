// Static import closure of TypeScript sources, followed through relative and
// @sil/* imports. Shared by the bundle closure tests.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../scripts/build.ts";

const SIL_SPECIFIER = /^@sil\/([a-z0-9-]+)(?:\/([A-Za-z0-9-]+))?$/;

/** The source file an @sil specifier names, read from its package's exports. */
export function resolveSil(specifier: string): string | null {
  const parts = SIL_SPECIFIER.exec(specifier);
  if (!parts) return null;
  const pkgDir = join(ROOT, "packages", parts[1] ?? "");
  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { exports?: Record<string, string> };
  const target = manifest.exports?.[parts[2] ? `./${parts[2]}` : "."];
  return target ? join(pkgDir, target) : null;
}

/** Every source file reachable from `entries`, and every @sil specifier seen.
 * `dynamic` also follows `import("literal")`, which the bundler inlines too. */
export function importClosure(entries: string[], { dynamic = false } = {}): { files: string[]; specifiers: Set<string> } {
  // `from "x"` covers imports and re-exports; `import "x"` is a bare side-effect import.
  const pattern = dynamic ? /(?:from |^\s*import\s*|import\()["']([^"']+)["']/gm : /(?:from |^\s*import\s*)["']([^"']+)["']/gm;
  const seen = new Set<string>();
  const specifiers = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(pattern)) {
      const specifier = match[1] ?? "";
      if (specifier.startsWith(".")) {
        queue.push(join(file, "..", specifier));
        continue;
      }
      if (!specifier.startsWith("@sil/")) continue;
      specifiers.add(specifier);
      const resolved = resolveSil(specifier);
      if (resolved) queue.push(resolved);
    }
  }
  return { files: [...seen].sort(), specifiers };
}
