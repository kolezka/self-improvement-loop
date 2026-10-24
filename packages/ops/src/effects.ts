// Declared effects of the lesson curation ops. The mutation dispatcher reads
// this closed table; an op that is not in it never reaches an owner.

import type { OperationEffects } from "@sil/core/control-mutation";
import { CURATION_MUTATION_OPS } from "@sil/core/lesson-curation-wire";

export type MutationFamily = "curation";
export type DeclaredEffects = OperationEffects & { kind: "mutation" | "read"; family: MutationFamily };

const local = (confirmation: OperationEffects["confirmation"]): DeclaredEffects => ({
  kind: "mutation",
  family: "curation",
  scope: "world",
  model: false,
  remote: false,
  confirmation,
});
const read = (scope: OperationEffects["scope"]): DeclaredEffects => ({
  kind: "read",
  family: "curation",
  scope,
  model: false,
  remote: false,
  confirmation: "none",
});

export const OPERATION_EFFECTS: ReadonlyMap<string, Readonly<DeclaredEffects>> = new Map(
  Object.entries({
    "lessons.capture": local("none"),
    "lessons.edit": local("none"),
    "lessons.setImportant": local("none"),
    "lessons.acknowledgeSource": local("none"),
    "lessons.purge": local("explicit"),
    "lessons.projects": read("world"),
    "lessons.context": read("world"),
    "lessons.browse": read("world"),
    "lessons.get": read("world"),
    "lessons.history": read("world"),
    "lessons.receipt": read("world"),
    "lessons.store": read("installation"),
    "lessons.locate": read("world"),
  }).map(([name, effects]) => [name, Object.freeze(effects)]),
);

/** The only mutation ops the dispatcher may run, in a fixed order. */
export const MUTATION_OPS: readonly string[] = Object.freeze(Object.keys(CURATION_MUTATION_OPS));
