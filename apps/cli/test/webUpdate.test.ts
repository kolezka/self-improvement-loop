import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedStamp, isInstalledCopy, updateStamp, watchForUpdates } from "../src/webUpdate.ts";

let tmp: string;
let claudeConfig: string;

function writeInstalled(entries: Record<string, unknown[]>): void {
  mkdirSync(join(claudeConfig, "plugins"), { recursive: true });
  writeFileSync(join(claudeConfig, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: entries }));
}

function writeSrcHash(root: string, hash: string): void {
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", ".srchash"), hash + "\n");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-webupdate-"));
  claudeConfig = join(tmp, ".claude");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("isInstalledCopy", () => {
  test("true under the plugin cache, false for a dev checkout", () => {
    expect(isInstalledCopy(join(claudeConfig, "plugins", "cache", "kolezka", "self-improvement-loop", "0.2.7"), claudeConfig)).toBe(true);
    expect(isInstalledCopy(join(tmp, "src", "self-improvement-loop"), claudeConfig)).toBe(false);
  });
});

describe("installedStamp", () => {
  test("takes the newest entry of this plugin and ignores other plugins", () => {
    writeInstalled({
      "other-plugin@kolezka": [{ installPath: "/other", lastUpdated: "2030-01-01T00:00:00Z" }],
      "self-improvement-loop@kolezka": [
        { installPath: "/cache/0.2.6", lastUpdated: "2026-09-01T00:00:00Z" },
        { installPath: "/cache/0.2.7", lastUpdated: "2026-09-19T00:00:00Z" },
      ],
    });
    expect(installedStamp(claudeConfig)).toBe("/cache/0.2.7@2026-09-19T00:00:00Z");
  });

  test("empty for a missing or unparsable file", () => {
    expect(installedStamp(claudeConfig)).toBe("");
    mkdirSync(join(claudeConfig, "plugins"), { recursive: true });
    writeFileSync(join(claudeConfig, "plugins", "installed_plugins.json"), "{not json");
    expect(installedStamp(claudeConfig)).toBe("");
  });
});

describe("updateStamp", () => {
  test("changes when a local build rewrites dist/.srchash", () => {
    const root = join(tmp, "checkout");
    writeSrcHash(root, "aaa");
    const before = updateStamp(root, claudeConfig);
    writeSrcHash(root, "bbb");
    expect(updateStamp(root, claudeConfig)).not.toBe(before);
  });

  test("changes when an installed copy is updated to a new version", () => {
    const root = join(claudeConfig, "plugins", "cache", "kolezka", "self-improvement-loop", "0.2.7");
    writeSrcHash(root, "aaa");
    writeInstalled({ "self-improvement-loop@kolezka": [{ installPath: root, lastUpdated: "2026-09-19T00:00:00Z" }] });
    const before = updateStamp(root, claudeConfig);
    const next = join(claudeConfig, "plugins", "cache", "kolezka", "self-improvement-loop", "0.2.8");
    writeInstalled({ "self-improvement-loop@kolezka": [{ installPath: next, lastUpdated: "2026-09-20T00:00:00Z" }] });
    expect(updateStamp(root, claudeConfig)).not.toBe(before);
  });

  test("a dev checkout ignores plugin cache churn", () => {
    const root = join(tmp, "checkout");
    writeSrcHash(root, "aaa");
    const before = updateStamp(root, claudeConfig);
    writeInstalled({ "self-improvement-loop@kolezka": [{ installPath: "/cache/0.2.9", lastUpdated: "2026-09-20T00:00:00Z" }] });
    expect(updateStamp(root, claudeConfig)).toBe(before);
  });
});

describe("watchForUpdates", () => {
  test("fires once when the stamp changes, never before", async () => {
    const root = join(tmp, "checkout");
    writeSrcHash(root, "aaa");
    let fires = 0;
    const stop = watchForUpdates(() => fires++, { intervalMs: 5, root, claudeConfig });
    await Bun.sleep(25);
    expect(fires).toBe(0);
    writeSrcHash(root, "bbb");
    await Bun.sleep(25);
    writeSrcHash(root, "ccc");
    await Bun.sleep(25);
    stop();
    expect(fires).toBe(1);
  });
});
