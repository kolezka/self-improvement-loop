export {
  CURATION_BUSY_TIMEOUT_MS,
  CURATION_SCHEMA_VERSION,
  CurationStoreError,
  classifyDarwinMounts,
  classifyLinuxMountinfo,
  curationDatabaseFile,
  curationDir,
  curationGuardFile,
  curationIdentityFile,
  curationLocationId,
  decodeRecordId,
  encodeRecordId,
  inspectCurationStore,
  openCurationStore,
  openCurationStoreForMutation,
  probeFilesystem,
} from "./database.ts";
export type { CurationDatabase, FilesystemClass, StoreProblem, StoreStatus } from "./database.ts";
export { CurationConflictError, applyCurationMutation, attemptCurationMutation, getCurationReceipt } from "./mutations.ts";
export type { CurationWriteAttempt, CurationWriteContext, MutationDeps } from "./mutations.ts";
export { legacySourceDigestV1 } from "./source.ts";
export type { LegacySourceSnapshot } from "./source.ts";
export { openCurationStoreForRead } from "./database.ts";
export type { CurationReadHandle } from "./database.ts";
export { LegacySourceError, MAX_LEGACY_SOURCE_BYTES, inspectLegacySource, readLegacySource, sourceDigest } from "./sources.ts";
export type { LegacySourceObservation } from "./sources.ts";
export {
  CURATION_GIT_PROBE,
  GitProbeError,
  listCurationProjects,
  projectIdForRoot,
  resolveCurationContext,
  storedScopes,
  validateCurationScope,
} from "./projects.ts";
export type { CurationProjectOptions, ScopeValidationInput } from "./projects.ts";
export { browseCuratedLessons, getCuratedLesson, locateCuratedLesson, readCurationHistory } from "./read.ts";
export type { CurationReadOptions } from "./read.ts";
