// Host-side validation of a curation mutation. Uses zod, so it is not
// native-safe; the console imports lesson-curation.ts instead. Errors carry a
// fixed message and field names, never input text.

import { z } from "zod";
import { WORLD_NAME_RE } from "./consts.ts";
import {
  CURATION_REQUEST_ID_RE,
  CurationError,
  hasVisibleText,
  isWellFormed,
  lessonKeyProblems,
  MAX_MUTATION_BYTES,
  MAX_QUOTE_BYTES,
  MAX_REFERENCE_BYTES,
  MAX_TEXT_BYTES,
  PROJECT_ID_RE,
  SHA256_HEX_RE,
  UUID_RE,
  utf8Bytes,
  type CurationMutation,
  type CurationPrecondition,
} from "./lesson-curation.ts";
import type { CurationMutationArgs } from "./lesson-curation-wire.ts";
import { containsSensitiveText } from "./sensitive-text.ts";

// The regex bounds length in code points; a .max() here would count UTF-16 units.
const world = z.string().regex(WORLD_NAME_RE);
const sourceId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).nullable();

const CaptureSourceSchema = z.strictObject({
  kind: z.enum(["native_selection", "explicit_quote"]),
  quote: z.string().nullable(),
  reference: z.string().nullable(),
  quoteRedacted: z.boolean(),
  captureSessionId: sourceId,
  sourceConversationId: sourceId,
  sourceRowId: sourceId,
  sourceAgentId: sourceId,
});

const CurationChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("capture"), text: z.string(), source: CaptureSourceSchema }),
  z.strictObject({ kind: z.literal("edit"), text: z.string() }),
  z.strictObject({ kind: z.literal("important"), value: z.boolean() }),
  z.strictObject({ kind: z.literal("acknowledge-source"), digest: z.string().regex(SHA256_HEX_RE) }),
  z.strictObject({ kind: z.literal("purge"), confirmed: z.literal(true) }),
]);

const CurationMutationSchema = z.strictObject({
  requestId: z.string().regex(CURATION_REQUEST_ID_RE),
  binding: z.strictObject({ kind: z.enum(["location", "installation"]), id: z.string() }),
  scope: z.strictObject({
    world,
    project: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("project"), id: z.string().regex(PROJECT_ID_RE) }),
      z.strictObject({ kind: z.literal("world") }),
      z.strictObject({ kind: z.literal("unresolved") }),
    ]),
  }),
  key: z.strictObject({ world: z.string(), kind: z.enum(["capture", "inbox"]), id: z.string() }),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  change: CurationChangeSchema,
});

function fieldName(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "$" : path.map(String).join(".");
}

/** Text a human reviewed: well-formed, visible, within its byte limit, kept
 * byte for byte. A lone surrogate is refused because storage would not keep it. */
function checkText(value: string | null, field: string, maxBytes: number, problems: string[]): void {
  if (value === null) return;
  if (!isWellFormed(value) || !hasVisibleText(value) || utf8Bytes(value) > maxBytes) problems.push(field);
}

/** Validate an untrusted mutation at the host write boundary. */
export function parseCurationMutation(value: unknown): CurationMutation {
  let envelope: string | undefined;
  try {
    envelope = JSON.stringify(value);
  } catch {
    throw new CurationError("INVALID_INPUT", ["$"]);
  }
  if (envelope === undefined || utf8Bytes(envelope) > MAX_MUTATION_BYTES) {
    throw new CurationError("INVALID_INPUT", ["$"]);
  }

  const result = CurationMutationSchema.safeParse(value);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => fieldName(issue.path)))];
    throw new CurationError("INVALID_INPUT", fields);
  }
  const mutation = result.data as CurationMutation;

  const keyProblems = lessonKeyProblems(mutation.key).map((field) => `key.${field}`);
  if (keyProblems.length > 0) throw new CurationError("INVALID_INPUT", keyProblems);
  if (mutation.key.world !== mutation.scope.world) throw new CurationError("SCOPE_CONFLICT", ["key.world"]);

  const bindingOk =
    mutation.binding.kind === "installation" ? UUID_RE.test(mutation.binding.id) : SHA256_HEX_RE.test(mutation.binding.id);
  if (!bindingOk) throw new CurationError("INVALID_INPUT", ["binding.id"]);

  const change = mutation.change;
  if (change.kind === "capture" && mutation.key.kind !== "capture") throw new CurationError("INVALID_INPUT", ["key.kind"]);

  const problems: string[] = [];
  const reviewed: Array<[string, string | null]> = [];
  if (change.kind === "capture" || change.kind === "edit") {
    checkText(change.text, "change.text", MAX_TEXT_BYTES, problems);
    reviewed.push(["change.text", change.text]);
  }
  if (change.kind === "capture") {
    const { quote, reference } = change.source;
    checkText(quote, "change.source.quote", MAX_QUOTE_BYTES, problems);
    checkText(reference, "change.source.reference", MAX_REFERENCE_BYTES, problems);
    if (quote === null && reference === null) problems.push("change.source");
    reviewed.push(["change.source.quote", quote], ["change.source.reference", reference]);
  }
  if (problems.length > 0) throw new CurationError("INVALID_INPUT", problems);

  const sensitive = reviewed.filter(([, text]) => text !== null && containsSensitiveText(text)).map(([field]) => field);
  if (sensitive.length > 0) throw new CurationError("SENSITIVE_CONTENT", sensitive);

  return mutation;
}

const MAX_PROJECT_ROOT_CHARS = 4096;

const CurationPreconditionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("installation"), id: z.string().regex(UUID_RE) }),
  z.strictObject({ kind: z.literal("uninitialized"), locationId: z.string().regex(SHA256_HEX_RE) }),
]);

const CurationArgsShape = z.strictObject({
  v: z.literal(1),
  mutation: z.unknown(),
  precondition: CurationPreconditionSchema,
  projectRoot: z.string().min(1).max(MAX_PROJECT_ROOT_CHARS).nullable(),
});

/** Validate the `args` of a curation mutation op at the host boundary. */
export function parseCurationMutationArgs(value: unknown): CurationMutationArgs {
  const shape = CurationArgsShape.safeParse(value);
  if (!shape.success) {
    const fields = [...new Set(shape.error.issues.map((issue) => fieldName(issue.path)))];
    throw new CurationError("INVALID_INPUT", fields);
  }
  // A missing key would parse as undefined through z.unknown(); require it.
  if (!Object.hasOwn(value as object, "mutation")) throw new CurationError("INVALID_INPUT", ["mutation"]);
  const mutation = parseCurationMutation(shape.data.mutation);
  const precondition = shape.data.precondition as CurationPrecondition;
  const binding = mutation.binding;
  if (precondition.kind === "uninitialized") {
    // Bootstrap only for this exact location.
    if (binding.kind !== "location" || binding.id !== precondition.locationId) throw new CurationError("INVALID_INPUT", ["precondition"]);
  } else if (binding.kind === "installation" && binding.id !== precondition.id) {
    throw new CurationError("INVALID_INPUT", ["precondition"]);
  }
  const projectRoot = shape.data.projectRoot;
  const projectCapture = mutation.change.kind === "capture" && mutation.scope.project.kind === "project";
  if (projectCapture !== (projectRoot !== null)) throw new CurationError("INVALID_INPUT", ["projectRoot"]);
  if (projectRoot !== null && !projectRoot.startsWith("/")) throw new CurationError("INVALID_INPUT", ["projectRoot"]);
  return { v: 1, mutation, precondition, projectRoot };
}
