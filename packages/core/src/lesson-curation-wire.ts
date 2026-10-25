// Client side of a curation mutation: turns a prepared editor mutation into
// the one canonical wire envelope. Pure (no zod, no Node, no Bun). It never
// copies or rewrites the domain payload; the host revalidates everything.

import { encodeMutationRequestEnvelope, type MutationRequestEnvelope } from "./control-mutation.ts";
import type { ProjectDescriptor } from "./curation-read.ts";
import {
  CURATION_REQUEST_ID_RE,
  CurationError,
  SHA256_HEX_RE,
  UUID_RE,
  type CurationChange,
  type CurationMutation,
  type CurationPrecondition,
} from "./lesson-curation.ts";

export const CURATION_MUTATION_OPS = Object.freeze({
  "lessons.capture": "capture",
  "lessons.edit": "edit",
  "lessons.setImportant": "important",
  "lessons.acknowledgeSource": "acknowledge-source",
  "lessons.purge": "purge",
} as const satisfies Record<string, CurationChange["kind"]>);
export type CurationMutationOp = keyof typeof CURATION_MUTATION_OPS;

/** `args` of every curation mutation op. */
export type CurationMutationArgs = {
  v: 1;
  mutation: CurationMutation;
  precondition: CurationPrecondition;
  /** Only for a capture into a project scope. The host revalidates it; never derived from the id. */
  projectRoot: string | null;
};

/** Structurally the editor's PreparedLessonMutation. */
export type PreparedCurationMutation = { mutation: CurationMutation; precondition: CurationPrecondition };

const OP_FOR_KIND: Readonly<Record<string, CurationMutationOp>> = Object.freeze(
  Object.fromEntries(Object.entries(CURATION_MUTATION_OPS).map(([op, kind]) => [kind, op as CurationMutationOp])),
);

/** The op for a change kind, or undefined for anything else. */
export function curationOpFor(kind: unknown): CurationMutationOp | undefined {
  return typeof kind === "string" && Object.hasOwn(OP_FOR_KIND, kind) ? OP_FOR_KIND[kind] : undefined;
}

function preconditionOk(p: CurationPrecondition | null | undefined): boolean {
  if (p === null || typeof p !== "object") return false;
  if (p.kind === "installation") return typeof p.id === "string" && UUID_RE.test(p.id);
  if (p.kind === "uninitialized") return typeof p.locationId === "string" && SHA256_HEX_RE.test(p.locationId);
  return false;
}

function projectRootFor(m: CurationMutation, project: ProjectDescriptor | null): string | null {
  const scope = m.scope?.project;
  const projectCapture = m.change.kind === "capture" && scope?.kind === "project";
  if (!projectCapture) {
    if (project !== null) throw new CurationError("INVALID_INPUT", ["project"]);
    return null;
  }
  if (project === null || project.world !== m.scope.world || project.projectId !== scope.id || typeof project.root !== "string" || project.root.length === 0) {
    throw new CurationError("INVALID_INPUT", ["project"]);
  }
  return project.root;
}

/** The canonical envelope for one prepared curation mutation. */
export function toCurationMutationEnvelope(prepared: PreparedCurationMutation, project: ProjectDescriptor | null): MutationRequestEnvelope {
  const { mutation, precondition } = prepared;
  if (typeof mutation?.requestId !== "string" || !CURATION_REQUEST_ID_RE.test(mutation.requestId)) throw new CurationError("INVALID_INPUT", ["requestId"]);
  if (!preconditionOk(precondition)) throw new CurationError("INVALID_INPUT", ["precondition"]);
  const change = mutation.change as { kind?: unknown; confirmed?: unknown } | null;
  const op = curationOpFor(change?.kind);
  if (op === undefined) throw new CurationError("INVALID_INPUT", ["change.kind"]);
  // A purge must say so itself; the outer flag is never inferred from the op.
  if (op === "lessons.purge" && change?.confirmed !== true) throw new CurationError("INVALID_INPUT", ["change.confirmed"]);
  const args: CurationMutationArgs = { v: 1, mutation, precondition, projectRoot: projectRootFor(mutation, project) };
  return { version: 1, requestId: mutation.requestId, mutation: { op, args, confirmed: op === "lessons.purge" } };
}

/** Encoded request text. Throws ControlProtocolError over the whole-envelope limit. */
export function encodeCurationMutationRequest(prepared: PreparedCurationMutation, project: ProjectDescriptor | null): string {
  return encodeMutationRequestEnvelope(toCurationMutationEnvelope(prepared, project));
}
