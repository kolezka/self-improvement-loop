// Host-local bridge: run `bun test` and write the result where TDD Guard
// looks for it. TDD Guard ships reporters for vitest, jest, pytest, phpunit
// and go, none for `bun test`, so without this the guard sees no test output
// at all and blocks every implementation edit.
//
// Usage: bun run .claude/tdd-guard/bun-report.ts [bun test args...]

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..", "..");
const junitPath = join(projectRoot, ".claude", "tdd-guard", "data", "junit.xml");
const outPath = join(projectRoot, ".claude", "tdd-guard", "data", "test.json");
mkdirSync(join(projectRoot, ".claude", "tdd-guard", "data"), { recursive: true });

// A run that dies before any test executes leaves the previous XML in place,
// and a stale green file is worse than none.
rmSync(junitPath, { force: true });

const args = process.argv.slice(2);
const proc = Bun.spawnSync(["bun", "test", ...args, "--reporter=junit", `--reporter-outfile=${junitPath}`], {
  cwd: projectRoot,
  stdout: "inherit",
  stderr: "pipe",
});
const stderr = proc.stderr.toString();
process.stderr.write(stderr);

const xml = await Bun.file(junitPath).text().catch(() => "");

function unescapeXml(s: string): string {
  return s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&#10;", "\n")
    .replaceAll("&amp;", "&");
}

function attr(tag: string, name: string): string {
  const m = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return m ? unescapeXml(m[1]!) : "";
}

interface Test {
  name: string;
  fullName: string;
  state: "passed" | "failed" | "skipped";
  errors: { message: string }[];
}

const byModule = new Map<string, Test[]>();
let failed = 0;

// One regex pass over <testcase>, self closing or with a <failure> child.
const caseRe = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
for (const m of xml.matchAll(caseRe)) {
  const head = m[1] ?? "";
  const body = m[3] ?? "";
  const file = attr(head, "file");
  const name = attr(head, "name");
  const suite = attr(head, "classname");
  const moduleId = file ? join(projectRoot, file) : "unknown";

  const failure = /<(failure|error)\b([^>]*)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
  const skipped = /<skipped\b/.test(body);
  const state: Test["state"] = failure ? "failed" : skipped ? "skipped" : "passed";
  if (failure) failed += 1;
  const message = failure ? unescapeXml(attr(failure[2] ?? "", "message")) || unescapeXml(failure[3] ?? "").trim() : "";

  const tests = byModule.get(moduleId) ?? [];
  tests.push({ name, fullName: suite ? `${suite} > ${name}` : name, state, errors: failure ? [{ message }] : [] });
  byModule.set(moduleId, tests);
}

// No testcase at all with a non zero exit means the file never loaded: a
// missing import or an unresolved symbol. Reported as one failed test so the
// guard reads a Red instead of an empty pass.
if (byModule.size === 0 && (proc.exitCode ?? 0) !== 0) {
  const moduleId = args.length > 0 ? join(projectRoot, args[0]!) : "unknown";
  const message = stderr.trim() || "bun test produced no test cases; the test file failed to load";
  byModule.set(moduleId, [{ name: "module load", fullName: "module load", state: "failed", errors: [{ message }] }]);
  failed = 1;
}

const result = {
  testModules: [...byModule].map(([moduleId, tests]) => ({ moduleId, tests })),
  unhandledErrors: [] as unknown[],
  reason: failed > 0 ? "failed" : "passed",
};
writeFileSync(outPath, JSON.stringify(result, null, 2));

const total = [...byModule.values()].reduce((n, t) => n + t.length, 0);
console.log(`tdd-guard: ${total} test(s), ${failed} failed, wrote ${outPath}`);
process.exit(proc.exitCode ?? 0);
