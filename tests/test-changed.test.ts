import { describe, expect, test } from "bun:test";
import { planTests, type Workspace } from "../scripts/test-changed.ts";

const graph: Workspace[] = [
  { dir: "packages/core", name: "@sil/core", deps: [] },
  { dir: "packages/store", name: "@sil/store", deps: ["@sil/core"] },
  { dir: "packages/critic", name: "@sil/critic", deps: ["@sil/core", "@sil/store"] },
  { dir: "packages/nudges", name: "@sil/nudges", deps: ["@sil/core"] },
  { dir: "apps/hook", name: "@sil/hook", deps: ["@sil/core", "@sil/nudges"] },
  { dir: "apps/hook-module", name: "@sil/hook-module", deps: ["@sil/nudges"] },
  { dir: "apps/cli", name: "@sil/cli", deps: ["@sil/critic"] },
  { dir: "apps/web", name: "@sil/web", deps: [] },
];

const dirs = (plan: ReturnType<typeof planTests>) =>
  plan.mode === "workspaces" ? plan.workspaces.map((w) => w.dir) : plan.mode;

describe("planTests", () => {
  test("a leaf app change runs only that app", () => {
    expect(dirs(planTests(["apps/web/src/App.svelte"], graph))).toEqual(["apps/web"]);
  });

  test("a package change also runs every transitive dependent", () => {
    const plan = planTests(["packages/store/src/db.ts"], graph);
    expect(dirs(plan)).toEqual(["apps/cli", "packages/critic", "packages/store"]);
    if (plan.mode !== "workspaces") throw new Error("expected workspaces");
    expect(plan.workspaces.find((w) => w.dir === "apps/cli")?.reason).toContain("@sil/critic");
    expect(plan.workspaces.find((w) => w.dir === "packages/store")?.reason).toBe("changed");
  });

  test("a prefix name does not pull in a sibling workspace", () => {
    expect(dirs(planTests(["apps/hook/src/main.ts"], graph))).toEqual(["apps/hook"]);
  });

  test("root-level code or config falls back to the full suite", () => {
    for (const p of ["scripts/build.ts", "tests/e2e.test.ts", "package.json", "bun.lock", "tsconfig.json", "hooks/hooks.json", "README.md"]) {
      const plan = planTests(["packages/core/src/a.ts", p], graph);
      expect(plan.mode).toBe("full");
      if (plan.mode === "full") expect(plan.reason).toContain(p);
    }
  });

  test("a change in apps/ or packages/ outside a known workspace falls back to full", () => {
    expect(planTests(["packages/newthing/src/a.ts"], graph).mode).toBe("full");
  });

  test("docs-only changes run nothing", () => {
    expect(planTests(["docs/OPERATIONS.md", "LICENSE", ".claude/CLAUDE.md"], graph).mode).toBe("none");
    expect(planTests([], graph).mode).toBe("none");
  });
});
