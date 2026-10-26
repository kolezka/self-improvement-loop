// The hook writer's only filesystem calls for spill files. Tests wrap them to
// fake a size or fail a rename at an exact step.

import { appendFileSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";

export interface HookIo {
  stat(p: string): { size: number; dev: number; ino: number };
  rename(a: string, b: string): void;
  appendFile(p: string, data: string): void;
  readdir(p: string): string[];
  unlink(p: string): void;
  mkdir(p: string): void;
}

export const REAL_HOOK_IO: HookIo = {
  stat: (p) => statSync(p),
  rename: (a, b) => renameSync(a, b),
  // Flag "a" opens with O_APPEND, so concurrent hooks never overwrite each other.
  appendFile: (p, data) => appendFileSync(p, data),
  readdir: (p) => readdirSync(p),
  unlink: (p) => unlinkSync(p),
  mkdir: (p) => {
    mkdirSync(p, { recursive: true });
  },
};

let hookIoNow: HookIo = REAL_HOOK_IO;

export const hookIo = (): HookIo => hookIoNow;

/** Swap the hook's filesystem calls; null restores node:fs. */
export function setHookIoForTest(io: HookIo | null): void {
  hookIoNow = io ?? REAL_HOOK_IO;
}
