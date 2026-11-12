import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Backlog, FAIL_STREAK_PAUSE, VIDEO, parseChannels, parseHours } from '../src/backlog.js';
import { CancelledError, NotEligibleError, OutOfSpaceError, VerifyError } from '../src/errors.js';
import { PRIORITY, Queue } from '../src/queue.js';

const DAY = 86_400_000;
const flush = () => new Promise((r) => setImmediate(r));

let dir, clock, queue, backlogs, calls, listed, planned, lists;
beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'migrator-b-'));
  clock = Date.UTC(2026, 10, 12, 12, 0, 0);
  calls = [];
  listed = [];
  planned = [];
  backlogs = [];
  lists = {};
});
afterEach(async () => {
  for (const b of backlogs) await b.stop().catch(() => {});
  if (queue?.db.open) await queue.stop().catch(() => {});
  await fs.promises.rm(dir, { recursive: true, force: true });
});

// The pipeline: each call waits until the test resolves or rejects it.
const run = (item, _deps, { signal }) => new Promise((resolve, reject) => {
  calls.push({ item, resolve, reject });
  signal.addEventListener('abort', () => reject(new CancelledError()), { once: true });
});

function makeQueue(over = {}) {
  queue = new Queue({ dbPath: path.join(dir, 'm.db'), workDir: path.join(dir, 'work'), maxConcurrent: 1, deps: {}, run, now: () => clock, backoffMs: [1000], progressWriteMs: 0, ...over });
  queue.start();
  return queue;
}

// A video row as catalog.listChannel returns it.
const video = (id, over = {}) => ({
  collection: 'legacy', id, owner: 'alice', permlink: `p-${id}`, title: `T ${id}`, created: new Date(clock - 30 * DAY).toISOString(),
  size: 1000, storage: 'ipfs', cid: `Qm${id}`, eligible: true, reason: null, ...over,
});

function makeBacklog(over = {}) {
  const b = new Backlog({
    queue,
    list: async (channel) => {
      listed.push(channel);
      if (lists[channel] instanceof Error) throw lists[channel];
      return lists[channel] ?? [];
    },
    plan: async ({ collection, id }) => {
      planned.push(id);
      const v = Object.values(lists).flat().find((x) => x.id === id);
      return v.plan ?? { eligible: true, collection, id, owner: v.owner, permlink: v.permlink, title: v.title, cid: v.cid };
    },
    maxActive: 1, minAgeDays: 7, diskBudgetBytes: 10_000, now: () => clock, retryMs: [1000, 2000], tickMs: 1e9,
    log: { error() {}, warn() {} },
    ...over,
  });
  backlogs.push(b);
  return b;
}

async function settle(b) {
  for (let i = 0; i < 6; i++) { await flush(); await b.feeding; }
}

const videosOf = (b, channel = 'alice') => {
  const c = b.state().channels.find((x) => x.channel === channel);
  return Object.fromEntries(b.channel(c.id).videos.map((v) => [v.docId, v]));
};

describe('parsing', () => {
  it('reads usernames from pasted text', () => {
    expect(parseChannels('@Alice, bob\n\ncarol;alice  dave')).toEqual(['alice', 'bob', 'carol', 'dave']);
    expect(parseChannels(['Bob', '@bob'])).toEqual(['bob']);
  });

  it('reads an hours window in UTC, wrapping past midnight', () => {
    expect(parseHours('')).toBeNull();
    expect(parseHours('01-09')).toEqual({ start: 1, end: 9 });
    expect(parseHours('22-6')).toEqual({ start: 22, end: 6 });
    expect(parseHours('20-24')).toEqual({ start: 20, end: 0 });
    expect(() => parseHours('5')).toThrow();
    expect(() => parseHours('25-3')).toThrow();
    expect(() => parseHours('3-3')).toThrow();
  });
});

describe('Backlog', () => {
  it('adds channels, skipping bad names and ones already waiting', () => {
    makeQueue();
    const b = makeBacklog();
    expect(b.add('alice, @Bob, x', 'meno')).toEqual({ added: ['alice', 'bob'], skipped: [{ channel: 'x', reason: 'not a Hive account name' }] });
    expect(b.add(['alice'], 'tibfox').skipped).toEqual([{ channel: 'alice', reason: 'already in the backlog (pending)' }]);
    expect(() => b.add('  ', 'meno')).toThrow('no usernames');
    expect(b.state().channels.map((c) => [c.channel, c.addedBy, c.status])).toEqual([['alice', 'meno', 'pending'], ['bob', 'meno', 'pending']]);
  });

  it('lists a channel, sorts its videos, and feeds them one at a time at backlog priority', async () => {
    makeQueue();
    lists.alice = [
      video('a'),
      video('old-big', { size: 50_000 }),
      video('recent', { created: new Date(clock - 2 * DAY).toISOString() }),
      video('s3', { storage: 'archived', eligible: false, reason: 'already archived in S3' }),
      video('dead', { eligible: false, reason: 'no CID', cid: null }),
      video('b'),
    ];
    const b = makeBacklog();
    b.start();
    b.add('alice', 'tibfox');
    await settle(b);

    const v = videosOf(b);
    expect(v['old-big']).toMatchObject({ status: VIDEO.SKIPPED, reason: 'bigger than the disk budget (DISK_BUDGET_GB)' });
    expect(v.recent).toMatchObject({ status: VIDEO.SKIPPED, reason: 'uploaded less than 7 days ago; the hotnode copies it' });
    expect(v.s3).toMatchObject({ status: VIDEO.PRESENT });
    expect(v.dead).toMatchObject({ status: VIDEO.SKIPPED, reason: 'no CID' });
    expect(v.a.status).toBe(VIDEO.QUEUED);
    expect(v.b.status).toBe(VIDEO.PENDING);
    expect(calls.map((c) => c.item.docId)).toEqual(['a']);
    expect(queue.item(v.a.itemId)).toMatchObject({ priority: PRIORITY.BACKLOG, mode: 'archived', by: 'tibfox' });

    calls[0].resolve({ cid: 'Qma', bytes: 1234, warnings: [] });
    await settle(b);
    expect(calls.map((c) => c.item.docId)).toEqual(['a', 'b']);
    calls[1].resolve({ cid: 'Qmb', bytes: 66, warnings: [] });
    await settle(b);

    const s = b.state();
    expect(s.channels[0]).toMatchObject({ status: 'done', done: 2, present: 1, skipped: 3, copiedBytes: 1300 });
    expect(s.last24h).toEqual({ videos: 2, bytes: 1300 });
    // One queue job per channel.
    const items = Object.values(videosOf(b)).filter((x) => x.itemId).map((x) => queue.item(x.itemId).job_id);
    expect(new Set(items).size).toBe(1);
  });

  it('lets manual work go ahead of waiting backlog items', async () => {
    makeQueue();
    lists.alice = [video('a'), video('b')];
    const b = makeBacklog({ maxActive: 2 });
    b.start();
    b.add('alice', 'meno');
    await settle(b);
    expect(calls.map((c) => c.item.docId)).toEqual(['a']);   // b waits in the queue
    queue.enqueue({ by: 'meno', items: [{ collection: 'legacy', docId: 'manual', cid: 'QmM' }] });
    calls[0].resolve({ cid: 'Qma', bytes: 1, warnings: [] });
    await settle(b);
    expect(calls.map((c) => c.item.docId)).toEqual(['a', 'manual']);
  });

  it('tries errors that may pass again hours later, then gives up', async () => {
    makeQueue();
    lists.alice = [video('a')];
    const b = makeBacklog();
    b.start();
    b.add('alice', 'meno');
    await settle(b);
    calls[0].reject(new OutOfSpaceError('disk full'));
    await settle(b);
    expect(videosOf(b).a).toMatchObject({ status: VIDEO.PENDING, rounds: 1, notBefore: clock + 1000 });
    expect(calls).toHaveLength(1);

    clock += 1000;
    b.kick();
    await settle(b);
    expect(calls).toHaveLength(2);
    calls[1].reject(new OutOfSpaceError('disk full'));
    await settle(b);
    clock += 2000;
    b.kick();
    await settle(b);
    calls[2].reject(new OutOfSpaceError('disk full'));
    await settle(b);
    expect(videosOf(b).a).toMatchObject({ status: VIDEO.FAILED, reason: 'disk full', rounds: 2 });
    expect(b.state().channels[0].status).toBe('done');
  });

  it('keeps verification failures failed, and skips videos that are no longer eligible', async () => {
    makeQueue();
    lists.alice = [video('a'), video('b'), video('c', { plan: { eligible: false, reason: 'already archived in S3' } })];
    const b = makeBacklog();
    b.start();
    b.add('alice', 'meno');
    await settle(b);
    calls[0].reject(new VerifyError('bad block'));
    await settle(b);
    calls[1].reject(new NotEligibleError('status "deleted" is not ready'));
    await settle(b);
    const v = videosOf(b);
    expect(v.a).toMatchObject({ status: VIDEO.FAILED, reason: 'bad block', rounds: 0 });
    expect(v.b).toMatchObject({ status: VIDEO.SKIPPED, reason: 'status "deleted" is not ready' });
    expect(v.c).toMatchObject({ status: VIDEO.PRESENT, reason: 'already in S3' });
    expect(calls).toHaveLength(2);

    expect(b.retry(b.state().channels[0].id)).toEqual({ retried: 1 });
    await settle(b);
    expect(calls).toHaveLength(3);
    expect(b.state().channels[0].status).toBe('migrating');
  });

  it(`pauses after ${FAIL_STREAK_PAUSE} failures in a row, and resume carries on`, async () => {
    makeQueue();
    lists.alice = Array.from({ length: FAIL_STREAK_PAUSE + 2 }, (_, i) => video(`v${i}`));
    const b = makeBacklog();
    b.start();
    b.add('alice', 'meno');
    for (let i = 0; i < FAIL_STREAK_PAUSE; i++) {
      await settle(b);
      calls[i].reject(new VerifyError(`bad ${i}`));
    }
    await settle(b);
    const s = b.state();
    expect(s.state).toBe('paused');
    expect(s.hold.reason).toBe(`${FAIL_STREAK_PAUSE} videos failed in a row; the last one: bad ${FAIL_STREAK_PAUSE - 1}`);
    expect(calls).toHaveLength(FAIL_STREAK_PAUSE);

    b.resume();
    await settle(b);
    expect(calls).toHaveLength(FAIL_STREAK_PAUSE + 1);
    expect(b.state()).toMatchObject({ state: 'running', failStreak: 0 });
  });

  it('a success resets the failure streak', async () => {
    makeQueue();
    lists.alice = Array.from({ length: FAIL_STREAK_PAUSE + 1 }, (_, i) => video(`v${i}`));
    const b = makeBacklog();
    b.start();
    b.add('alice', 'meno');
    for (let i = 0; i <= FAIL_STREAK_PAUSE; i++) {
      await settle(b);
      if (i === 2) calls[i].resolve({ cid: 'x', bytes: 1, warnings: [] });
      else calls[i].reject(new VerifyError('bad'));
    }
    await settle(b);
    expect(b.state().state).not.toBe('paused');
  });

  it('waits once the rolling 24 h cap is reached', async () => {
    makeQueue();
    lists.alice = [video('a'), video('b')];
    const b = makeBacklog({ dailyBytes: 100 });
    b.start();
    b.add('alice', 'meno');
    await settle(b);
    calls[0].resolve({ cid: 'Qma', bytes: 150, warnings: [] });
    await settle(b);
    const s = b.state();
    expect(s.state).toBe('waiting');
    expect(s.hold.until).toBe(new Date(clock + DAY).toISOString());
    expect(calls).toHaveLength(1);

    clock += DAY + 1;
    b.kick();
    await settle(b);
    expect(calls).toHaveLength(2);
  });

  it('only starts videos inside the hours window', async () => {
    makeQueue();
    lists.alice = [video('a')];
    const b = makeBacklog({ hours: { start: 1, end: 9 } });   // clock is 12:00 UTC
    b.start();
    b.add('alice', 'meno');
    await settle(b);
    expect(listed).toEqual([]);
    expect(b.state().hold).toMatchObject({ state: 'waiting', until: '2026-11-13T01:00:00.000Z' });

    clock = Date.UTC(2026, 10, 13, 1, 30);
    b.kick();
    await settle(b);
    expect(calls).toHaveLength(1);
  });

  it('pause holds new work; the running item finishes', async () => {
    makeQueue();
    lists.alice = [video('a'), video('b')];
    const b = makeBacklog();
    b.start();
    b.add('alice', 'meno');
    await settle(b);
    b.pause('paused by @meno', 'meno');
    calls[0].resolve({ cid: 'Qma', bytes: 1, warnings: [] });
    await settle(b);
    expect(calls).toHaveLength(1);
    expect(b.state()).toMatchObject({ state: 'paused', hold: { reason: 'paused by @meno', by: 'meno' } });
    expect(videosOf(b).a.status).toBe(VIDEO.DONE);
  });

  it('remove skips what waits and cancels what is queued', async () => {
    makeQueue();
    lists.alice = [video('a'), video('b')];
    const b = makeBacklog();
    b.start();
    b.add('alice', 'meno');
    await settle(b);
    const id = b.state().channels[0].id;
    b.remove(id);
    await settle(b);
    const v = videosOf(b);
    expect(v.a).toMatchObject({ status: VIDEO.SKIPPED, reason: 'cancelled' });
    expect(v.b).toMatchObject({ status: VIDEO.SKIPPED, reason: 'channel removed from the backlog' });
    expect(b.state().channels[0].status).toBe('removed');
    expect(() => b.retry(id)).toThrow('removed');
  });

  it('adding a finished channel again lists it again, keeping what is copied', async () => {
    makeQueue();
    lists.alice = [video('a')];
    const b = makeBacklog();
    b.start();
    b.add('alice', 'meno');
    await settle(b);
    calls[0].resolve({ cid: 'Qma', bytes: 10, warnings: [] });
    await settle(b);
    expect(b.state().channels[0].status).toBe('done');

    lists.alice = [video('a', { storage: 'archived', eligible: false }), video('new')];
    expect(b.add('alice', 'tibfox').added).toEqual(['alice']);
    await settle(b);
    const v = videosOf(b);
    expect(v.a.status).toBe(VIDEO.DONE);   // kept: it counts towards the 24 h cap
    expect(v.new.status).toBe(VIDEO.QUEUED);
    expect(listed).toEqual(['alice', 'alice']);
  });

  it('a listing error leaves the channel waiting, with the error', async () => {
    makeQueue();
    lists.alice = new Error('mongo down');
    const b = makeBacklog();
    b.start();
    b.add('alice', 'meno');
    await settle(b);
    expect(b.state().channels[0]).toMatchObject({ status: 'pending', error: 'could not list it: mongo down' });
    lists.alice = [video('a')];
    b.kick();
    await settle(b);
    expect(b.state().channels[0]).toMatchObject({ status: 'migrating', error: null });
  });

  it('channels are worked through in the order they were added', async () => {
    makeQueue();
    lists.alice = [video('a')];
    lists.bob = [video('b', { owner: 'bob' })];
    lists.carol = [];
    const b = makeBacklog();
    b.start();
    b.add('carol bob alice', 'meno');
    await settle(b);
    expect(listed).toEqual(['carol', 'bob']);
    expect(calls.map((c) => c.item.docId)).toEqual(['b']);
    expect(b.state().channels.find((c) => c.channel === 'carol').status).toBe('done');
  });

  it('on boot, settles items that finished while it was not listening', async () => {
    makeQueue();
    lists.alice = [video('a'), video('b')];
    const b = makeBacklog();
    b.start();
    b.add('alice', 'meno');
    await settle(b);
    await b.stop();
    calls[0].resolve({ cid: 'Qma', bytes: 5, warnings: [] });
    await flush();
    expect(videosOf(b).a.status).toBe(VIDEO.QUEUED);

    const again = makeBacklog();
    expect(again.start()).toEqual({ caught: 1 });
    await settle(again);
    expect(videosOf(again).a.status).toBe(VIDEO.DONE);
    expect(calls.map((c) => c.item.docId)).toEqual(['a', 'b']);
  });
});

describe('Queue priority', () => {
  it('runs lower priority numbers first, then by id', async () => {
    makeQueue();
    const items = (...ids) => ids.map((id) => ({ collection: 'legacy', docId: id, cid: `Qm${id}` }));
    queue.enqueue({ by: 'x', items: items('first') });
    queue.enqueue({ by: 'x', items: items('late'), priority: PRIORITY.BACKLOG });
    queue.enqueue({ by: 'x', items: items('manual') });
    calls[0].resolve({ cid: 'a', warnings: [] });
    await flush();
    expect(calls.map((c) => c.item.docId)).toEqual(['first', 'manual']);
  });

  it('appends to an existing job, and refuses an unknown one', () => {
    makeQueue();
    const { jobId } = queue.enqueue({ by: 'x', items: [{ collection: 'legacy', docId: 'a' }] });
    const r = queue.enqueue({ by: 'x', items: [{ collection: 'legacy', docId: 'b' }], jobId });
    expect(r.jobId).toBe(jobId);
    expect(queue.job(jobId).total).toBe(2);
    expect(() => queue.enqueue({ by: 'x', items: [{ collection: 'legacy', docId: 'c' }], jobId: 999 })).toThrow('no job 999');
  });

  it('adds the priority column to a database made before it', async () => {
    const Database = (await import('better-sqlite3')).default;
    const dbPath = path.join(dir, 'old.db');
    const old = new Database(dbPath);
    old.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL, collection TEXT NOT NULL, doc_id TEXT NOT NULL,
      owner TEXT, permlink TEXT, title TEXT, cid TEXT, mode TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'migrate', by TEXT NOT NULL,
      status TEXT NOT NULL, stage TEXT, attempts INTEGER NOT NULL DEFAULT 0, not_before INTEGER NOT NULL DEFAULT 0, progress TEXT,
      error TEXT, error_kind TEXT, result TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL)`);
    old.close();
    makeQueue({ dbPath });
    const { added } = queue.enqueue({ by: 'x', items: [{ collection: 'legacy', docId: 'a' }], priority: PRIORITY.BACKLOG });
    expect(queue.item(added[0]).priority).toBe(PRIORITY.BACKLOG);
  });
});
