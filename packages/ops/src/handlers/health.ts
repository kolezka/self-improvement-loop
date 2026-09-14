import { loadConfig, paths } from "@sil/core";
import type { NoArgs } from "../args.ts";
import { deps } from "../deps.ts";

const SIL_VERSION = "0.2.1";

export async function healthReport(_args: NoArgs): Promise<Record<string, unknown>> {
  const cfg = loadConfig();

  const providersStatus: Record<string, unknown> = {};
  for (const w of cfg.worlds) {
    try {
      providersStatus[w.name] = await deps.providers.status(w);
    } catch (e) {
      const err = e as Error;
      providersStatus[w.name] = { error: `${err.name}: ${err.message}` };
    }
  }

  let workerStatus: unknown;
  try {
    workerStatus = deps.worker.status();
  } catch (e) {
    const err = e as Error;
    workerStatus = { error: `${err.name}: ${err.message}` };
  }

  return {
    worlds: cfg.worlds.map((w) => w.name),
    config_file: paths.configFile(),
    llm_file: paths.llmFile(),
    state_dir: paths.stateDir(),
    data_dir: paths.dataDir(),
    plugin_root: paths.pluginRoot(),
    providers: providersStatus,
    worker: workerStatus,
    versions: { sil: SIL_VERSION },
  };
}
