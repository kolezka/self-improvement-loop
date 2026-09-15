// One place for every error class the HTTP and CLI boundaries map to a status.

export class ConfigError extends Error {
  override name = "ConfigError";
}

export class ModelNotConfigured extends ConfigError {
  override name = "ModelNotConfigured";
}

export class LocalityViolation extends ConfigError {
  override name = "LocalityViolation";
}

export class ProviderError extends Error {
  override name = "ProviderError";
}

export class ProviderTimeout extends ProviderError {
  override name = "ProviderTimeout";
}

export class GitError extends Error {
  override name = "GitError";
  constructor(message: string, public readonly stderr = "") {
    super(message);
  }
}

export class ReviewError extends Error {
  override name = "ReviewError";
}

export class LockHeld extends Error {
  override name = "LockHeld";
}

// Request-shaped mistakes: bad slug, unknown pattern, stale digest.
export class ValidationError extends Error {
  override name = "ValidationError";
}
