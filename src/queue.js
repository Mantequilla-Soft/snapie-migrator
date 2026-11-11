/**
 * The job queue (SPEC §7). State lives in SQLite so a pm2 restart (or a crash)
 * picks up where it stopped:
 *  - at most `maxConcurrent` items run at once (hard limit 2), never two with the
 *    same CID (they would download the same thing twice);
 *  - network-type failures go back in the queue with backoff, up to MAX_ATTEMPTS;
 *    verification / eligibility / change / disk failures stop for a human;
 *  - cancelling a running item stops it at the next stage boundary (never during
 *    the Mongo update);
 *  - on boot, items that were running go back to queued and WORK_DIR is emptied of
 *    leftover CARs. Uploads skip objects already in S3, so a restart only repeats
 *    the download and the checks.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CancelledError, isRetryable } from './errors.js';
import { STAGES } from './pipeline.js';

export const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = Object.freeze([30_000, 120_000, 600_000]);
export const ACTIVE = Object.freeze(['queued', 'running']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  channel TEXT,
  mode TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'migrate'
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  collection TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  owner TEXT,
  permlink TEXT,
  title TEXT,
  cid TEXT,
  mode TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'migrate',   -- migrate | check | revert
  by TEXT NOT NULL,
  status TEXT NOT NULL,            -- queued | running | done | failed | cancelled
  stage TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before INTEGER NOT NULL DEFAULT 0,
  progress TEXT,
  error TEXT,
  error_kind TEXT,
  result TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS items_status ON items(status, not_before, id);
CREATE INDEX IF NOT EXISTS items_doc ON items(collection, doc_id);
CREATE INDEX IF NOT EXISTS items_job ON items(job_id);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id),
  at TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_item ON events(item_id, id);
`;

const parse = (s) => (s ? JSON.parse(s) : null);
const rowOut = (r) => r && ({ ...r, progress: parse(r.progress), result: parse(r.result) });

export class Queue extends EventEmitter {
  /**
   * opts: { dbPath, workDir, maxConcurrent, deps, run, now, backoffMs, progressWriteMs }
   * `run(item, deps, { signal, onProgress })` is the pipeline (runItem).
   */
  constructor({ dbPath, workDir, maxConcurrent, deps, run, now = () => Date.now(), backoffMs = BACKOFF_MS, progressWriteMs = 1000 }) {
    super();
    if (!(maxConcurrent >= 1 && maxConcurrent <= 2)) throw new Error('maxConcurrent must be 1 or 2');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.workDir = workDir;
    this.maxConcurrent = maxConcurrent;
    this.deps = deps;
    this.run = run;
    this.now = now;
    this.backoffMs = backoffMs;
    this.progressWriteMs = progressWriteMs;
    this.running = new Map();   // item id → { ctrl, cid, promise }
    this.stopped = true;
    this.timer = null;
  }

  iso() { return new Date(this.now()).toISOString(); }

  event(itemId, level, message) {
    this.db.prepare('INSERT INTO events (item_id, at, level, message) VALUES (?, ?, ?, ?)').run(itemId, this.iso(), level, message);
  }

  update(id, fields) {
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE items SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @updated_at WHERE id = @id`)
      .run({ ...fields, updated_at: this.iso(), id });
    const row = this.item(id);
    this.emit('item', row);
    return row;
  }

  /** Boot: running → queued (we were interrupted), leftover CARs deleted, start the loop. */
  start() {
    const stale = this.db.prepare("SELECT id FROM items WHERE status = 'running'").all();
    for (const { id } of stale) {
      this.event(id, 'warn', 'interrupted by a restart; queued again');
      this.update(id, { status: 'queued', stage: null, progress: null, not_before: 0 });
    }
    for (const f of fs.readdirSync(this.workDir)) {
      if (/^item-\d+\.car$/.test(f)) fs.rmSync(path.join(this.workDir, f), { force: true });
    }
    this.stopped = false;
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref?.();
    this.tick();
    return { requeued: stale.length };
  }

  /**
   * Shutdown: stop taking work, abort what runs and put it back in the queue so the
   * next start resumes it. Waits for the items to finish their cleanup.
   */
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const r of this.running.values()) { r.requeue = true; r.ctrl.abort(); }
    await Promise.allSettled([...this.running.values()].map((r) => r.promise));
    this.db.close();
  }

  /**
   * Add a job. Items already queued or running are left out (reported in `skipped`).
   * items: [{ collection, docId, owner, permlink, title, cid }]
   */
  enqueue({ by, channel = null, mode = 'archived', kind = 'migrate', items }) {
    if (!by) throw new Error('by is required');
    if (!['migrate', 'check', 'revert'].includes(kind)) throw new Error(`unknown kind ${kind}`);
    if (!Array.isArray(items) || !items.length) throw new Error('no items');
    const active = this.db.prepare(`SELECT id FROM items WHERE collection = ? AND doc_id = ? AND status IN ('queued', 'running')`);
    const insert = this.db.prepare(`INSERT INTO items (job_id, collection, doc_id, owner, permlink, title, cid, mode, kind, by, status, created_at, updated_at)
      VALUES (@job_id, @collection, @doc_id, @owner, @permlink, @title, @cid, @mode, @kind, @by, 'queued', @at, @at)`);
    const result = this.db.transaction(() => {
      const at = this.iso();
      const jobId = Number(this.db.prepare('INSERT INTO jobs (created_at, created_by, channel, mode, kind) VALUES (?, ?, ?, ?, ?)').run(at, by, channel, mode, kind).lastInsertRowid);
      const added = [];
      const skipped = [];
      for (const it of items) {
        const docId = String(it.docId);
        const dup = active.get(it.collection, docId);
        if (dup) { skipped.push({ ...it, reason: `already in the queue (item ${dup.id})` }); continue; }
        const id = Number(insert.run({
          job_id: jobId, collection: it.collection, doc_id: docId, owner: it.owner ?? null, permlink: it.permlink ?? null,
          title: it.title ?? null, cid: it.cid ?? null, mode, kind, by, at,
        }).lastInsertRowid);
        added.push(id);
      }
      return { jobId, added, skipped };
    })();
    for (const id of result.added) this.event(id, 'info', `${kind} queued by ${by}`);
    this.tick();
    return result;
  }

  tick() {
    if (this.stopped) return;
    while (this.running.size < this.maxConcurrent) {
      const busy = [...this.running.values()].map((r) => r.cid).filter(Boolean);
      const next = this.db.prepare(`SELECT * FROM items WHERE status = 'queued' AND not_before <= ?
        ${busy.length ? `AND (cid IS NULL OR cid NOT IN (${busy.map(() => '?').join(',')}))` : ''} ORDER BY id LIMIT 1`)
        .get(this.now(), ...busy);
      if (!next) return;
      this.startItem(next);
    }
  }

  startItem(row) {
    const ctrl = new AbortController();
    const entry = { ctrl, cid: row.cid, requeue: false, promise: null };
    this.running.set(row.id, entry);
    this.update(row.id, { status: 'running', attempts: row.attempts + 1, started_at: this.iso(), stage: STAGES[0], error: null, error_kind: null });
    this.event(row.id, 'info', `attempt ${row.attempts + 1} started`);

    let lastWrite = 0;
    let lastStage = null;
    const onProgress = (p) => {
      this.emit('progress', { itemId: row.id, jobId: row.job_id, ...p });
      const t = this.now();
      if (p.stage !== lastStage || t - lastWrite >= this.progressWriteMs) {
        if (p.stage !== lastStage) this.event(row.id, 'info', `stage ${p.stage}`);
        lastStage = p.stage;
        lastWrite = t;
        this.db.prepare('UPDATE items SET stage = ?, progress = ?, cid = COALESCE(?, cid), updated_at = ? WHERE id = ?')
          .run(p.stage, JSON.stringify(p), p.cid ?? null, this.iso(), row.id);
      }
    };

    const item = { id: row.id, collection: row.collection, docId: row.doc_id, mode: row.mode, kind: row.kind, by: row.by };
    entry.promise = (async () => {
      try {
        const result = await this.run(item, this.deps, { signal: ctrl.signal, onProgress });
        this.update(row.id, { status: 'done', stage: 'done', result: JSON.stringify(result), finished_at: this.iso(), cid: result.cid ?? row.cid });
        const warn = result.warnings?.length ? ` with ${result.warnings.length} warning(s)` : '';
        this.event(row.id, result.warnings?.length ? 'warn' : 'info', `done${warn}`);
        for (const w of result.warnings ?? []) this.event(row.id, 'warn', w);
      } catch (err) {
        const attempts = row.attempts + 1;
        if (err instanceof CancelledError && entry.requeue) {
          this.update(row.id, { status: 'queued', stage: null, progress: null, attempts: row.attempts });
          this.event(row.id, 'warn', 'stopped by shutdown; queued again');
        } else if (err instanceof CancelledError) {
          this.update(row.id, { status: 'cancelled', finished_at: this.iso(), error: 'cancelled' });
          this.event(row.id, 'warn', 'cancelled');
        } else if (isRetryable(err) && attempts < MAX_ATTEMPTS) {
          const wait = this.backoffMs[Math.min(attempts - 1, this.backoffMs.length - 1)];
          this.update(row.id, { status: 'queued', not_before: this.now() + wait, error: err.message, error_kind: err.name });
          this.event(row.id, 'warn', `${err.message}; retrying in ${Math.round(wait / 1000)}s`);
        } else {
          this.update(row.id, { status: 'failed', finished_at: this.iso(), error: err.message, error_kind: err.name });
          this.event(row.id, 'error', `${err.name}: ${err.message}`);
        }
      } finally {
        this.running.delete(row.id);
        this.tick();
      }
    })();
  }

  cancelItem(id) {
    const row = this.item(id);
    if (!row) return null;
    if (row.status === 'queued') {
      this.event(id, 'warn', 'cancelled while queued');
      return this.update(id, { status: 'cancelled', finished_at: this.iso(), error: 'cancelled' });
    }
    if (row.status === 'running') this.running.get(id)?.ctrl.abort();
    return row;
  }

  cancelJob(jobId) {
    const ids = this.db.prepare(`SELECT id FROM items WHERE job_id = ? AND status IN ('queued', 'running')`).all(jobId).map((r) => r.id);
    for (const id of ids) this.cancelItem(id);
    return ids.length;
  }

  item(id) { return rowOut(this.db.prepare('SELECT * FROM items WHERE id = ?').get(id)); }
  events(itemId) { return this.db.prepare('SELECT at, level, message FROM events WHERE item_id = ? ORDER BY id').all(itemId); }

  jobs({ limit = 50, id = null } = {}) {
    return this.db.prepare(`SELECT j.*,
      SUM(i.status = 'queued') AS queued, SUM(i.status = 'running') AS running, SUM(i.status = 'done') AS done,
      SUM(i.status = 'failed') AS failed, SUM(i.status = 'cancelled') AS cancelled, COUNT(i.id) AS total
      FROM jobs j LEFT JOIN items i ON i.job_id = j.id ${id === null ? '' : 'WHERE j.id = @id'}
      GROUP BY j.id ORDER BY j.id DESC LIMIT @limit`).all({ limit, ...(id === null ? {} : { id }) });
  }

  job(id) {
    const [job] = this.jobs({ id, limit: 1 });
    if (!job) return null;
    return { ...job, items: this.db.prepare('SELECT * FROM items WHERE job_id = ? ORDER BY id').all(id).map(rowOut) };
  }

  /** The latest item for each of these docs (for the channel table). */
  latestFor(collection, docIds) {
    if (!docIds.length) return new Map();
    const rows = this.db.prepare(`SELECT * FROM items WHERE collection = ? AND doc_id IN (${docIds.map(() => '?').join(',')}) ORDER BY id`)
      .all(collection, ...docIds.map(String));
    return new Map(rows.map((r) => [r.doc_id, rowOut(r)]));
  }
}
