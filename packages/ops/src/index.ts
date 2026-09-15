// Registers the 31 ops the web UI and CLI invoke. Every handler validates its
// own payload via args.ts before touching disk, git or a spawned process.
// Same names, tiers and gates as the Python port (sil/ops.py).

import * as Args from "./args.ts";
import * as aliases from "./handlers/aliases.ts";
import * as artifacts from "./handlers/artifacts.ts";
import * as curriculum from "./handlers/curriculum.ts";
import * as health from "./handlers/health.ts";
import * as llm from "./handlers/llm.ts";
import * as logs from "./handlers/logs.ts";
import * as queue from "./handlers/queue.ts";
import * as reflections from "./handlers/reflections.ts";
import * as review from "./handlers/review.ts";
import * as worlds from "./handlers/worlds.ts";
import { register } from "./registry.ts";

register({ name: "health.report", tier: "read", gate: "none", args: Args.NoArgs, fn: health.healthReport, doc: "Config paths, per-world provider status, worker status, versions." });
register({ name: "worlds.list", tier: "read", gate: "none", args: Args.NoArgs, fn: worlds.worldsList, doc: "List configured worlds." });
register({ name: "config.get", tier: "read", gate: "none", args: Args.NoArgs, fn: worlds.configGet, doc: "Read config.yaml." });
register({ name: "config.set", tier: "local", gate: "none", args: Args.ConfigArgs, fn: worlds.configSet, doc: "Validate and write config.yaml; refresh the hook snapshot." });
register({ name: "llm.get", tier: "read", gate: "none", args: Args.NoArgs, fn: llm.llmGet, doc: "Read llm.yaml. Never includes secret values, only env var names." });
register({ name: "llm.set", tier: "local", gate: "none", args: Args.LlmArgs, fn: llm.llmSet, doc: "Validate and write llm.yaml." });
register({ name: "llm.status", tier: "read", gate: "none", args: Args.WorldArgs, fn: llm.llmStatus, doc: "Provider reachability for a world, per endpoint." });
register({ name: "llm.use", tier: "local", gate: "none", args: Args.LlmUseArgs, fn: llm.llmUse, doc: "Switch the active endpoint, or route one role to an endpoint." });
register({ name: "queue.list", tier: "read", gate: "none", args: Args.NoArgs, fn: queue.queueList, doc: "Pending, done and failed queue entries." });
register({ name: "queue.skip", tier: "local", gate: "none", args: Args.SessionArgs, fn: queue.queueSkip, doc: "Skip a pending session." });
register({ name: "worker.status", tier: "read", gate: "none", args: Args.NoArgs, fn: queue.workerStatus, doc: "Worker lock/last-run status." });
register({ name: "loop.run", tier: "local", gate: "none", args: Args.WorldArgs, fn: queue.loopRun, doc: "Spawn a detached worker --once run." });
register({ name: "curriculum.plan", tier: "read", gate: "none", args: Args.WorldArgs, fn: curriculum.curriculumPlan, doc: "Dry-run curriculum plan for a world." });
register({ name: "curriculum.run", tier: "local", gate: "none", args: Args.WorldArgs, fn: curriculum.curriculumRun, doc: "Spawn a detached curriculum run --apply for a world." });
register({ name: "reflections.list", tier: "read", gate: "none", args: Args.ReflectionListArgs, fn: reflections.reflectionsList, doc: "List reflections, newest first, filterable by pattern." });
register({ name: "reflections.get", tier: "read", gate: "none", args: Args.ReflectionArgs, fn: reflections.reflectionsGet, doc: "Full body of one reflection." });
register({ name: "aliases.get", tier: "read", gate: "none", args: Args.WorldArgs, fn: aliases.aliasesGet, doc: "Pattern alias map for a world." });
register({ name: "aliases.set", tier: "local", gate: "none", args: Args.AliasArgs, fn: aliases.aliasesSet, doc: "Replace the alias map for a world." });
register({ name: "review.queue", tier: "read", gate: "none", args: Args.WorldArgs, fn: review.reviewQueue, doc: "Staged proposals waiting for review." });
register({ name: "review.detail", tier: "read", gate: "none", args: Args.PatternArgs, fn: review.reviewDetail, doc: "Body and reviewed_state of one proposal." });
register({ name: "review.diff", tier: "read", gate: "none", args: Args.PatternArgs, fn: review.reviewDiff, doc: "Diff of one staged proposal." });
register({ name: "skill.accept", tier: "remote", gate: "reviewed_state", args: Args.AcceptArgs, fn: review.skillAccept, doc: "Accept a staged proposal; reviewed_state must match exactly what was reviewed." });
register({ name: "skill.reject", tier: "local", gate: "none", args: Args.PatternArgs, fn: review.skillReject, doc: "Reject a staged proposal; delete its branch." });
register({ name: "router.rehome", tier: "local", gate: "none", args: Args.RehomeArgs, fn: review.routerRehome, doc: "Re-route a pattern to a different artifact type." });
register({ name: "router.retire", tier: "local", gate: "confirm", args: Args.RetireArgs, fn: review.routerRetire, doc: "Retire an artifact; requires confirm: true." });
register({ name: "router.inventory", tier: "read", gate: "none", args: Args.WorldArgs, fn: review.routerInventory, doc: "Router state joined with scorecards." });
register({ name: "artifacts.scorecards", tier: "read", gate: "none", args: Args.WorldArgs, fn: artifacts.artifactsScorecards, doc: "Per-artifact usage scorecards." });
register({ name: "artifacts.rebuild", tier: "local", gate: "none", args: Args.WorldArgs, fn: artifacts.artifactsRebuild, doc: "Recompute scorecards for a world." });
register({ name: "feedback.add", tier: "local", gate: "none", args: Args.FeedbackArgs, fn: artifacts.feedbackAdd, doc: "Record a human good/bad vote on an artifact." });
register({ name: "lessons.list", tier: "read", gate: "none", args: Args.WorldArgs, fn: artifacts.lessonsList, doc: "Inbox lessons for a world." });
register({ name: "logs.tail", tier: "read", gate: "none", args: Args.LogArgs, fn: logs.logsTail, doc: "Last N lines of one engine log." });

export * from "./registry.ts";
export * as opsArgs from "./args.ts";
export { deps, setDeps, type Deps } from "./deps.ts";
export { cfgWorld } from "./cfg-world.ts";
export { spawnCli, type SpawnResult } from "./spawn.ts";
