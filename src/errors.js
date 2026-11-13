/**
 * Error kinds the queue treats differently (SPEC §7):
 *  - VerifyError: the data is wrong (bad hash, missing block, S3 mismatch). Never
 *    retried automatically: a human looks at it.
 *  - OutOfSpaceError: the disk budget would be exceeded. Not retried; the item fails
 *    with that reason and nothing is left on disk.
 *  - ChangedError: the Mongo document changed while we worked. Not retried.
 *  - NotEligibleError: the video can't (or no longer can) be migrated. Not retried.
 *  - CancelledError: someone pressed cancel.
 * Anything else (network, timeouts, 5xx) is retried with backoff.
 *
 * Each error also has a `code`, the machine-readable reason the hotnode receives
 * (issue #8, ERROR_CODES). A VerifyError is `bad_car` unless the throw site says
 * which S3 check failed.
 */
export class VerifyError extends Error {
  constructor(message, { code = 'bad_car' } = {}) { super(message); this.name = 'VerifyError'; this.code = code; }
}

export class OutOfSpaceError extends Error {
  constructor(message) { super(message); this.name = 'OutOfSpaceError'; this.code = 'out_of_space'; }
}

export class ChangedError extends Error {
  constructor(message) { super(message); this.name = 'ChangedError'; this.code = 'changed_during_migration'; }
}

export class NotEligibleError extends Error {
  constructor(message) { super(message); this.name = 'NotEligibleError'; this.code = 'not_eligible'; }
}

export class CancelledError extends Error {
  constructor(message = 'cancelled') { super(message); this.name = 'CancelledError'; this.code = 'cancelled'; }
}

/**
 * Failure codes sent to the hotnode, and whether asking again may help. The queue
 * has already retried its own way by the time the hotnode hears of a failure.
 */
export const ERROR_CODES = Object.freeze({
  download_failed: { retryable: true },
  out_of_space: { retryable: true },
  upload_failed: { retryable: true },
  s3_check_failed: { retryable: true },
  readback_failed: { retryable: true },
  changed_during_migration: { retryable: true },
  mongo_failed: { retryable: true },
  internal: { retryable: true },
  bad_car: { retryable: false },
  not_eligible: { retryable: false },
  cancelled: { retryable: false },
});

// An error without its own code (network, timeouts, 5xx) is named after the stage it failed in.
const STAGE_CODE = Object.freeze({
  resolve: 'mongo_failed', download: 'download_failed', verify: 'download_failed',
  upload: 'upload_failed', check: 's3_check_failed', mongo: 'mongo_failed',
});

/** The code of a failed queue item: the one stored with it, else from its stage. */
export function codeOf({ error_code: code, stage }) {
  if (code && ERROR_CODES[code]) return code;
  return STAGE_CODE[stage] ?? 'internal';
}

export const isRetryable = (err) =>
  !(err instanceof VerifyError || err instanceof OutOfSpaceError || err instanceof ChangedError
    || err instanceof NotEligibleError || err instanceof CancelledError);

export function throwIfAborted(signal) {
  if (signal?.aborted) throw new CancelledError();
}
