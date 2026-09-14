import { LlmConfig, loadLlm, saveLlm } from "@sil/core";
import type { LlmArgs, NoArgs, WorldArgs } from "../args.ts";
import { cfgWorld } from "../cfg-world.ts";
import { deps } from "../deps.ts";

export function llmGet(_args: NoArgs) {
  return loadLlm();
}

export function llmSet(args: LlmArgs) {
  const llm = LlmConfig.parse(args.llm);
  saveLlm(llm);
  return llm;
}

export async function llmStatus(args: WorldArgs) {
  const [, world] = cfgWorld(args.world);
  return deps.providers.status(world);
}
