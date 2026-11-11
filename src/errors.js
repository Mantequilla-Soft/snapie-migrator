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
 */
export class VerifyError extends Error {
  constructor(message) { super(message); this.name = 'VerifyError'; }
}

export class OutOfSpaceError extends Error {
  constructor(message) { super(message); this.name = 'OutOfSpaceError'; }
}

export class ChangedError extends Error {
  constructor(message) { super(message); this.name = 'ChangedError'; }
}

export class NotEligibleError extends Error {
  constructor(message) { super(message); this.name = 'NotEligibleError'; }
}

export class CancelledError extends Error {
  constructor(message = 'cancelled') { super(message); this.name = 'CancelledError'; }
}

export const isRetryable = (err) =>
  !(err instanceof VerifyError || err instanceof OutOfSpaceError || err instanceof ChangedError
    || err instanceof NotEligibleError || err instanceof CancelledError);

export function throwIfAborted(signal) {
  if (signal?.aborted) throw new CancelledError();
}
