/**
 * One download rate limit shared by every running item (DOWNLOAD_RATE_LIMIT_MBPS),
 * so a migration can't take the bandwidth the server needs to serve viewers.
 * A token bucket holding at most one second of tokens. 0 = unlimited.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { CancelledError } from './errors.js';

export class Throttle {
  constructor(bytesPerSec, { now = () => Date.now() } = {}) {
    this.rate = bytesPerSec;
    this.now = now;
    this.tokens = bytesPerSec;
    this.last = now();
  }

  async take(n, signal) {
    if (!this.rate) return;
    for (;;) {
      const t = this.now();
      this.tokens = Math.min(this.rate, this.tokens + ((t - this.last) / 1000) * this.rate);
      this.last = t;
      // A chunk bigger than the bucket would wait forever; let it go into debt instead.
      if (this.tokens >= Math.min(n, this.rate)) { this.tokens -= n; return; }
      const waitMs = Math.ceil(((Math.min(n, this.rate) - this.tokens) / this.rate) * 1000);
      try { await sleep(Math.max(waitMs, 5), undefined, { signal }); } catch (_) { throw new CancelledError(); }
    }
  }
}
