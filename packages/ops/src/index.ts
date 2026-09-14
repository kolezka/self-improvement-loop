// Contract stub: replaced by the port. Signatures are the interface other packages code against.
const notImplemented = (name: string): never => { throw new Error(`${name} is not implemented yet`); };

import type { ZodType } from "zod";

export type Tier = "read" | "local" | "remote";
export type GateKind = "none" | "reviewed_state" | "confirm";
export interface Op<A = unknown> { name: string; tier: Tier; gate: GateKind; args: ZodType<A>; fn: (args: A) => unknown | Promise<unknown>; doc: string }
export interface OpMeta { name: string; tier: Tier; gate: GateKind; doc: string }

export const REGISTRY: Map<string, Op> = new Map();
export function register<A>(_op: Op<A>): void { notImplemented("register"); }
export async function invoke(_name: string, _payload: unknown): Promise<unknown> { return notImplemented("invoke"); }
export function listOps(): OpMeta[] { return notImplemented("listOps"); }
export function opPath(_name: string): string { return notImplemented("opPath"); }
