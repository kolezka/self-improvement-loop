// sil init: write config.yaml and llm.yaml templates, create data dirs, seed
// the learned/ target repo, write the hook snapshot.

import { join } from "node:path";
import { Config, Endpoint, fsx, LlmConfig, loadConfig, paths, saveConfig, saveLlm, targetRoot, World, writeHookSnapshot } from "@sil/core";
import { git } from "@sil/curriculum";

// The operator's LiteLLM route for every role unless --model says otherwise.
export const DEFAULT_LITELLM_MODEL = "deepseek/deepseek-flash";

export interface InitOptions {
  world?: string;
  target?: string;
  llmBaseUrl?: string;
  apiKeyEnv?: string;
  model?: string;
  claudeModel?: string;
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
    // Each endpoint carries its own model names: a switch changes the
    // endpoint, never the model strings.
    const litellmModel = opts.model || DEFAULT_LITELLM_MODEL;
    const litellmModels = { critic: litellmModel, drafter: litellmModel, judge: litellmModel };
    const claudeModel = opts.claudeModel || "sonnet";
    const endpoints = [
      Endpoint.parse({
        name: "litellm",
        kind: "openai",
        base_url: opts.llmBaseUrl || "http://100.64.0.3:4000",
        api_key_env: opts.apiKeyEnv || "LITELLM_API_KEY",
        models: litellmModels,
      }),
      Endpoint.parse({
        name: "claude",
        kind: "claude-cli",
        models: { critic: claudeModel, drafter: claudeModel, judge: claudeModel },
      }),
    ];
    const llm = LlmConfig.parse({ endpoints, active: "litellm" });
    saveLlm(llm);
    console.log(`wrote ${llmPath}`);
  }

  for (const world of cfg.worlds) {
    if (world.target === null) git.ensureRepo(targetRoot(world));
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
  console.log("  sil llm list                            show endpoints and which one serves each role");
  console.log("  sil llm use claude                      send every role to `claude -p`");
  console.log("  sil llm use litellm --role drafter      send one role back to LiteLLM");
  console.log("  sil web                                 open the review UI");
  console.log("  sil schedule install --systemd --web    run the worker and web UI on a schedule");
  return 0;
}
