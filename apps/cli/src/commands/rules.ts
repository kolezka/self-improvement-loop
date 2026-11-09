// sil rules link: put a managed @import of the world's rules file into the
// CLAUDE.md Claude Code loads, so SessionStart stops injecting the same text
// as additionalContext. Idempotent, symlink-preserving, and refuses to pick
// between two worlds that share one CLAUDE.md but point at different rules.

import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fsx, loadConfig, targetRoot, ValidationError, worldClaudeConfigDir, worldNamed, type Config, type World } from "@sil/core";
import { MAX_RULES_BYTES, rulesInjectable } from "@sil/core/lessons";
import { claudeMdImportsRules, MAX_CLAUDE_MD_BYTES, parseRulesImport, removeRulesImport, rulesImportPathProblem, upsertRulesImport } from "@sil/core/rules-import";

export interface RulesLinkOptions {
  world?: string;
  dryRun?: boolean;
}

interface Plan {
  world: World;
  claudeMd: string;
  rulesFile: string | null;
  writeTarget: string;
  mode: number | null;
  before: string;
  after: string;
  action: "write" | "update" | "already" | "remove" | "none";
}

function claudeMdPath(world: World): string {
  return join(worldClaudeConfigDir(world), "CLAUDE.md");
}

function resolvedKey(path: string): string {
  // Resolve the deepest part of the path that exists, so a missing CLAUDE.md
  // (or a missing config dir) still compares equal when its parent is reached
  // through a symlink. Two worlds must not write different rules to one file.
  let current = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.push(basename(current));
      current = parent;
    }
  }
}

/** The world's rules file, validated the same way the hook validates it. */
function rulesFileFor(world: World): string {
  const rulesFile = join(targetRoot(world), world.layout.rules_file);
  const pathProblem = rulesImportPathProblem(rulesFile);
  if (pathProblem) throw new ValidationError(`world ${world.name}: ${pathProblem}; move the data directory to a path without whitespace`);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(rulesFile);
  } catch {
    throw new ValidationError(`world ${world.name}: rules file ${rulesFile} does not exist; run sil init or create it first`);
  }
  const cfg = { rules_inject: world.rules_inject, rules_file: world.layout.rules_file };
  if (!rulesInjectable(cfg, { isFile: st.isFile(), size: st.size })) {
    const why =
      world.rules_inject === false
        ? "rules_inject is false for this world"
        : `${rulesFile} is ${st.size} bytes, over the ${MAX_RULES_BYTES} byte serving cap`;
    throw new ValidationError(`world ${world.name}: ${why}; nothing to import`);
  }
  return rulesFile;
}

/** Refuse when two served worlds resolve to one CLAUDE.md with different rules
 * files: the file can import only one, so one of the worlds would silently
 * load the other's rules (and the hook would not inject either). */
function checkSharedClaudeMd(cfg: Config): void {
  const groups = new Map<string, Array<{ world: World; rules: string }>>();
  for (const world of cfg.worlds) {
    if (world.rules_inject === false) continue;
    const key = resolvedKey(claudeMdPath(world));
    const rows = groups.get(key) ?? [];
    rows.push({ world, rules: resolvedKey(join(targetRoot(world), world.layout.rules_file)) });
    groups.set(key, rows);
  }
  for (const [path, rows] of groups) {
    if (new Set(rows.map((row) => row.rules)).size <= 1) continue;
    const names = rows.map((row) => `${row.world.name} (${row.rules})`).join(", ");
    throw new ValidationError(
      `${path} would import different rules files for ${names}; give each world its own claude_config_dir or align their rules files`,
    );
  }
}

/** Write through a symlink, never over it: atomicWrite renames a new inode into
 * place, which would turn a dotfiles CLAUDE.md symlink into a regular file. */
function writeTargetFor(claudeMd: string): { target: string; mode: number | null } {
  let lst: ReturnType<typeof lstatSync>;
  try {
    lst = lstatSync(claudeMd);
  } catch {
    return { target: claudeMd, mode: null };
  }
  if (lst.isSymbolicLink()) {
    let target: string;
    try {
      target = realpathSync(claudeMd);
    } catch {
      throw new ValidationError(`${claudeMd} is a symlink whose target cannot be resolved; fix the link first`);
    }
    const st = statSync(target);
    if (!st.isFile()) throw new ValidationError(`${claudeMd} resolves to ${target}, which is not a regular file`);
    return { target, mode: st.mode & 0o777 };
  }
  if (!lst.isFile()) throw new ValidationError(`${claudeMd} is not a regular file`);
  return { target: claudeMd, mode: lst.mode & 0o777 };
}

function planFor(world: World): Plan {
  const rulesFile = rulesFileFor(world);
  const claudeMd = claudeMdPath(world);
  if (resolvedKey(claudeMd) === resolvedKey(rulesFile)) {
    throw new ValidationError(`world ${world.name}: ${claudeMd} is the rules file itself; refusing a self-import`);
  }
  const { target, mode } = writeTargetFor(claudeMd);
  let before = "";
  if (existsSync(target)) {
    const st = statSync(target);
    if (st.size > MAX_CLAUDE_MD_BYTES) {
      throw new ValidationError(`${target} is ${st.size} bytes, over the ${MAX_CLAUDE_MD_BYTES} byte CLAUDE.md cap; refusing to rewrite it`);
    }
    before = readFileSync(target, "utf8");
  }
  if (claudeMdImportsRules(before, claudeMd, rulesFile)) {
    return { world, claudeMd, rulesFile, writeTarget: target, mode, before, after: before, action: "already" };
  }
  const hadBlock = parseRulesImport(before) !== null;
  const after = upsertRulesImport(before, rulesFile);
  return { world, claudeMd, rulesFile, writeTarget: target, mode, before, after, action: hadBlock ? "update" : "write" };
}

/** The end state for a world that opted out: no managed import. A CLAUDE.md
 * shared with a served world is left alone, because the block there belongs to
 * that world. */
function unlinkPlanFor(world: World): Plan {
  const claudeMd = claudeMdPath(world);
  const { target, mode } = writeTargetFor(claudeMd);
  let before = "";
  if (existsSync(target)) {
    const st = statSync(target);
    if (st.size > MAX_CLAUDE_MD_BYTES) {
      throw new ValidationError(`${target} is ${st.size} bytes, over the ${MAX_CLAUDE_MD_BYTES} byte CLAUDE.md cap; refusing to rewrite it`);
    }
    before = readFileSync(target, "utf8");
  }
  const after = removeRulesImport(before);
  return {
    world,
    claudeMd,
    rulesFile: null,
    writeTarget: target,
    mode,
    before,
    after: after ?? before,
    action: after === null ? "none" : "remove",
  };
}

/** The outcome of linking one world: what to write, or why nothing changes.
 * Split from the printing so `sil init` can link on install while `sil rules
 * link` keeps its own log line per world. */
export interface RulesLinkOutcome {
  world: string;
  where: string;
  action: "write" | "update" | "already" | "remove" | "none" | "skipped";
  target: string;
  after: string;
  mode: number | null;
  rulesFile: string | null;
  /** Set for "skipped": the world shares a CLAUDE.md with a served world. */
  why?: string;
}

export function cmdRulesLink(opts: RulesLinkOptions = {}): number {
  for (const outcome of rulesLinkOutcomes(opts)) printOutcome(outcome, opts.dryRun === true);
  return 0;
}

function printOutcome(o: RulesLinkOutcome, dryRun: boolean): void {
  if (o.action === "already") {
    console.log(`world ${o.world}: ${o.where} already imports ${o.rulesFile}`);
    return;
  }
  if (o.action === "skipped") {
    console.log(`world ${o.world}: ${o.why}`);
    return;
  }
  if (o.action === "none") {
    console.log(`world ${o.world}: rules_inject is false; no import to remove`);
    return;
  }
  if (o.action === "remove") {
    console.log(dryRun ? `world ${o.world}: would remove import from ${o.where}` : `world ${o.world}: removed import from ${o.where}`);
    return;
  }
  const verb = o.action === "update" ? "update" : "write";
  console.log(
    dryRun
      ? `world ${o.world}: would ${verb} import in ${o.where} -> ${o.rulesFile}`
      : `world ${o.world}: ${o.action === "update" ? "updated" : "wrote"} import in ${o.where} -> ${o.rulesFile}`,
  );
}

/** Link every world (or one). Idempotent: a world already importing its rules
 * file is left alone. Callers that must not print can use the dry run. */
export function rulesLinkOutcomes(opts: RulesLinkOptions = {}): RulesLinkOutcome[] {
  const cfg = loadConfig();
  const selected = opts.world ? [worldNamed(cfg, opts.world)] : cfg.worlds;
  checkSharedClaudeMd(cfg);
  const servedKeys = new Set(
    cfg.worlds.filter((world) => world.rules_inject !== false).map((world) => resolvedKey(claudeMdPath(world))),
  );

  const outcomes: RulesLinkOutcome[] = [];
  const plans: Plan[] = [];
  for (const world of selected) {
    if (world.rules_inject === false) {
      if (servedKeys.has(resolvedKey(claudeMdPath(world)))) {
        outcomes.push({
          world: world.name,
          where: claudeMdPath(world),
          action: "skipped",
          target: claudeMdPath(world),
          after: "",
          mode: null,
          rulesFile: null,
          why: `shares ${claudeMdPath(world)} with a served world; leaving it`,
        });
        continue;
      }
      plans.push(unlinkPlanFor(world));
      continue;
    }
    plans.push(planFor(world));
  }

  for (const plan of plans) {
    const where = plan.claudeMd === plan.writeTarget ? plan.claudeMd : `${plan.claudeMd} -> ${plan.writeTarget}`;
    const action = plan.action;
    // Written here, one plan at a time: every plan was built and validated
    // above, so a bad second world cannot leave the first one half-migrated.
    if (!opts.dryRun && (action === "write" || action === "update" || action === "remove")) {
      fsx.atomicWrite(plan.writeTarget, plan.after);
      if (plan.mode !== null) chmodSync(plan.writeTarget, plan.mode);
    }
    outcomes.push({
      world: plan.world.name,
      where,
      action,
      target: plan.writeTarget,
      after: plan.after,
      mode: plan.mode,
      rulesFile: plan.rulesFile,
    });
  }
  return outcomes;
}
