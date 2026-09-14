// The ops registry: the only surface the web UI and the CLI may invoke to
// read or mutate loop state.
//
// A caller names an op and supplies a payload. The op's `args` schema
// validates the payload; the op's `fn` receives the validated args and
// returns JSON-serialisable data. No caller builds a path, a branch name or a
// shell command directly: every op does that internally, so a bad slug or a
// wrong reviewed_state digest fails at validation, before anything runs.

import type { ZodType } from "zod";
import { ValidationError } from "@sil/core";

export type Tier = "read" | "local" | "remote";
export type GateKind = "none" | "reviewed_state" | "confirm";

export interface Op<A = unknown> {
  name: string;
  tier: Tier;
  gate: GateKind;
  args: ZodType<A>;
  fn: (args: A) => unknown | Promise<unknown>;
  doc: string;
}
export interface OpMeta { name: string; tier: Tier; gate: GateKind; doc: string }

export const REGISTRY: Map<string, Op> = new Map();

/** Add an op to the registry, refusing one that understates its own risk. */
export function register<A>(op: Op<A>): Op<A> {
  if (REGISTRY.has(op.name)) throw new Error(`duplicate op name: ${JSON.stringify(op.name)}`);
  if (op.tier === "remote" && op.gate === "none") {
    throw new Error(`${op.name}: a remote op must declare a gate other than none`);
  }
  if ((op.name.includes("accept") || op.name.includes("push")) && op.tier !== "remote") {
    throw new Error(`${op.name}: name implies a remote write; must be tier remote`);
  }
  REGISTRY.set(op.name, op as Op);
  return op;
}

export async function invoke(name: string, payload: unknown): Promise<unknown> {
  const op = REGISTRY.get(name);
  if (!op) throw new ValidationError(`unknown op: ${JSON.stringify(name)}`);
  const args = op.args.parse(payload ?? {});
  return await op.fn(args);
}

/** Meta listing for `GET /api/ops`: enough for the UI to render buttons. */
export function listOps(): OpMeta[] {
  return [...REGISTRY.values()]
    .map((op) => ({ name: op.name, tier: op.tier, gate: op.gate, doc: op.doc }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** "review.queue" -> "/api/review/queue" */
export function opPath(name: string): string {
  return "/api/" + name.replace(/\./g, "/");
}
