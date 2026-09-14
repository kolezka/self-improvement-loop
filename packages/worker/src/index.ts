// Contract stub: replaced by the port. Signatures are the interface other packages code against.
const notImplemented = (name: string): never => { throw new Error(`${name} is not implemented yet`); };

import type { Config, QueueEntry } from "@sil/core";
import type { ChatFn } from "@sil/providers";

export interface RunSummary { reflected: string[]; failed: string[]; skipped: string[]; curriculum: Record<string, unknown>; duration_s: number; locked?: boolean }
export interface WorkerStatus { lock_held: boolean; lock_pid: number | null; pending: number; done: number; failed: number; last_run: string | null; last_summary: RunSummary | null; last_curriculum: Record<string, string> }
export interface RunOnceOptions { worldName?: string; reflect?: boolean; curriculum?: boolean; chat?: ChatFn }

export const MAX_ATTEMPTS = 3;
export class Lock {
  static held(): boolean { return notImplemented("Lock.held"); }
  acquire(): void { notImplemented("Lock.acquire"); }
  release(): void { notImplemented("Lock.release"); }
}
export async function withLock<T>(_fn: () => Promise<T> | T): Promise<T> { return notImplemented("withLock"); }
export function skipSession(_sessionId: string): boolean { return notImplemented("skipSession"); }
export function eligible(_entry: QueueEntry, _cfg: Config, _now: Date): [boolean, string] { return notImplemented("eligible"); }
export async function runOnce(_cfg?: Config, _opts?: RunOnceOptions): Promise<RunSummary> { return notImplemented("runOnce"); }
export function status(): WorkerStatus { return notImplemented("status"); }
export async function loop(_cfg: Config, _intervalS: number): Promise<never> { return notImplemented("loop"); }
