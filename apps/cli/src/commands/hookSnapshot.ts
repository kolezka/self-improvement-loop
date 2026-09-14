// sil hook-snapshot: rewrite the hook config snapshot from the current config.

import { loadConfig, writeHookSnapshot } from "@sil/core";

export function cmdHookSnapshot(): number {
  const cfg = loadConfig();
  const p = writeHookSnapshot(cfg);
  console.log(`wrote ${p}`);
  return 0;
}
