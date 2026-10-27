// A 1.3.0 hook's append to its log, run as its own process: the real
// `fsx.appendLine` (unchanged since 1.3.0), paused right before the rename
// that puts its rotated tail over `P` until the test writes the resume file.

import { mock } from "bun:test";
import * as fs from "node:fs";

const p = process.env["OLD_P"]!;
const ready = process.env["OLD_READY"]!;
const resume = process.env["OLD_RESUME"]!;
if (!p.startsWith(`${process.env["SIL_STATE_DIR"]}/`)) throw new Error("OLD_P is outside the test's state dir");

const realRename = fs.renameSync;
let paused = false;
mock.module("node:fs", () => ({
  ...fs,
  renameSync: (from: fs.PathLike, to: fs.PathLike) => {
    if (to === p && !paused) {
      paused = true;
      fs.writeFileSync(ready, "rotation read, rename pending");
      const end = Date.now() + 20_000;
      while (!fs.existsSync(resume)) {
        if (Date.now() > end) throw new Error("resume timeout");
        Bun.sleepSync(5);
      }
    }
    return realRename(from, to);
  },
}));

const { appendLine } = await import("@sil/core/fsx");
// The 1.3.0 hook runs log bounds: rotate at 8 MiB, keep 40000 lines.
appendLine(p, JSON.stringify({ marker: "old-writer-after-rotation" }), 8 * 1024 * 1024, 40_000);
console.log(JSON.stringify({ state: process.env["SIL_STATE_DIR"], paused }));
