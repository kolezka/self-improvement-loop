// sil codex install: give Codex the same skill Claude Code loads.
//
// Codex reads skills from ~/.agents/skills. It records nothing for the loop,
// so the skill only lets a Codex agent operate sil. The file is copied, not
// symlinked: the plugin cache path changes with every version.

import { copyFileSync, mkdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { paths } from "@sil/core";
import * as schedule from "../schedule.ts";

const SKILL_NAME = "self-improvement-loop";

export function codexSkillFile(): string {
  return join(schedule.home(), ".agents", "skills", SKILL_NAME, "SKILL.md");
}

export function cmdCodexInstall(): number {
  const dest = codexSkillFile();
  if (schedule.isSymlink(dirname(dest)) || schedule.isSymlink(dest)) {
    console.log(`skill   ${dest} is a symlink, left alone`);
  } else {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(paths.pluginRoot(), "skills", SKILL_NAME, "SKILL.md"), dest);
    console.log(`skill   ${dest}`);
  }

  const shimLinked = schedule.isSymlink(schedule.shimPath());
  const shim = schedule.installShim();
  console.log(shimLinked ? `sil     ${shim} is a symlink, left alone` : `sil     ${shim}`);
  const binDir = dirname(shim);
  if (!(process.env["PATH"] ?? "").split(delimiter).includes(binDir)) {
    console.warn(`warning: ${binDir} is not on PATH, so Codex has to call ${shim} by its full path`);
  }
  console.log("Codex sessions are not recorded by the loop. Re-run this after a plugin update.");
  return 0;
}
