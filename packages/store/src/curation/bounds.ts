// Size limits on whole read results. A result that cannot fit is an error,
// never a silently clipped answer.

import { CURATION_MAX_RESULT_BYTES } from "@sil/core/curation-read";
import { CurationError, utf8Bytes } from "@sil/core/lesson-curation";

/** Serialized UTF-8 size of a value as the transport will send it. */
export function jsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value));
}

export function resultTooLarge(): CurationError {
  return new CurationError("STORAGE_UNAVAILABLE", ["result_too_large"]);
}

/** Return the result if its whole serialized form fits the cap, else throw. */
export function boundedResult<T>(result: T): T {
  if (jsonBytes(result) > CURATION_MAX_RESULT_BYTES) throw resultTooLarge();
  return result;
}
