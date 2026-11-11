import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CancelledError, VerifyError } from '../src/errors.js';
import { MAX_ATTEMPTS, Queue } from '../src/queue.js';

let dir, queues;
beforeEach(async () => { dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'migrator-q-')); queues = []; });
afterEach(async () => {
  for (const q of queues) if (!q.stopped || q.db.open) await q.stop().catch(() => {});
  await fs.promises.rm(dir, { recursive: true, force: true });
});

// A controllable fake pipeline: each call waits until the test resolves or rejects it.
function fakeRun() {
  const calls = [];
  const run = (item, _deps, { signal, onProgress }) => new Promise((resolve, reject) => {
    const call = { item, resolve, reject, signal, onProgress };
    signal.addEventListener('abort', () => reject(new CancelledError()), { once: true });
    calls.push(call);
  });
  return { run, calls };
}

let clock;
function makeQueue(over = {}) {
  const q = new Queue({
    dbPath: path.join(dir, 'm.db'), workDir: path.join(dir, 'work'), maxConcurrent: 1, deps: {},
    now: () => clock, backoffMs: [1000, 2000, 3000], progressWriteMs: 0, ...over,
  });
  queues.push(q);
  return q;
}
const flush = () => new Promise((r) => setImmediate(r));
const items = (...ids) => ids.map((id, i) => ({ collection: 'legacy', docId: id, owner: 'coolmole', permlink: `p${i}`, cid: `Qm${id}` }));

beforeEach(() => { clock = 1_000_000; });

describe('Queue', () => {
  it('runs items one at a time by default, in order', async () => {
    const { run, calls } = fakeRun();
    const q = makeQueue({ run });
    q.start();
    const { jobId, added } = q.enqueue({ by: 'meno', channel: 'coolmole', items: items('a', 'b') });
    expect(added).toHaveLength(2);
    expect(calls.map((c) => c.item.docId)).toEqual(['a']);
    calls[0].resolve({ cid: 'Qma', warnings: [] });
    await flush();
    expect(calls.map((c) => c.item.docId)).toEqual(['a', 'b']);
    calls[1].resolve({ cid: 'Qmb', warnings: ['w1'] });
    await flush();
    expect(q.job(jobId)).toMatchObject({ total: 2, done: 2, failed: 0, created_by: 'meno', channel: 'coolmole' });
    expect(q.events(added[1]).map((e) => e.message)).toEqual(expect.arrayContaining(['done with 1 warning(s)', 'w1']));
  });

  it('two at a time when configured, but never the same CID twice', async () => {
    const { run, calls } = fakeRun();
    const q = makeQueue({ run, maxConcurrent: 2 });
    q.start();
    q.enqueue({ by: 'meno', items: [...items('a'), { collection: 'embed', docId: 'x', cid: 'Qma' }, ...items('c')] });
    expect(calls.map((c) => c.item.docId)).toEqual(['a', 'c']);
  });

  it('refuses more than 2 at once', () => {
    expect(() => makeQueue({ run: fakeRun().run, maxConcurrent: 3 })).toThrow('1 or 2');
  });

  it('leaves out a video that is already queued or running', async () => {
    const { run } = fakeRun();
    const q = makeQueue({ run });
    q.start();
    q.enqueue({ by: 'meno', items: items('a') });
    const second = q.enqueue({ by: 'coolmole', items: items('a', 'b') });
    expect(second.added).toHaveLength(1);
    expect(second.skipped[0]).toMatchObject({ docId: 'a', reason: expect.stringContaining('already in the queue') });
  });

  it('retries a network-type failure with backoff, then gives up after MAX_ATTEMPTS', async () => {
    const { run, calls } = fakeRun();
    const q = makeQueue({ run });
    q.start();
    const { added: [id] } = q.enqueue({ by: 'meno', items: items('a') });
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      calls.at(-1).reject(new Error('ECONNRESET'));
      await flush();
      if (attempt < MAX_ATTEMPTS) {
        expect(q.item(id)).toMatchObject({ status: 'queued', attempts: attempt, error: 'ECONNRESET' });
        q.tick();
        expect(calls).toHaveLength(attempt);          // still waiting out the backoff
        clock += 10_000;
        q.tick();
        expect(calls).toHaveLength(attempt + 1);
      }
    }
    expect(q.item(id)).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, error_kind: 'Error' });
  });

  it('does not retry a verification failure', async () => {
    const { run, calls } = fakeRun();
    const q = makeQueue({ run });
    q.start();
    const { added: [id] } = q.enqueue({ by: 'meno', items: items('a') });
    calls[0].reject(new VerifyError('block does not match its hash'));
    await flush();
    expect(q.item(id)).toMatchObject({ status: 'failed', attempts: 1, error_kind: 'VerifyError' });
  });

  it('cancels queued and running items', async () => {
    const { run, calls } = fakeRun();
    const q = makeQueue({ run });
    q.start();
    const { jobId, added: [a, b] } = q.enqueue({ by: 'meno', items: items('a', 'b') });
    expect(q.cancelJob(jobId)).toBe(2);
    await flush();
    expect(q.item(a).status).toBe('cancelled');
    expect(q.item(b).status).toBe('cancelled');
    expect(calls).toHaveLength(1);                     // b never started
  });

  it('records progress and the CID as the item runs', async () => {
    const { run, calls } = fakeRun();
    const q = makeQueue({ run });
    const seen = [];
    q.on('progress', (p) => seen.push(p.stage));
    q.start();
    const { added: [id] } = q.enqueue({ by: 'meno', items: [{ collection: 'legacy', docId: 'z' }] });
    calls[0].onProgress({ stage: 'download', cid: 'QmNew', bytesDone: 10 });
    expect(q.item(id)).toMatchObject({ stage: 'download', cid: 'QmNew', progress: { bytesDone: 10 } });
    expect(seen).toEqual(['download']);
  });

  it('after a crash, running items are queued again and leftover CARs deleted', async () => {
    const { run } = fakeRun();
    const q1 = makeQueue({ run });
    q1.start();
    const { added: [id] } = q1.enqueue({ by: 'meno', items: items('a') });
    expect(q1.item(id).status).toBe('running');
    fs.writeFileSync(path.join(dir, 'work', `item-${id}.car`), 'partial');
    fs.writeFileSync(path.join(dir, 'work', 'keep.txt'), 'not ours');
    q1.db.close();                                     // simulated crash: no stop()
    q1.stopped = true;
    clearInterval(q1.timer);

    const second = fakeRun();
    const q2 = makeQueue({ run: second.run });
    expect(q2.start()).toEqual({ requeued: 1 });
    expect(fs.readdirSync(path.join(dir, 'work'))).toEqual(['keep.txt']);
    expect(second.calls.map((c) => c.item.docId)).toEqual(['a']);
    expect(q2.events(id).map((e) => e.message)).toContain('interrupted by a restart; queued again');
  });

  it('a graceful stop puts running items back in the queue', async () => {
    const { run } = fakeRun();
    const q1 = makeQueue({ run });
    q1.start();
    const { added: [id] } = q1.enqueue({ by: 'meno', items: items('a') });
    await q1.stop();
    const q2 = makeQueue({ run: fakeRun().run });
    expect(q2.item(id)).toMatchObject({ status: 'queued', attempts: 0 });
  });
});
