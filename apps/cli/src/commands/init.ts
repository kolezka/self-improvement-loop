// sil init: write config.yaml and llm.yaml templates, create data dirs, seed
// the learned/ target repo, write the hook snapshot.

import { join, relative } from "node:path";
import { Config, Endpoint, fsx, LlmConfig, loadConfig, loadLlm, paths, saveConfig, saveLlm, targetRoot, World, writeHookSnapshot } from "@sil/core";
import { ensureRulesFile, git } from "@sil/curriculum";

// The operator's LiteLLM route for every role unless --model says otherwise.
// Only used when --llm-base-url asks for a litellm endpoint at all.
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
  let litellmPresent: boolean;
  if (fsx.exists(llmPath)) {
    console.log(`llm.yaml already exists at ${llmPath}, leaving it as is`);
    litellmPresent = loadLlm().endpoints.some((e) => e.name === "litellm");
  } else {
    // Each endpoint carries its own model names: a switch changes the
    // endpoint, never the model strings. claude-cli is the only endpoint
    // that needs no operator setup (no base_url, no API key, already on
    // PATH if `claude` is installed), so it is the one written and made
    // active by default. litellm only gets written, and only becomes
    // active, once the operator names an endpoint with --llm-base-url:
    // without one there is nothing real to point it at.
    const claudeModel = opts.claudeModel || "sonnet";
    const endpoints: Endpoint[] = [
      Endpoint.parse({
        name: "claude",
        kind: "claude-cli",
        models: { critic: claudeModel, drafter: claudeModel, judge: claudeModel },
      }),
    ];
    let active = "claude";
    if (opts.llmBaseUrl) {
      const litellmModel = opts.model || DEFAULT_LITELLM_MODEL;
      const litellmModels = { critic: litellmModel, drafter: litellmModel, judge: litellmModel };
      endpoints.push(
        Endpoint.parse({
          name: "litellm",
          kind: "openai",
          base_url: opts.llmBaseUrl,
          api_key_env: opts.apiKeyEnv || "LITELLM_API_KEY",
          models: litellmModels,
        }),
      );
      active = "litellm";
    }
    litellmPresent = Boolean(opts.llmBaseUrl);
    const llm = LlmConfig.parse({ endpoints, active });
    saveLlm(llm);
    console.log(`wrote ${llmPath}`);
  }

  for (const world of cfg.worlds) {
    if (world.target === null) git.ensureRepo(targetRoot(world));
    fsx.ensureDir(paths.reflectionsDir(world.name));
    fsx.ensureDir(paths.inboxDir(world.name));
    seedRulesFile(world);
  }
  for (const bucket of ["pending", "done", "failed"] as const) fsx.ensureDir(paths.queueDir(bucket));
  for (const sub of ["logs", "sessions", "usage", "feedback"]) fsx.ensureDir(join(paths.stateDir(), sub));

  const snap = writeHookSnapshot(cfg);
  console.log(`wrote hook snapshot at ${snap}`);
  console.log();
  console.log("Next steps:");
  console.log("  sil status                              check worker and provider status");
  console.log("  sil llm list                            show endpoints and which one serves each role");
  if (litellmPresent) {
    console.log("  sil llm use claude                      send every role to `claude -p`");
    console.log("  sil llm use litellm --role drafter      send one role back to LiteLLM");
  } else {
    console.log("  sil llm use claude                      already active; every role runs through `claude -p`");
    console.log("  pass --llm-base-url next time to also configure a LiteLLM endpoint");
  }
  console.log("  sil web                                 open the review UI");
  console.log("  sil schedule install --web              run the worker and web UI on a schedule");
  return 0;
}

/** Create this world's rules file when the loop owns it (the built-in
 * `learned/` target), and commit it if it was newly created. `ensureRulesFile`
 * returns null for an operator-owned target: nothing is written there.
 *
 * Committed, not left dirty: `git.ensureRepo` above already leaves this
 * repo's working tree clean (one empty commit), and an untracked RULES.md
 * would block the fast-forward merge the curriculum run does directly
 * against this checkout the first time it promotes a rule here. */
function seedRulesFile(world: World): void {
  const path = ensureRulesFile(world);
  if (!path) return;
  const repo = targetRoot(world);
  const rel = relative(repo, path);
  const tracked = git.git(repo, ["ls-files", "--error-unmatch", rel], { check: false }) !== "";
  if (tracked) {
    console.log(`rules file already exists at ${path}`);
    return;
  }
  git.git(repo, ["add", rel]);
  git.git(repo, ["commit", "-q", "-m", "chore: seed learned rules file"]);
  console.log(`wrote and committed rules file at ${path}`);
}
