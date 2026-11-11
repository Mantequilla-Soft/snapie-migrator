/**
 * Disk budget (SPEC §3 step 2). Everything the migrator writes goes through one
 * DiskBudget, shared by all running items:
 *  - at most `budgetBytes` in WORK_DIR across all items, and
 *  - never leave less than `reserveBytes` free on the filesystem, so the server's
 *    own services (the hotnode, IPFS) keep room to work.
 * A write that would break either rule throws OutOfSpaceError before it happens.
 */
import fs from 'node:fs';
import { OutOfSpaceError } from './errors.js';

// statfs costs a syscall; ask again after this many bytes (or sooner if close to the edge).
const STATFS_EVERY = 64 * 1024 * 1024;
// Below this much budget left, a new item is not started.
export const MIN_START_BYTES = 256 * 1024 * 1024;

const gb = (n) => `${(n / 1024 ** 3).toFixed(2)} GB`;

export class DiskBudget {
  constructor({ dir, budgetBytes, reserveBytes, statfs = (p) => fs.promises.statfs(p) }) {
    this.dir = dir;
    this.budgetBytes = budgetBytes;
    this.reserveBytes = reserveBytes;
    this.statfs = statfs;
    this.used = 0;
    this.lastFree = null;
    this.sinceStat = Infinity;
  }

  async free() {
    const s = await this.statfs(this.dir);
    this.lastFree = Number(s.bavail) * Number(s.bsize);
    this.sinceStat = 0;
    return this.lastFree;
  }

  /** Throws unless a new item has room to start. */
  async assertCanStart() {
    const left = this.budgetBytes - this.used;
    if (left < MIN_START_BYTES) throw new OutOfSpaceError(`disk budget nearly used (${gb(this.used)} of ${gb(this.budgetBytes)})`);
    const free = await this.free();
    if (free - this.reserveBytes < MIN_START_BYTES) {
      throw new OutOfSpaceError(`only ${gb(free)} free on disk, ${gb(this.reserveBytes)} must stay free`);
    }
  }

  /** Call before writing `n` bytes. Throws OutOfSpaceError instead of overfilling. */
  async take(n) {
    if (this.used + n > this.budgetBytes) {
      throw new OutOfSpaceError(`disk budget of ${gb(this.budgetBytes)} would be exceeded`);
    }
    const nearEdge = this.lastFree !== null && this.lastFree - this.reserveBytes < 2 * STATFS_EVERY;
    if (this.lastFree === null || this.sinceStat + n >= STATFS_EVERY || nearEdge) await this.free();
    // lastFree was measured before the `sinceStat` bytes written since then.
    if (this.lastFree - this.sinceStat - n < this.reserveBytes) {
      throw new OutOfSpaceError(`writing would leave less than ${gb(this.reserveBytes)} free on disk`);
    }
    this.sinceStat += n;
    this.used += n;
  }

  /** Give back bytes once a file is deleted. */
  release(n) {
    this.used = Math.max(0, this.used - n);
  }

  snapshot() {
    return { used: this.used, budget: this.budgetBytes, reserve: this.reserveBytes, free: this.lastFree };
  }
}
