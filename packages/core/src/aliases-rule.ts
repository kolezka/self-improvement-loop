// The one-hop alias rule, shared by the file store and the loop-state store.

import { ValidationError } from "./errors.ts";

/** Throws ValidationError when a key is also some entry's value, its own
 * included: aliases resolve one hop only. */
export function assertOneHop(aliases: Record<string, string>): void {
  const values = new Set(Object.values(aliases));
  for (const key of Object.keys(aliases)) {
    if (!values.has(key)) continue;
    const source = Object.entries(aliases).find(([k, v]) => v === key && k !== key)?.[0];
    throw new ValidationError(
      source
        ? `"${key}" is a key (-> "${aliases[key]}") and also the value of "${source}" (-> "${key}"); aliases resolve one hop only`
        : `"${key}" is a key (-> "${aliases[key]}") and also its own value`,
    );
  }
}
