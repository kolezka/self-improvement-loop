// The footer version badge is filled by a build-time define. This locks that
// define to the root package.json version, so a release bump reaches the UI.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import viteConfig from "../vite.config.ts";

const rootPackage = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
  version: string;
};

describe("web build version", () => {
  test("defines __SIL_VERSION__ from the root package.json version", () => {
    const config = viteConfig as { define?: Record<string, string> };
    expect(config.define?.["__SIL_VERSION__"]).toBe(JSON.stringify(rootPackage.version));
  });

  test("the App footer renders the injected version", () => {
    const app = readFileSync(new URL("../src/App.svelte", import.meta.url), "utf8");
    expect(app).toContain("v{__SIL_VERSION__}");
  });
});
