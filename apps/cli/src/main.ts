// sil CLI entry. Builds one commander program from every command group and
// maps errors to exit codes.
//
// Every command function returns its own exit code (or throws a domain
// error). `wire()` runs one, marks that a command actually ran, and records
// the code. `run()` parses argv, maps whatever comes out of that into a
// process exit code, and never leaves a domain error as a raw stack trace.

import { Command, CommanderError } from "commander";
import { ValidationError } from "@sil/core";
import { mapKnownError } from "./common.ts";
import { defaultDeps, type Deps } from "./deps.ts";
import { cmdArtifacts } from "./commands/artifacts.ts";
import { cmdCurriculumPlan, cmdCurriculumRun } from "./commands/curriculum.ts";
import { cmdFeedbackAdd, cmdFeedbackList } from "./commands/feedback.ts";
import { cmdHookSnapshot } from "./commands/hookSnapshot.ts";
import { cmdImportLedger, cmdImportReflections } from "./commands/import.ts";
import { cmdInit } from "./commands/init.ts";
import { cmdLessons } from "./commands/lessons.ts";
import { cmdLlmList, cmdLlmSetModel, cmdLlmUse } from "./commands/llm.ts";
import { cmdLogs } from "./commands/logs.ts";
import { cmdReflect } from "./commands/reflect.ts";
import { cmdReflectionsList, cmdReflectionsShow } from "./commands/reflections.ts";
import { cmdReviewAccept, cmdReviewList, cmdReviewRehome, cmdReviewReject, cmdReviewRetire, cmdReviewShow } from "./commands/review.ts";
import { cmdScheduleInstall, cmdScheduleShow, cmdScheduleUninstall } from "./commands/schedule.ts";
import { cmdStatus } from "./commands/status.ts";
import { cmdWeb } from "./commands/web.ts";
import { cmdWorker } from "./commands/worker.ts";
import { cmdWorldsAdd, cmdWorldsImportKb, cmdWorldsList } from "./commands/worlds.ts";

const intOption = (v: string) => parseInt(v, 10);

function buildProgram(deps: Deps, onExit: (code: number) => void, onRun: () => void): Command {
  const program = new Command();
  program.name("sil").description("self-improvement-loop engine").exitOverride();

  const wire = <A extends unknown[]>(fn: (...args: A) => number | Promise<number>) => {
    return async (...args: A) => {
      onRun();
      onExit(await fn(...args));
    };
  };

  program
    .command("init")
    .option("--world <name>")
    .option("--target <path>")
    .option("--llm-base-url <url>")
    .option("--api-key-env <name>")
    .option("--model <name>")
    .option("--claude-model <name>")
    .action(wire((opts) => cmdInit(opts)));

  program
    .command("status")
    .option("--json")
    .action(wire((opts) => cmdStatus(opts, deps)));

  program
    .command("reflect")
    .option("--session <id>")
    .option("--cwd <path>")
    .option("--now")
    .action(wire((opts) => cmdReflect(opts, deps)));

  program
    .command("worker")
    .option("--once")
    .option("--loop")
    .option("--interval-s <n>", "seconds between loop passes", intOption)
    .option("--world <name>")
    .option("--no-curriculum")
    .action(
      wire((opts) => {
        const { curriculum, ...rest } = opts as { curriculum?: boolean; once?: boolean; loop?: boolean; intervalS?: number; world?: string };
        return cmdWorker({ ...rest, noCurriculum: curriculum === false }, deps);
      }),
    );

  const curriculum = program.command("curriculum");
  curriculum
    .command("plan")
    .option("--world <name>")
    .option("--json")
    .action(wire((opts) => cmdCurriculumPlan(opts, deps)));
  curriculum
    .command("run")
    .option("--world <name>")
    .option("--apply")
    .option("--json")
    .action(wire((opts) => cmdCurriculumRun(opts, deps)));

  const review = program.command("review");
  review
    .command("list")
    .option("--world <name>")
    .action(wire((opts) => cmdReviewList(opts, deps)));
  review
    .command("show")
    .argument("<pattern>")
    .option("--world <name>")
    .option("--diff")
    .action(wire((pattern: string, opts) => cmdReviewShow(pattern, opts, deps)));
  review
    .command("accept")
    .argument("<pattern>")
    .requiredOption("--world <name>")
    .requiredOption("--reviewed-state <hash>")
    .action(wire((pattern: string, opts) => cmdReviewAccept(pattern, opts, deps)));
  review
    .command("reject")
    .argument("<pattern>")
    .requiredOption("--world <name>")
    .action(wire((pattern: string, opts) => cmdReviewReject(pattern, opts, deps)));
  review
    .command("rehome")
    .argument("<pattern>")
    .requiredOption("--type <type>")
    .requiredOption("--world <name>")
    .action(wire((pattern: string, opts) => cmdReviewRehome(pattern, opts, deps)));
  review
    .command("retire")
    .argument("<pattern>")
    .requiredOption("--world <name>")
    .option("--yes")
    .action(wire((pattern: string, opts) => cmdReviewRetire(pattern, opts, deps)));

  const reflections = program.command("reflections");
  reflections
    .command("list")
    .option("--world <name>")
    .option("--pattern <pattern>")
    .option("--limit <n>", "", intOption)
    .action(wire((opts) => cmdReflectionsList(opts)));
  reflections
    .command("show")
    .argument("<id>")
    .requiredOption("--world <name>")
    .action(wire((id: string, opts) => cmdReflectionsShow(id, opts)));

  program
    .command("artifacts")
    .argument("[action]")
    .option("--world <name>")
    .option("--json")
    .action(wire((action: string | undefined, opts) => cmdArtifacts({ ...opts, action: action as "rebuild" | undefined }, deps)));

  const feedback = program.command("feedback");
  feedback
    .command("add")
    .argument("<ref>")
    .argument("<vote>")
    .option("--note <text>")
    .option("--world <name>")
    .action(
      wire((ref: string, vote: string, opts) => {
        if (vote !== "good" && vote !== "bad") throw new ValidationError("vote must be good or bad");
        return cmdFeedbackAdd(ref, vote, opts, deps);
      }),
    );
  feedback.command("list").action(wire(() => cmdFeedbackList(deps)));

  program
    .command("lessons")
    .option("--world <name>")
    .action(wire((opts) => cmdLessons(opts)));

  const llm = program.command("llm");
  llm
    .command("list")
    .option("--json")
    .option("--world <name>")
    .action(wire((opts) => cmdLlmList(opts, deps)));
  llm
    .command("use")
    .argument("<endpoint>")
    .option("--role <role>", "critic, drafter or judge; omit to switch every role")
    .action(wire((endpoint: string, opts) => cmdLlmUse(endpoint, opts)));
  llm
    .command("set-model")
    .argument("<role>")
    .argument("<model>")
    .option("--endpoint <name>", "defaults to the endpoint that currently serves the role")
    .action(wire((role: string, model: string, opts) => cmdLlmSetModel(role, model, opts)));

  program
    .command("web")
    .option("--port <n>", "", intOption)
    .option("--token", "force a URL token (default: on only for non-loopback binds)")
    .option("--no-token", "force tokenless (loopback only)")
    .option("--open")
    .option("--host <host>", "bind address; defaults to config web.host (127.0.0.1). Use a LAN or tailscale address, or 0.0.0.0, to reach it from another machine")
    .action(wire((opts) => cmdWeb(opts)));

  const worlds = program.command("worlds");
  worlds.command("list").action(wire(() => cmdWorldsList()));
  worlds
    .command("add")
    .argument("<name>")
    .option("--repos <repos...>")
    .option("--target <path>")
    .option("--llm <llm>")
    .option("--layout <layout>", "", "default")
    .action(wire((name: string, opts) => cmdWorldsAdd(name, opts)));
  worlds
    .command("import-kb")
    .argument("<path>")
    .action(wire((path: string) => cmdWorldsImportKb(path)));

  const imp = program.command("import");
  imp
    .command("reflections")
    .argument("<dir>")
    .requiredOption("--world <name>")
    .action(wire((dir: string, opts) => cmdImportReflections(dir, opts)));
  imp
    .command("ledger")
    .argument("<file>")
    .requiredOption("--world <name>")
    .action(wire((file: string, opts) => cmdImportLedger(file, opts)));

  const sched = program.command("schedule");
  sched
    .command("install")
    .option("--systemd")
    .option("--launchd")
    .option("--web")
    .option("--interval-min <n>", "", intOption)
    .action(wire((opts) => cmdScheduleInstall(opts)));
  sched.command("uninstall").action(wire(() => cmdScheduleUninstall()));
  sched.command("show").action(wire(() => cmdScheduleShow()));

  program
    .command("logs")
    .argument("<name>")
    .option("--lines <n>", "", intOption)
    .action(wire((name: string, opts) => cmdLogs(name, opts)));

  program.command("hook-snapshot").action(wire(() => cmdHookSnapshot()));

  return program;
}

/** Parse argv and run the matched command. Returns the process exit code,
 * never throws for a known domain error (`ConfigError`, `ReviewError`,
 * `GitError`, `ProviderError`, `ValidationError`, `LockHeld`). */
export async function run(argv: string[], deps: Deps = defaultDeps): Promise<number> {
  let exitCode = 0;
  let ran = false;
  const program = buildProgram(
    deps,
    (n) => {
      exitCode = n;
    },
    () => {
      ran = true;
    },
  );

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    if (err instanceof CommanderError) {
      // Commander's own parsing errors (help, version, missing required
      // option, unknown command) already printed their own message.
      return err.exitCode;
    }
    const mapped = mapKnownError(err);
    if (mapped !== null) return mapped;
    // Unexpected error: fail loud, keep the trace, still return a code.
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return 1;
  }

  if (!ran) {
    program.outputHelp();
    return 1;
  }
  return exitCode;
}

if (import.meta.main) {
  const code = await run(process.argv.slice(2));
  process.exit(code);
}
