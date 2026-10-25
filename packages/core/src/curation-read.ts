// Read-side curation DTOs: store identity envelope, project choices, lesson
// detail with provenance, and source diagnostics. Native-safe like
// lesson-curation.ts: types and constants only, no node:, no Bun, no zod.

import type { CaptureSource, CurationPage, LessonScope, LessonView } from "./lesson-curation.ts";

export const CURATION_DEFAULT_PAGE_SIZE = 25;
export const CURATION_MAX_PAGE_SIZE = 100;
/**
 * Whole serialized read result: store identity, items, cursor and diagnostics.
 * Half the parent's 1 MiB envelope. A page ends early rather than clipping text.
 */
export const CURATION_MAX_RESULT_BYTES = 512 * 1024;
/** Share of a browse result the source-problem list may use. The rest is counted. */
export const CURATION_MAX_DIAGNOSTIC_BYTES = 64 * 1024;
export const CURATION_MAX_SEARCH_CHARS = 200;

/** Identity of the store a read actually used, taken from the read handle itself. */
export interface CurationStoreIdentity {
  locationId: string;
  /** null only for a store verified as uninitialized. */
  installationId: string | null;
}

export interface CurationReadResult<T> {
  store: CurationStoreIdentity;
  value: T;
}

export type LegacySourceLocation = "active" | "archive";

/** Why one legacy source file could not be used. Safe to show: no content. */
export type LegacySourceProblem =
  | "too_large"
  | "unreadable"
  | "unsafe_path"
  | "invalid_json"
  | "invalid_schema"
  | "identity_mismatch";

/** One source file the reader could not use, named by its file name only. */
export interface LegacySourceFileProblem {
  location: LegacySourceLocation;
  file: string;
  problem: LegacySourceProblem;
}

/** Why a source repo value did not map to a project. */
export type RepoUnresolvedReason = "relative_path" | "missing_root" | "not_owned_by_world" | "ambiguous" | "no_project_root";

export type CurationDiagnostic =
  | { code: "duplicate_source_location" }
  | { code: "source_conflict"; copies: Array<{ location: LegacySourceLocation; digest: string }> }
  | { code: "source_changed"; baselineDigest: string; currentDigest: string }
  | { code: "source_unavailable"; problem: "missing" | LegacySourceProblem }
  | { code: "repo_unresolved"; reason: RepoUnresolvedReason };

export interface LegacySourceCopy {
  location: LegacySourceLocation;
  digest: string;
  reflectionId: string | null;
  repo: string | null;
  pattern: string;
  created: string;
  /** The lesson's own text, shown so the two copies can be compared. */
  text: string;
}

export type CuratedProvenance =
  | { kind: "capture"; source: CaptureSource }
  | {
      kind: "existing_lesson";
      state: "available";
      location: "active" | "archive" | "both";
      digest: string;
      reflectionId: string | null;
      repo: string | null;
      pattern: string;
      created: string;
    }
  | { kind: "existing_lesson"; state: "conflict"; copies: LegacySourceCopy[] }
  | {
      kind: "existing_lesson";
      state: "unavailable";
      problem: "missing" | LegacySourceProblem;
      /** The baseline the annotation kept. Never a reflection or session id guessed from the key. */
      retainedDigest: string | null;
    }
  | { kind: "purged" };

export interface CuratedLessonDetail {
  /** Same shape the editor already uses. */
  lesson: LessonView;
  provenance: CuratedProvenance;
  diagnostics: CurationDiagnostic[];
}

/** A browse page plus the source files that could not be read for it. */
export interface CurationBrowsePage extends CurationPage<LessonView> {
  /** As many problems as fit the diagnostic budget, in scan order. */
  sourceProblems: LegacySourceFileProblem[];
  /** Every problem found. Larger than sourceProblems.length when the list was cut. */
  sourceProblemsTotal: number;
}

export type ProjectChoiceOrigin = "configured" | "source" | "stored";

export interface ProjectChoice {
  scope: LessonScope;
  label: string;
  /** Canonical root when known on this machine. null for world-wide, unresolved and unavailable projects. */
  root: string | null;
  available: boolean;
  origins: ProjectChoiceOrigin[];
}

/** A validated project root a later save must revalidate, never reverse from its hash. */
export interface ProjectDescriptor {
  world: string;
  projectId: string;
  root: string;
}

export type CurationContext =
  | {
      state: "resolved";
      scope: LessonScope;
      project: ProjectDescriptor;
      /** catch_all: the world was inferred as the fallback and a capture must confirm it. */
      worldMatch: "configured" | "catch_all";
      requiresConfirmation: boolean;
    }
  | {
      state: "choice_required";
      reason: "outside_world" | "no_project_root" | "ambiguous_root";
      choices: ProjectChoice[];
    };
