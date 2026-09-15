import { Config, loadConfig, saveConfig, writeHookSnapshot } from "@sil/core";
import type { ConfigArgs, NoArgs } from "../args.ts";

export function worldsList(_args: NoArgs) {
  return loadConfig().worlds;
}

export function configGet(_args: NoArgs) {
  return loadConfig();
}

export function configSet(args: ConfigArgs) {
  const cfg = Config.parse(args.config);
  saveConfig(cfg);
  writeHookSnapshot(cfg);
  return cfg;
}
