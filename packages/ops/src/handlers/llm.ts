import { LlmConfig, loadLlm, saveLlm, useEndpoint, writeHookSnapshot } from "@sil/core";
import type { LlmArgs, LlmUseArgs, NoArgs, WorldArgs } from "../args.ts";
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

/** Same semantics as `sil llm use`: no role switches everything and clears the
 * per role overrides, a role switches only that role. */
export function llmUse(args: LlmUseArgs) {
  const llm = useEndpoint(loadLlm(), args.endpoint, args.role);
  saveLlm(llm);
  writeHookSnapshot();
  return llm;
}

export async function llmStatus(args: WorldArgs) {
  const [, world] = cfgWorld(args.world);
  return deps.providers.status(world);
}
