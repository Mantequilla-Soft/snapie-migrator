import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { CancelledError, VerifyError } from '../src/errors.js';
import { BY, EVENT_BACKOFF_MS, EVENT_GIVE_UP_MS, HotnodeService, classify, sign, verifySignature } from '../src/hotnode.js';
import { migratedFields } from '../src/playerContract.js';
import { PRIORITY, Queue } from '../src/queue.js';
import { createServiceApp } from '../src/server.js';
import { CID, CID2, baseEnv } from './helpers/env.js';

const SECRET = 'h'.repeat(40);
const TOKEN = 't'.repeat(40);
const CALLBACK = 'http://127.0.0.1:3999/api/s3/callback';
const CID3 = 'QmPZ9gcCEpqKTo6aq61g2nXGUhM4iCL3ewB6LDXZCtioEB';

let mongod, client, db, dir, cfg, clock, fetches, respond, calls, queue, svc;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db('threespeak');
});
afterAll(async () => { await client?.close(); await mongod?.stop(); });

const flush = () => new Promise((r) => setImmediate(r));
const silent = { error() {}, warn() {}, log() {} };

// The fake pipeline: each run waits until the test finishes it.
function run(item, _deps, { signal, onProgress }) {
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new CancelledError()), { once: true });
    calls.push({ item, resolve, reject, onProgress });
  });
}

/** Do what the pipeline does at the end: write our fields, then report done. */
async function complete(call, { warnings = [] } = {}) {
  const coll = call.item.collection === 'legacy' ? 'videos' : 'embed-video';
  const fields = migratedFields(cfg.s3, { cid: call.item.cid ?? CID, manifestPath: 'manifest.m3u8', bytes: 1000, files: 9, by: call.item.by, mode: call.item.mode });
  await db.collection(coll).updateOne({ _id: await idOf(call) }, { $set: fields });
  call.resolve({ cid: CID, warnings });
  await flush();
}
async function idOf(call) {
  const { ObjectId } = await import('mongodb');
  return new ObjectId(call.item.docId);
}

function makeService(over = {}) {
  return new HotnodeService({ queue, db, cfg, fetchImpl, now: () => clock, log: silent, sweepMs: 1e9, deliverMs: 1e9, ...over });
}

async function fetchImpl(url, opts = {}) {
  fetches.push({ url, ...opts });
  return respond(url, opts);
}
const okJson = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const defaultRespond = (url, opts) => {
  if (url === CALLBACK) return new Response('ok');
  if (opts.method === 'HEAD') return new Response(null, { status: 200 });
  return new Response('?', { status: 404 });
};
const posted = () => fetches.filter((f) => f.url === CALLBACK).map((f) => ({ ...f, json: JSON.parse(f.body) }));

/** Let item events settle, then deliver what is pending. */
async function drain() {
  await flush();
  await svc.settle();
  svc.deliverSoon();
  await svc.delivering;
}

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'migrator-hot-'));
  cfg = loadConfig(baseEnv({
    MONGODB_URI: mongod.getUri(), WORK_DIR: path.join(dir, 'work'), MIGRATOR_SERVICE_TOKEN: TOKEN,
    HOTNODE_CALLBACK_URL: CALLBACK, HOTNODE_CALLBACK_SECRET: SECRET,
  }));
  clock = Date.parse('2026-11-13T10:00:00Z');
  fetches = [];
  respond = defaultRespond;
  calls = [];
  await db.collection('videos').deleteMany({});
  await db.collection('embed-video').deleteMany({});
  queue = new Queue({ dbPath: path.join(dir, 'm.db'), workDir: cfg.workDir, maxConcurrent: 2, deps: {}, run, now: () => clock, backoffMs: [0, 0, 0] });
  queue.start();
  svc = makeService();
  svc.start();
});

afterEach(async () => {
  await svc.stop();
  await queue.stop();
  await fs.promises.rm(dir, { recursive: true, force: true });
});

const legacy = (over = {}) => ({ owner: 'coolmole', permlink: 'one', status: 'published', video_v2: `ipfs://${CID}/manifest.m3u8`, title: 'One', ...over });
const embed = (over = {}) => ({ owner: 'coolmole', permlink: 'short', status: 'published', manifest_cid: CID, ...over });
const ours = (cid, mode = 'hot') => migratedFields(baseCfgS3(), { cid, manifestPath: 'manifest.m3u8', bytes: 10, files: 2, by: 'meno', mode });
const baseCfgS3 = () => loadConfig(baseEnv()).s3;

describe('classify', () => {
  const s3 = baseCfgS3();
  it('sorts documents the way the hotnode needs them', () => {
    expect(classify('legacy', legacy(), s3, CID).kind).toBe('eligible');
    expect(classify('legacy', legacy({ status: 'deleted' }), s3, CID).kind).toBe('not_ready');
    expect(classify('legacy', legacy({ video_v2: CID }), s3, CID).kind).toBe('not_ipfs');
    expect(classify('legacy', legacy(ours(CID)), s3, CID).kind).toBe('copied');
    expect(classify('legacy', legacy(ours(CID, 'archived')), s3, CID).kind).toBe('archived');
    expect(classify('legacy', legacy({ s3_url: 'https://elsewhere.test/x/y' }), s3, CID).kind).toBe('conflict');
    expect(classify('legacy', legacy({ storage_state: 'promoting' }), s3, CID).kind).toBe('conflict');
    // A valid s3_url that the migrator didn't write is not ours to vouch for.
    const { s3_migrated_by: _, ...noBy } = ours(CID);
    expect(classify('legacy', legacy(noBy), s3, CID).kind).toBe('conflict');
    expect(classify('embed', embed({ story: true, story_expires_at: new Date(0) }), s3, CID).kind).toBe('not_ready');
  });
});

describe('signatures', () => {
  it('verify with the right secret and a fresh timestamp only', () => {
    const body = '{"a":1}';
    const now = Date.now();
    const ts = String(Math.floor(now / 1000));
    const sig = sign(SECRET, ts, body);
    // Spelled out independently: this is the exact recipe the hotnode implements.
    expect(sig).toBe(`sha256=${crypto.createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex')}`);
    expect(verifySignature(SECRET, { timestamp: ts, signature: sig, body, now })).toBe(true);
    expect(verifySignature('w'.repeat(40), { timestamp: ts, signature: sig, body, now })).toBe(false);
    expect(verifySignature(SECRET, { timestamp: ts, signature: sig, body: '{"a":2}', now })).toBe(false);
    expect(verifySignature(SECRET, { timestamp: ts, signature: sig, body, now: now + 301_000 })).toBe(false);
  });
});

describe('requestCids', () => {
  it('resolves a CID to every ready document that holds it, and is idempotent', async () => {
    await db.collection('videos').insertOne(legacy());
    await db.collection('videos').insertOne(legacy({ permlink: 'old', status: 'deleted' }));   // ignored
    await db.collection('embed-video').insertOne(embed());
    const r = await svc.requestCids([CID]);
    expect(r.cids).toEqual([{ cid: CID, status: 'queued', items: expect.any(Array) }]);
    expect(r.cids[0].items).toHaveLength(2);
    const job = queue.job(r.jobId);
    expect(job.items.map((i) => [i.collection, i.mode, i.by, i.priority])).toEqual([['legacy', 'hot', BY, 0], ['embed', 'hot', BY, 0]]);

    const again = await svc.requestCids([CID, CID]);
    expect(again.cids).toEqual([{ cid: CID, status: 'in_progress', items: r.cids[0].items }]);
    expect(queue.job(r.jobId).total).toBe(2);
  });

  it('rejects with machine-readable reasons', async () => {
    await db.collection('videos').insertMany([
      legacy({ video_v2: `ipfs://${CID2}/manifest.m3u8`, status: 'encoding' }),
      legacy({ video_v2: CID3 }),
    ]);
    await db.collection('embed-video').insertOne(embed({ s3_url: 'https://elsewhere.test/b/x' }));
    const r = await svc.requestCids([CID, CID2, CID3, 'nope', 'QmUnknownUnknownUnknownUnknownUnknownUnknown12']);
    expect(r.jobId).toBeNull();
    expect(r.cids.map((c) => [c.cid.slice(0, 8), c.status, c.reason])).toEqual([
      [CID.slice(0, 8), 'rejected', 'conflict'],
      [CID2.slice(0, 8), 'rejected', 'not_ready'],
      [CID3.slice(0, 8), 'rejected', 'not_ipfs'],
      ['nope', 'rejected', 'not_a_cid'],
      ['QmUnknow', 'rejected', 'not_in_mongo'],
    ]);
    expect(r.cids[0].detail).toMatch(/embed .*: already has s3_url/);
  });

  it('answers already_copied at once and still sends copied', async () => {
    await db.collection('videos').insertOne(legacy(ours(CID)));
    const r = await svc.requestCids([CID]);
    expect(r.cids).toEqual([{ cid: CID, status: 'already_copied' }]);
    await drain();
    const [ev] = posted();
    expect(ev.json).toMatchObject({ event: 'copied', cid: CID, s3_url: expect.stringContaining(`/${CID}/manifest.m3u8`), bytes: 10, files: 2 });
    expect(ev.json.documents).toEqual([expect.objectContaining({ collection: 'legacy', owner: 'coolmole', permlink: 'one', item: null })]);
  });

  it('follows a document the backlog already queued, at normal priority', async () => {
    const { insertedId } = await db.collection('videos').insertOne(legacy());
    const b = queue.enqueue({ by: 'meno', mode: 'archived', priority: PRIORITY.BACKLOG, items: [{ collection: 'legacy', docId: String(insertedId), cid: CID }] });
    const r = await svc.requestCids([CID]);
    expect(r.cids[0]).toEqual({ cid: CID, status: 'queued', items: b.added });
    expect(queue.item(b.added[0]).priority).toBe(PRIORITY.NORMAL);
  });

  it('limits a call to 100 CIDs', async () => {
    await expect(svc.requestCids(Array(101).fill(CID))).rejects.toMatchObject({ status: 400 });
    await expect(svc.requestCids([])).rejects.toMatchObject({ status: 400 });
  });
});

describe('events', () => {
  it('sends one signed copied event once every document of the CID is done', async () => {
    await db.collection('videos').insertOne(legacy());
    await db.collection('embed-video').insertOne(embed());
    const r = await svc.requestCids([CID]);
    await flush();
    await complete(calls[0], { warnings: ['player check: player unreachable'] });
    await drain();
    expect(posted()).toHaveLength(0);   // the embed document is still running
    await complete(calls[1]);
    await drain();
    const [ev] = posted();
    expect(ev.json).toMatchObject({
      event: 'copied', cid: CID, bytes: 1000, files: 9, warnings: ['player check: player unreachable'],
      s3_car_url: `https://s3.3speak.tv/videos-test/car/${CID}.car`,
    });
    expect(ev.json.documents.map((d) => d.item)).toEqual(r.cids[0].items);
    expect(ev.json.id).toMatch(/^evt_[0-9a-f]{24}$/);
    expect(ev.headers['X-Migrator-Event']).toBe(ev.json.id);
    expect(verifySignature(SECRET, { timestamp: ev.headers['X-Migrator-Timestamp'], signature: ev.headers['X-Migrator-Signature'], body: ev.body, now: clock })).toBe(true);
    expect(ev.redirect).toBe('error');
    expect(svc.summary()).toMatchObject({ openRequests: 0, pending: 0, givenUp: 0 });
    // Done: the CID can be asked for again, and is then already copied.
    expect((await svc.requestCids([CID])).cids[0].status).toBe('already_copied');
  });

  it('sends failed with the code and whether asking again may help', async () => {
    await db.collection('videos').insertOne(legacy());
    await db.collection('videos').insertOne(legacy({ permlink: 'two', video_v2: `ipfs://${CID2}/manifest.m3u8` }));
    await svc.requestCids([CID, CID2]);
    await flush();
    calls[0].onProgress({ stage: 'verify', cid: CID });
    calls[0].reject(new VerifyError('block x does not match its hash'));
    calls[1].onProgress({ stage: 'check', cid: CID2 });
    calls[1].reject(new VerifyError('https://zone/x answered HTTP 404', { code: 'readback_failed' }));
    await drain();
    const evs = Object.fromEntries(posted().map((e) => [e.json.cid, e.json]));
    expect(evs[CID]).toMatchObject({ event: 'failed', error: { code: 'bad_car', message: 'block x does not match its hash' }, retryable: false });
    expect(evs[CID2]).toMatchObject({ event: 'failed', error: { code: 'readback_failed' }, retryable: true });
  });

  it('names a failure without a code after its stage, once the queue gave up', async () => {
    await db.collection('videos').insertOne(legacy());
    await svc.requestCids([CID]);
    for (let i = 0; i < 3; i++) {
      await flush();
      const c = calls.at(-1);
      c.onProgress({ stage: 'upload', cid: CID });
      c.reject(new Error('socket hang up'));
    }
    await drain();
    expect(calls).toHaveLength(3);
    expect(posted()[0].json).toMatchObject({ event: 'failed', error: { code: 'upload_failed', message: 'socket hang up' }, retryable: true });
  });

  it('a cancelled item fails the CID, not retryable', async () => {
    await db.collection('videos').insertOne(legacy());
    const r = await svc.requestCids([CID]);
    queue.cancelItem(r.cids[0].items[0]);
    await drain();
    expect(posted()[0].json).toMatchObject({ event: 'failed', error: { code: 'cancelled' }, retryable: false });
  });

  it('retries delivery with backoff, in order, and gives up after 7 days', async () => {
    await db.collection('videos').insertOne(legacy(ours(CID)));
    await db.collection('videos').insertOne(legacy({ permlink: 'two', video_v2: `ipfs://${CID2}/manifest.m3u8`, ...ours(CID2) }));
    respond = (url, opts) => (url === CALLBACK ? new Response('no', { status: 500 }) : defaultRespond(url, opts));
    await svc.requestCids([CID, CID2]);
    await drain();
    expect(posted().map((e) => e.json.cid)).toEqual([CID]);   // the second waits behind the first
    expect(svc.summary()).toMatchObject({ pending: 2, lastError: 'HTTP 500' });

    await drain();
    expect(posted()).toHaveLength(1);   // not before the backoff
    clock += EVENT_BACKOFF_MS.first;
    respond = (url, opts) => (url === CALLBACK ? Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })) : defaultRespond(url, opts));
    await drain();
    expect(svc.summary().lastError).toBe('ECONNREFUSED');
    clock += EVENT_BACKOFF_MS.first;   // the second wait is twice as long
    await drain();
    expect(posted()).toHaveLength(2);

    respond = defaultRespond;
    clock += EVENT_GIVE_UP_MS;
    await drain();
    expect(svc.summary()).toMatchObject({ pending: 0, givenUp: 2 });
  });

  it('a restart settles what finished meanwhile and re-sends what was not delivered', async () => {
    await db.collection('videos').insertOne(legacy());
    await svc.requestCids([CID]);
    await flush();
    await svc.stop();
    await complete(calls[0]);   // finishes while nobody listens
    expect(svc.summary().openRequests).toBe(1);

    respond = (url, opts) => (url === CALLBACK ? new Response('', { status: 503 }) : defaultRespond(url, opts));
    svc = makeService();
    svc.start();
    await drain();
    expect(svc.summary()).toMatchObject({ openRequests: 0, pending: 1 });
    await svc.stop();

    respond = defaultRespond;
    clock += EVENT_BACKOFF_MS.first;
    svc = makeService();
    svc.start();
    await drain();
    const evs = posted();
    expect(evs).toHaveLength(2);
    expect(evs[1].json.id).toBe(evs[0].json.id);   // the same event, so the hotnode can ignore a repeat
    expect(svc.summary().pending).toBe(0);
  });

  it('a copy reverted before its event is reported as failed', async () => {
    const { insertedId } = await db.collection('videos').insertOne(legacy());
    await svc.requestCids([CID]);
    await flush();
    await svc.stop();
    await complete(calls[0]);
    await db.collection('videos').updateOne({ _id: insertedId }, { $unset: { s3_url: '' } });
    svc = makeService();
    svc.start();
    await drain();
    expect(posted()[0].json).toMatchObject({ event: 'failed', error: { code: 'changed_during_migration' }, retryable: true });
  });

  it('keeps events without a callback, marked off', async () => {
    cfg = { ...cfg, callback: null };
    await svc.stop();
    svc = makeService();
    svc.start();
    await db.collection('videos').insertOne(legacy(ours(CID)));
    await svc.requestCids([CID]);
    await drain();
    expect(posted()).toHaveLength(0);
    expect(svc.summary()).toMatchObject({ callback: false, pending: 0 });
    expect((await svc.cidState(CID)).last_event).toMatchObject({ event: 'copied', delivery: 'off' });
  });
});

describe('archive', () => {
  it('flips our hot copies to archived, once, and sends archived', async () => {
    const { insertedId } = await db.collection('videos').insertOne(legacy(ours(CID)));
    await db.collection('embed-video').insertOne(embed(ours(CID, 'archived')));
    const r = await svc.archive(CID);
    expect(r).toMatchObject({ cid: CID, archived: 1, already: 1, warnings: [] });
    expect((await db.collection('videos').findOne({ _id: insertedId })).storage_state).toBe('archived');
    expect(fetches.find((f) => f.method === 'HEAD').url).toBe(`https://buttercloud.b-cdn.net/videos-test/${CID}/manifest.m3u8`);
    await drain();
    expect(posted()[0].json).toMatchObject({ event: 'archived', cid: CID, archived: 1 });

    expect(await svc.archive(CID)).toMatchObject({ archived: 0, already: 2 });
  });

  it('refuses what we did not copy, and a copy that is gone', async () => {
    await db.collection('videos').insertOne(legacy());
    await expect(svc.archive(CID)).rejects.toMatchObject({ status: 409, code: 'not_copied' });
    await db.collection('videos').updateOne({}, { $set: ours(CID) });
    respond = (url, opts) => (opts.method === 'HEAD' ? new Response(null, { status: 404 }) : defaultRespond(url, opts));
    await expect(svc.archive(CID)).rejects.toMatchObject({ status: 409, code: 'copy_missing' });
    respond = (url, opts) => (opts.method === 'HEAD' ? new Response(null, { status: 502 }) : defaultRespond(url, opts));
    await expect(svc.archive(CID)).rejects.toMatchObject({ status: 503, code: 'copy_check_unavailable' });
    expect((await db.collection('videos').findOne({})).storage_state).toBe('hot');
    await expect(svc.archive(CID2)).rejects.toMatchObject({ status: 404, code: 'not_in_mongo' });
  });

  it('warns when the player does not serve the S3 zone afterwards', async () => {
    cfg = { ...cfg, playerBaseUrl: 'https://play.test' };
    await svc.stop();
    svc = makeService();
    svc.start();
    await db.collection('videos').insertOne(legacy(ours(CID)));
    respond = (url, opts) => (url.startsWith('https://play.test/')
      ? okJson({ videoUrl: 'https://play.test/hls?u=https%3A%2F%2Fhotipfs-3speak-1.b-cdn.net%2Fx&s3=1' })
      : defaultRespond(url, opts));
    const r = await svc.archive(CID);
    expect(r.warnings).toEqual([expect.stringMatching(/^player check \(coolmole\/one\): player plays https:\/\/hotipfs/)]);
  });
});

describe('cidState', () => {
  it('reports every state from Mongo and our tables', async () => {
    expect(await svc.cidState(CID)).toMatchObject({ state: 'unknown', reason: 'not_in_mongo', documents: [] });
    const { insertedId } = await db.collection('videos').insertOne(legacy());
    expect((await svc.cidState(CID)).state).toBe('unknown');

    await svc.requestCids([CID]);
    await flush();
    expect(await svc.cidState(CID)).toMatchObject({ state: 'in_progress', items: [expect.objectContaining({ status: 'running' })] });
    calls[0].reject(new VerifyError('bad'));
    await drain();
    expect(await svc.cidState(CID)).toMatchObject({ state: 'failed', last_event: { event: 'failed', delivery: 'delivered' } });

    await db.collection('videos').updateOne({ _id: insertedId }, { $set: ours(CID) });
    expect(await svc.cidState(CID)).toMatchObject({ state: 'copied', documents: [expect.objectContaining({ kind: 'copied', storage_state: 'hot' })] });
    await svc.archive(CID);
    expect((await svc.cidState(CID)).state).toBe('archived');
    await expect(svc.cidState('nope')).rejects.toMatchObject({ status: 400 });
  });
});

describe('service routes', () => {
  const auth = { serviceOk: (h) => h === `Bearer ${TOKEN}` };
  const app = () => createServiceApp({ cfg, db, queue, auth, hotnode: svc });
  const bearer = { Authorization: `Bearer ${TOKEN}` };

  it('take cids, archive and the state lookup, with codes in errors', async () => {
    await db.collection('videos').insertOne(legacy());
    const r = await request(app()).post('/api/jobs').set(bearer).send({ cids: [CID] });
    expect(r.status).toBe(202);
    expect(r.body.cids[0].status).toBe('queued');
    expect((await request(app()).post('/api/jobs').set(bearer).send({ cids: [CID], items: [] })).status).toBe(400);
    expect((await request(app()).get(`/api/cids/${CID}`).set(bearer)).body.state).toBe('in_progress');
    const a = await request(app()).post('/api/archive').set(bearer).send({ cid: CID });
    expect(a.status).toBe(409);
    expect(a.body).toMatchObject({ code: 'not_copied', error: expect.stringContaining('not copied') });
    expect((await request(app()).get(`/api/cids/${CID}`)).status).toBe(401);
  });
});
