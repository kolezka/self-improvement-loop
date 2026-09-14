// sil init: write config.yaml and llm.yaml templates, create data dirs, seed
// the learned/ target repo, write the hook snapshot.

import { join } from "node:path";
import { Config, Endpoint, fsx, LlmConfig, loadConfig, paths, saveConfig, saveLlm, targetRoot, World, writeHookSnapshot } from "@sil/core";
import { ensureLearnedRepo } from "../common.ts";

export interface InitOptions {
  world?: string;
  target?: string;
  llmBaseUrl?: string;
  apiKeyEnv?: string;
  model?: string;
}

export function cmdInit(opts: InitOptions): number {
  const cfgPath = paths.configFile();
  let cfg: Config;
  if (fsx.exists(cfgPath)) {
    cfg = loadConfig();
    console.log(`config.yaml already exists at ${cfgPath}, leaving it as is`);
  } else {
    const world = World.parse({
      name: opts.world || "default",
      target: opts.target ? paths.expandHome(opts.target) : null,
    });
    cfg = Config.parse({ worlds: [world] });
    saveConfig(cfg);
    console.log(`wrote ${cfgPath}`);
  }

  const llmPath = paths.llmFile();
  if (fsx.exists(llmPath)) {
    console.log(`llm.yaml already exists at ${llmPath}, leaving it as is`);
  } else {
    const endpoints = [
      Endpoint.parse({
        name: "litellm",
        kind: "openai",
        base_url: opts.llmBaseUrl || "http://127.0.0.1:4000",
        api_key_env: opts.apiKeyEnv || "LITELLM_API_KEY",
      }),
      Endpoint.parse({ name: "claude", kind: "claude-cli" }),
    ];
    const models = opts.model ? { critic: opts.model, drafter: opts.model, judge: opts.model } : {};
    const llm = LlmConfig.parse({ endpoints, active: "litellm", models });
    saveLlm(llm);
    console.log(`wrote ${llmPath}`);
    if (Object.keys(models).length === 0) {
      console.log(
        "llm.yaml has no models set. Edit it and set models.critic, " +
          "models.drafter and models.judge before running the worker, " +
          "e.g. anthropic/claude-sonnet-5.",
      );
    }
  }

  for (const world of cfg.worlds) {
    if (world.target === null) ensureLearnedRepo(targetRoot(world));
    fsx.ensureDir(paths.reflectionsDir(world.name));
    fsx.ensureDir(paths.inboxDir(world.name));
  }
  for (const bucket of ["pending", "done", "failed"] as const) fsx.ensureDir(paths.queueDir(bucket));
  for (const sub of ["logs", "sessions", "usage", "feedback"]) fsx.ensureDir(join(paths.stateDir(), sub));

  const snap = writeHookSnapshot(cfg);
  console.log(`wrote hook snapshot at ${snap}`);
  console.log();
  console.log("Next steps:");
  console.log("  sil status                              check worker and provider status");
  console.log("  sil web                                 open the review UI");
  console.log("  sil schedule install --systemd --web    run the worker and web UI on a schedule");
  return 0;
}
