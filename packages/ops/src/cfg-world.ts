// Resolve a world name from a request into (Config, World) before it reaches
// review, feedback or providers: those packages take a World object, never a
// bare name, and worldNamed() throws ConfigError for a world that is not
// configured (mapped to 503 by the server).

import { loadConfig, worldNamed, type Config, type World } from "@sil/core";

export function cfgWorld(name: string): [Config, World] {
  const cfg = loadConfig();
  return [cfg, worldNamed(cfg, name)];
}
