// The filesystem probe lives in @sil/core/fs-probe so the curation store and the
// loop-state database share one implementation. It spawns /sbin/mount on macOS,
// which is why it stays out of the @sil/core index and the hooks module bundle.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyDarwinMounts, nearestExisting, probeFilesystem } from "@sil/core/fs-probe";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-fs-probe-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("probeFilesystem", () => {
  test("a tmpdir and a missing path under it are local", () => {
    expect(probeFilesystem(tmp)).toBe("local");
    expect(probeFilesystem(join(tmp, "missing", "deeper"))).toBe("local");
  });

  test("nearestExisting walks up to the deepest existing ancestor", () => {
    expect(nearestExisting(join(tmp, "missing", "deeper"))).toBe(tmp);
  });
});

describe("classifyDarwinMounts", () => {
  test("an smbfs share is unsupported", () => {
    expect(classifyDarwinMounts("//u@host/share on /Volumes/x (smbfs, nodev)", "/Volumes/x/y")).toBe("unsupported");
  });
});
