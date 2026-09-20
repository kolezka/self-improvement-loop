// The curriculum half of the loop: cluster, plan, route, draft, gate, stage.
//
// Submodules: git.ts (subprocess shape), artifacts.ts (paths and writers),
// lint.ts (the deterministic gate), router.ts (the type decision), prompts.ts
// (drafter and judge), plan.ts (watermarks), run.ts (one tick).

export * as git from "./git.ts";
export * as artifacts from "./artifacts.ts";
export * as prompts from "./prompts.ts";
export * as context from "./context.ts";

export {
  artifactGist,
  type ClusterSummary,
  clusterSummary,
  digestPath,
  type KnowledgeRow,
  loadSummary,
  MAX_KNOWLEDGE_ROWS,
  MAX_SUMMARY_CHARS,
  renderKnowledge,
  saveSummary,
  SUMMARY_MIN_LESSONS,
  worldKnowledge,
} from "./context.ts";

export { artifactRel, allowedPaths, artifactPrefixes, ensureRulesFile, foreignRuleTags, HOOK_KEYS, isPlaceholderBody, placeholderBody, readArtifact, removeArtifact, ruleBulletInText, rulesDiffOwnedBy, rulesProblem, untaggedRuleBullet, writeArtifact } from "./artifacts.ts";
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
export {
  type DraftContext,
  draftMessages,
  judgeMessages,
  KNOWLEDGE_HEADER,
  parseDraft,
  parseSummary,
  parseVerdict,
  RECENT_LESSONS,
  summaryMessages,
  SUMMARY_HEADER,
} from "./prompts.ts";
export {
  type Cluster,
  cluster,
  lessonTexts,
  loadLedger,
  loadPayloadCorpus,
  plan,
  type PlanOptions,
  reflections,
  scorecardByPattern,
  scorecards,
  sourcesText,
  watermark,
} from "./plan.ts";
export { branchName, run, type RunOptions } from "./run.ts";
export { type GateCorpusResult, type GateRunner, type NudgeAdapter, setNudgeAdapter } from "./deps.ts";
