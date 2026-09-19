// The curriculum half of the loop: cluster, plan, route, draft, gate, stage.
//
// Submodules: git.ts (subprocess shape), artifacts.ts (paths and writers),
// lint.ts (the deterministic gate), router.ts (the type decision), prompts.ts
// (drafter and judge), plan.ts (watermarks), run.ts (one tick).

export * as git from "./git.ts";
export * as artifacts from "./artifacts.ts";
export * as prompts from "./prompts.ts";

export { artifactRel, allowedPaths, artifactPrefixes, ensureRulesFile, foreignRuleTags, HOOK_KEYS, isPlaceholderBody, placeholderBody, readArtifact, removeArtifact, ruleBulletInText, rulesDiffOwnedBy, rulesProblem, stripRuleTag, writeArtifact } from "./artifacts.ts";
export { distinctiveTerms, lint, lintDescriptionCap, lintGrounding, lintHook, lintRule, lintSkill, MAX_DESCRIPTION, MAX_RULE_CHARS, MIN_BODY_CHARS, MIN_SHARED_TERMS, SECRET_RE } from "./lint.ts";
export {
  emptyAnswer,
  GATE_TIMEOUT_MS,
  MIN_QUOTE_CHARS,
  MIN_QUOTE_TERMS,
  MIN_QUOTE_WORDS,
  route,
  RouteAnswer,
  type RouteOptions,
  type RouteResult,
  splitTrigger,
  substantiveQuote,
} from "./router.ts";
export { draftMessages, judgeMessages, parseDraft, parseVerdict } from "./prompts.ts";
export {
  type Cluster,
  cluster,
  draftingTexts,
  lessonTexts,
  loadLedger,
  loadPayloadCorpus,
  MAX_SAMPLED_PAYLOADS,
  plan,
  type PlanOptions,
  reflections,
  scorecardByPattern,
  scorecards,
  sourcesText,
  watermark,
  withoutSections,
} from "./plan.ts";
export { branchName, run, type RunOptions } from "./run.ts";
export { type GateCorpusResult, type GateRunner, type NudgeAdapter, setNudgeAdapter } from "./deps.ts";
