// Every test runs with a throwaway HOME, so nothing writes to the real one
// (sil init installs ~/.local/bin/sil). Tests that need a HOME still set their own.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "sil-test-home-"));
process.env["HOME"] = home;
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
