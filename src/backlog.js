/**
 * The backlog (issue #9): a list of channels the migrator works through slowly, on
 * its own. It never copies anything itself. It decides what goes into the queue
 * next, and when:
 *  - channels are listed lazily, one at a time, when there is nothing else to feed;
 *  - at most `maxConcurrent` backlog items are in the queue at once, at a lower
 *    priority than manual (and service) work, so they only fill idle time;
 *  - pacing: a rolling 24 h cap on bytes copied, an optional UTC hours window, pause;
 *  - unattended failures: errors that may pass are tried again hours later (BACKLOG_RETRY_MS),
 *    verification failures stay failed for a person, and FAIL_STREAK_PAUSE failures
 *    in a row pause the backlog so a dead gateway doesn't burn through the list.
 * State lives in the queue's SQLite database, so a restart continues where it stopped.
 */
import { EventEmitter } from 'node:events';
import { HIVE_USER_RE, parseHours } from './config.js';
import { PRIORITY } from './queue.js';
import { STORAGE } from './catalog.js';
import { STORAGE_STATE } from './playerContract.js';

const HOUR = 3_600_000;
export const BACKLOG_RETRY_MS = Object.freeze([6 * HOUR, 24 * HOUR]);
export const FAIL_STREAK_PAUSE = 5;
export const MAX_CHANNELS_PER_ADD = 2000;
const DAY = 24 * HOUR;

export const CHANNEL = Object.freeze({ PENDING: 'pending', MIGRATING: 'migrating', DONE: 'done', REMOVED: 'removed' });
export const VIDEO = Object.freeze({
  PENDING: 'pending', QUEUED: 'queued', DONE: 'done', PRESENT: 'present', SKIPPED: 'skipped', FAILED: 'failed',
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS backlog_channels (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL UNIQUE,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  status TEXT NOT NULL,            -- pending | migrating | done | removed
  job_id INTEGER,                  -- the queue job this channel's items go into
  error TEXT,                      -- last listing error
  listed_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS backlog_videos (
  id INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES backlog_channels(id),
  collection TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  cid TEXT,
  permlink TEXT,
  title TEXT,
  size INTEGER,                    -- from the Mongo document, when it has one
  status TEXT NOT NULL,            -- pending | queued | done | present | skipped | failed
  reason TEXT,
  item_id INTEGER,                 -- the queue item while queued (and the last one after)
  rounds INTEGER NOT NULL DEFAULT 0,      -- later retries used (BACKLOG_RETRY_MS)
  not_before INTEGER NOT NULL DEFAULT 0,  -- ms epoch
  bytes INTEGER,                   -- copied, once done
  finished_at INTEGER,             -- ms epoch, once done (the 24 h cap counts these)
  updated_at TEXT NOT NULL,
  UNIQUE (collection, doc_id)
);
CREATE INDEX IF NOT EXISTS backlog_videos_next ON backlog_videos(status, not_before, channel_id, id);
CREATE INDEX IF NOT EXISTS backlog_videos_item ON backlog_videos(item_id);
CREATE INDEX IF NOT EXISTS backlog_videos_done ON backlog_videos(finished_at);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`;

const FINISHED = new Set(['done', 'failed', 'cancelled']);

const inWindow = ({ start, end }, hour) => (start < end ? hour >= start && hour < end : hour >= start || hour < end);

/** The next time (ms) the window opens after `t`. */
function nextOpen({ start }, t) {
  const d = new Date(t);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(start);
  if (d.getTime() <= t) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
}

/** Usernames from pasted text or an array: lower-cased, `@` dropped, de-duplicated in order. */
export function parseChannels(input) {
  const parts = Array.isArray(input) ? input : String(input ?? '').split(/[\s,;]+/);
  return [...new Set(parts.map((p) => String(p).trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
}

export { parseHours };

export class Backlog extends EventEmitter {
  /**
   * opts:
   *  - queue: the Queue (its db holds the backlog tables; its events settle items)
   *  - list(channel) → rows as catalog.listChannel returns them
   *  - plan({ collection, id }) → one entry of dryRun.planItems
   *  - maxActive: backlog items allowed in the queue at once (MAX_CONCURRENT)
   *  - dailyBytes (0 = no cap), hours ({start,end} | null), minAgeDays, diskBudgetBytes
   */
  constructor({ queue, list, plan, maxActive = 1, dailyBytes = 0, hours = null, minAgeDays = 7, diskBudgetBytes = Infinity,
    now = () => Date.now(), retryMs = BACKLOG_RETRY_MS, tickMs = 30_000, log = console }) {
    super();
    this.queue = queue;
    this.db = queue.db;
    this.db.exec(SCHEMA);
    this.list = list;
    this.plan = plan;
    this.maxActive = maxActive;
    this.dailyBytes = dailyBytes;
    this.hours = hours;
    this.minAgeDays = minAgeDays;
    this.diskBudgetBytes = diskBudgetBytes;
    this.now = now;
    this.retryMs = retryMs;
    this.tickMs = tickMs;
    this.log = log;
    this.feeding = null;
    this.again = false;
    this.stopped = true;
    this.onItem = (row) => { if (this.settle(row)) this.kick(); };
  }

  iso(t = this.now()) { return new Date(t).toISOString(); }

  // ------------------------------------------------------------ settings

  setting(key, fallback = null) {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return r ? JSON.parse(r.value) : fallback;
  }

  setSetting(key, value) {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  // ------------------------------------------------------------ lifecycle

  /** Boot: settle items that finished while we weren't listening, then start feeding. */
  start() {
    const queued = this.db.prepare(`SELECT * FROM backlog_videos WHERE status = '${VIDEO.QUEUED}'`).all();
    let caught = 0;
    for (const v of queued) {
      const item = v.item_id ? this.queue.item(v.item_id) : null;
      if (!item) { this.setVideo(v.id, { status: VIDEO.PENDING, item_id: null, reason: 'its queue item was lost; queued again' }); caught++; }
      else if (FINISHED.has(item.status) && this.settle(item)) caught++;
    }
    for (const { id } of this.db.prepare(`SELECT id FROM backlog_channels WHERE status = '${CHANNEL.MIGRATING}'`).all()) this.finishChannel(id);
    this.queue.on('item', this.onItem);
    this.stopped = false;
    this.timer = setInterval(() => this.kick(), this.tickMs);
    this.timer.unref?.();
    this.kick();
    return { caught };
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.queue.off('item', this.onItem);
    await this.feeding;
  }

  /** Feed soon (never inside a queue event handler, which may be mid-update). */
  kick() {
    if (this.stopped) return;
    setImmediate(() => { this.feed().catch((e) => this.log.error('[backlog] feed', e)); });
  }

  // ------------------------------------------------------------ channels

  /** Add usernames. → { added: [names], skipped: [{ channel, reason }] } */
  add(input, by) {
    if (!by) throw new Error('by is required');
    const names = parseChannels(input);
    if (!names.length) throw new TypeError('no usernames');
    if (names.length > MAX_CHANNELS_PER_ADD) throw new TypeError(`at most ${MAX_CHANNELS_PER_ADD} channels at once`);
    const added = [];
    const skipped = [];
    const at = this.iso();
    this.db.transaction(() => {
      for (const name of names) {
        if (!HIVE_USER_RE.test(name)) { skipped.push({ channel: name, reason: 'not a Hive account name' }); continue; }
        const row = this.db.prepare('SELECT * FROM backlog_channels WHERE channel = ?').get(name);
        if (row && [CHANNEL.PENDING, CHANNEL.MIGRATING].includes(row.status)) {
          skipped.push({ channel: name, reason: `already in the backlog (${row.status})` });
          continue;
        }
        if (row) {
          // Done or removed before: list it again, which picks up newer videos.
          this.db.prepare(`UPDATE backlog_channels SET status = ?, added_by = ?, added_at = ?, error = NULL, finished_at = NULL, updated_at = ? WHERE id = ?`)
            .run(CHANNEL.PENDING, by, at, at, row.id);
        } else {
          this.db.prepare(`INSERT INTO backlog_channels (channel, added_by, added_at, status, updated_at) VALUES (?, ?, ?, ?, ?)`)
            .run(name, by, at, CHANNEL.PENDING, at);
        }
        added.push(name);
      }
    })();
    if (added.length) { this.changed(); this.kick(); }
    return { added, skipped };
  }

  /** Stop feeding a channel; its waiting videos are skipped and its queued items cancelled. */
  remove(channelId) {
    const ch = this.channelRow(channelId);
    if (!ch) return null;
    const queued = this.db.prepare(`SELECT item_id FROM backlog_videos WHERE channel_id = ? AND status = '${VIDEO.QUEUED}'`).all(channelId);
    this.db.transaction(() => {
      this.db.prepare(`UPDATE backlog_channels SET status = ?, finished_at = ?, updated_at = ? WHERE id = ?`).run(CHANNEL.REMOVED, this.iso(), this.iso(), channelId);
      this.db.prepare(`UPDATE backlog_videos SET status = ?, reason = 'channel removed from the backlog', updated_at = ? WHERE channel_id = ? AND status = ?`)
        .run(VIDEO.SKIPPED, this.iso(), channelId, VIDEO.PENDING);
    })();
    for (const { item_id: id } of queued) if (id) this.queue.cancelItem(id);
    this.changed();
    return this.channelRow(channelId);
  }

  /** Failed videos of a channel go back to waiting, with their later retries reset. */
  retry(channelId) {
    const ch = this.channelRow(channelId);
    if (!ch) return null;
    if (ch.status === CHANNEL.REMOVED) throw new TypeError('the channel was removed; add it again instead');
    const n = this.db.transaction(() => {
      const r = this.db.prepare(`UPDATE backlog_videos SET status = ?, rounds = 0, not_before = 0, reason = NULL, updated_at = ? WHERE channel_id = ? AND status = ?`)
        .run(VIDEO.PENDING, this.iso(), channelId, VIDEO.FAILED);
      if (r.changes && ch.status === CHANNEL.DONE) {
        this.db.prepare(`UPDATE backlog_channels SET status = ?, finished_at = NULL, updated_at = ? WHERE id = ?`).run(CHANNEL.MIGRATING, this.iso(), channelId);
      }
      return r.changes;
    })();
    if (n) { this.changed(); this.kick(); }
    return { retried: n };
  }

  pause(reason, by = null) {
    this.setSetting('paused', { reason: reason ?? 'paused', by, at: this.iso() });
    this.changed();
  }

  resume() {
    this.setSetting('paused', null);
    this.setSetting('failStreak', 0);
    this.changed();
    this.kick();
  }

  channelRow(id) { return this.db.prepare('SELECT * FROM backlog_channels WHERE id = ?').get(Number(id)); }

  /** Rows of a listed channel → backlog_videos (done rows are kept as they are). */
  record(ch, rows) {
    const now = this.now();
    const minAgeMs = this.minAgeDays * DAY;
    const at = this.iso(now);
    const insert = this.db.prepare(`INSERT OR IGNORE INTO backlog_videos (channel_id, collection, doc_id, cid, permlink, title, size, status, reason, updated_at)
      VALUES (@channel_id, @collection, @doc_id, @cid, @permlink, @title, @size, @status, @reason, @at)`);
    this.db.transaction(() => {
      // Listed again: start over, except what is copied or in the queue right now.
      this.db.prepare(`DELETE FROM backlog_videos WHERE channel_id = ? AND status NOT IN ('${VIDEO.DONE}', '${VIDEO.QUEUED}')`).run(ch.id);
      for (const r of rows) {
        const created = r.created ? new Date(r.created).getTime() : NaN;
        let status = VIDEO.PENDING;
        let reason = null;
        if (r.storage === STORAGE.ARCHIVED || r.storage === STORAGE.HOT) { status = VIDEO.PRESENT; reason = 'already in S3'; }
        else if (!r.eligible) { status = VIDEO.SKIPPED; reason = r.reason; }
        else if (Number.isFinite(created) && now - created < minAgeMs) {
          status = VIDEO.SKIPPED;
          reason = `uploaded less than ${this.minAgeDays} days ago; the hotnode copies it`;
        } else if (r.size && r.size > this.diskBudgetBytes) { status = VIDEO.SKIPPED; reason = 'bigger than the disk budget (DISK_BUDGET_GB)'; }
        insert.run({ channel_id: ch.id, collection: r.collection, doc_id: String(r.id), cid: r.cid ?? null, permlink: r.permlink ?? null,
          title: r.title ?? null, size: r.size ?? null, status, reason, at });
      }
      this.db.prepare(`UPDATE backlog_channels SET status = ?, listed_at = ?, error = NULL, updated_at = ? WHERE id = ?`).run(CHANNEL.MIGRATING, at, at, ch.id);
    })();
    this.finishChannel(ch.id);
  }

  /** A listed channel is done once nothing of it waits or runs. */
  finishChannel(id) {
    const open = this.db.prepare(`SELECT COUNT(*) AS n FROM backlog_videos WHERE channel_id = ? AND status IN ('${VIDEO.PENDING}', '${VIDEO.QUEUED}')`).get(id).n;
    if (open) return false;
    this.db.prepare(`UPDATE backlog_channels SET status = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = ?`)
      .run(CHANNEL.DONE, this.iso(), this.iso(), id, CHANNEL.MIGRATING);
    return true;
  }

  setVideo(id, fields) {
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE backlog_videos SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @updated_at WHERE id = @id`)
      .run({ ...fields, updated_at: this.iso(), id });
  }

  // ------------------------------------------------------------ settling

  /** A queue item changed. Records the outcome of ours once it has finished. → true if it was ours. */
  settle(row) {
    if (!row || !FINISHED.has(row.status)) return false;
    const v = this.db.prepare(`SELECT * FROM backlog_videos WHERE item_id = ? AND status = ?`).get(row.id, VIDEO.QUEUED);
    if (!v) return false;
    const now = this.now();
    let streak = this.setting('failStreak', 0);
    if (row.status === 'done') {
      this.setVideo(v.id, { status: VIDEO.DONE, reason: null, bytes: row.result?.bytes ?? null, finished_at: now });
      streak = 0;
    } else if (row.status === 'cancelled') {
      this.setVideo(v.id, { status: VIDEO.SKIPPED, reason: 'cancelled' });
    } else if (row.error_kind === 'NotEligibleError') {
      this.setVideo(v.id, { status: VIDEO.SKIPPED, reason: row.error });
    } else {
      streak += 1;
      const later = row.error_kind !== 'VerifyError' && v.rounds < this.retryMs.length;
      if (later) {
        const at = now + this.retryMs[v.rounds];
        this.setVideo(v.id, { status: VIDEO.PENDING, rounds: v.rounds + 1, not_before: at, reason: `${row.error}; trying again after ${this.iso(at)}` });
      } else {
        this.setVideo(v.id, { status: VIDEO.FAILED, reason: row.error });
      }
      if (streak >= FAIL_STREAK_PAUSE && !this.setting('paused')) {
        this.pause(`${streak} videos failed in a row; the last one: ${row.error}`);
        this.log.warn?.(`[backlog] paused after ${streak} failures in a row`);
      }
    }
    this.setSetting('failStreak', streak);
    this.finishChannel(v.channel_id);
    this.changed();
    return true;
  }

  // ------------------------------------------------------------ feeding

  copiedSince(t) {
    return this.db.prepare(`SELECT COUNT(*) AS videos, COALESCE(SUM(bytes), 0) AS bytes, MIN(finished_at) AS oldest
      FROM backlog_videos WHERE status = '${VIDEO.DONE}' AND finished_at > ?`).get(t);
  }

  /** Why nothing new starts now → { state: 'paused' | 'waiting', reason, until? }, or null. */
  holdReason(now = this.now()) {
    const paused = this.setting('paused');
    if (paused) return { state: 'paused', reason: paused.reason, by: paused.by, since: paused.at };
    if (this.hours && !inWindow(this.hours, new Date(now).getUTCHours())) {
      return { state: 'waiting', reason: `outside the hours window (${this.hours.start}–${this.hours.end} UTC)`, until: this.iso(nextOpen(this.hours, now)) };
    }
    if (this.dailyBytes) {
      const day = this.copiedSince(now - DAY);
      if (day.bytes >= this.dailyBytes) {
        return { state: 'waiting', reason: 'the daily cap (BACKLOG_DAILY_GB) is reached', until: this.iso(day.oldest + DAY) };
      }
    }
    return null;
  }

  activeCount() {
    return this.db.prepare(`SELECT COUNT(*) AS n FROM items WHERE priority = ? AND status IN ('queued', 'running')`).get(PRIORITY.BACKLOG).n;
  }

  /** Fill the free backlog slots. One run at a time; a kick during a run runs again after it. */
  async feed() {
    if (this.feeding) { this.again = true; return this.feeding; }
    this.feeding = (async () => {
      try {
        do {
          this.again = false;
          while (!this.stopped && await this.feedOne()) { /* keep going */ }
        } while (this.again && !this.stopped);
      } finally {
        this.feeding = null;
      }
    })();
    return this.feeding;
  }

  /** One step: list a channel or queue one video. → true if something happened. */
  async feedOne() {
    if (this.holdReason() || this.activeCount() >= this.maxActive) return false;
    const v = this.db.prepare(`SELECT v.*, c.channel, c.added_by, c.job_id FROM backlog_videos v JOIN backlog_channels c ON c.id = v.channel_id
      WHERE v.status = ? AND v.not_before <= ? AND c.status = ? ORDER BY c.id, v.id LIMIT 1`).get(VIDEO.PENDING, this.now(), CHANNEL.MIGRATING);
    if (!v) return this.listNext();

    let p;
    try {
      p = await this.plan({ collection: v.collection, id: v.doc_id });
    } catch (e) {
      this.log.error?.(`[backlog] planning ${v.channel}/${v.permlink ?? v.doc_id}`, e);
      this.setVideo(v.id, { not_before: this.now() + 10 * 60_000, reason: `could not plan it: ${e.message}; trying again in 10 minutes` });
      this.changed();
      return true;
    }
    if (this.stopped || this.setting('paused')) return false;
    // Removed or paused while we were planning.
    const fresh = this.db.prepare('SELECT status FROM backlog_videos WHERE id = ?').get(v.id);
    if (fresh?.status !== VIDEO.PENDING) return true;
    if (!p.eligible) {
      const present = /already (archived|has an S3 copy)/.test(p.reason ?? '');
      this.setVideo(v.id, { status: present ? VIDEO.PRESENT : VIDEO.SKIPPED, reason: present ? 'already in S3' : p.reason });
      this.finishChannel(v.channel_id);
      this.changed();
      return true;
    }
    const r = this.queue.enqueue({
      by: v.added_by, channel: v.channel, mode: STORAGE_STATE.ARCHIVED, priority: PRIORITY.BACKLOG, jobId: v.job_id ?? null,
      items: [{ collection: p.collection, docId: p.id, owner: p.owner, permlink: p.permlink, title: p.title, cid: p.cid }],
    });
    if (!v.job_id) this.db.prepare('UPDATE backlog_channels SET job_id = ?, updated_at = ? WHERE id = ?').run(r.jobId, this.iso(), v.channel_id);
    if (r.added.length) this.setVideo(v.id, { status: VIDEO.QUEUED, item_id: r.added[0], reason: null });
    else this.setVideo(v.id, { status: VIDEO.SKIPPED, reason: r.skipped[0]?.reason ?? 'not queued' });
    this.finishChannel(v.channel_id);
    this.changed();
    return true;
  }

  /** List the next waiting channel. → true if one was listed. */
  async listNext() {
    const ch = this.db.prepare(`SELECT * FROM backlog_channels WHERE status = ? ORDER BY id LIMIT 1`).get(CHANNEL.PENDING);
    if (!ch) return false;
    let rows;
    try {
      rows = await this.list(ch.channel);
    } catch (e) {
      this.db.prepare('UPDATE backlog_channels SET error = ?, updated_at = ? WHERE id = ?').run(`could not list it: ${e.message}`, this.iso(), ch.id);
      this.changed();
      return false;   // Mongo is probably down: try again on the next tick, not in a loop
    }
    const still = this.channelRow(ch.id);
    if (still?.status !== CHANNEL.PENDING) return true;
    this.record(ch, rows);
    this.changed();
    return true;
  }

  // ------------------------------------------------------------ reading

  changed() { this.emit('change'); }

  state() {
    const now = this.now();
    const counts = this.db.prepare(`SELECT channel_id, status, COUNT(*) AS n, COALESCE(SUM(size), 0) AS size, COALESCE(SUM(bytes), 0) AS bytes
      FROM backlog_videos GROUP BY channel_id, status`).all();
    const by = new Map();
    const blank = () => ({ pending: 0, queued: 0, done: 0, present: 0, skipped: 0, failed: 0, toCopyBytes: 0, copiedBytes: 0 });
    const totals = blank();
    for (const c of counts) {
      const t = by.get(c.channel_id) ?? blank();
      for (const x of [t, totals]) {
        x[c.status] += c.n;
        if (c.status === VIDEO.PENDING || c.status === VIDEO.QUEUED) x.toCopyBytes += c.size;
        if (c.status === VIDEO.DONE) x.copiedBytes += c.bytes;
      }
      by.set(c.channel_id, t);
    }
    const channels = this.db.prepare('SELECT * FROM backlog_channels ORDER BY id').all().map((c) => ({
      id: c.id, channel: c.channel, addedBy: c.added_by, addedAt: c.added_at, status: c.status, error: c.error,
      listedAt: c.listed_at, finishedAt: c.finished_at, jobId: c.job_id, ...(by.get(c.id) ?? blank()),
    }));
    const day = this.copiedSince(now - DAY);
    const hold = this.holdReason(now);
    return {
      state: hold?.state ?? (this.activeCount() || channels.some((c) => [CHANNEL.PENDING, CHANNEL.MIGRATING].includes(c.status)) ? 'running' : 'idle'),
      hold,
      pacing: { dailyBytes: this.dailyBytes, hours: this.hours, minAgeDays: this.minAgeDays, maxActive: this.maxActive },
      last24h: { videos: day.videos, bytes: day.bytes },
      failStreak: this.setting('failStreak', 0),
      totals: { channels: channels.length, ...totals },
      channels,
    };
  }

  channel(id) {
    const c = this.state().channels.find((x) => x.id === Number(id));
    if (!c) return null;
    const videos = this.db.prepare(`SELECT id, collection, doc_id AS docId, cid, permlink, title, size, status, reason, item_id AS itemId,
      rounds, not_before AS notBefore, bytes, finished_at AS finishedAt FROM backlog_videos WHERE channel_id = ? ORDER BY id`).all(c.id);
    return { ...c, videos };
  }
}
