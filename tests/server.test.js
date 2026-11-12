import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuth } from '../src/auth.js';
import { Backlog } from '../src/backlog.js';
import { listChannel } from '../src/catalog.js';
import { planItems } from '../src/dryRun.js';
import { loadConfig } from '../src/config.js';
import { DiskBudget } from '../src/disk.js';
import { Queue } from '../src/queue.js';
import { createBucket, createS3Client } from '../src/s3.js';
import { createApp, createServiceApp } from '../src/server.js';
import { startFakeS3 } from './helpers/fakeS3.js';
import { CID, CID2 } from './helpers/env.js';
import { fakeHive, signWith } from './helpers/hive.js';

let mongod, client, db, fake, dir, cfg, queue, app, serviceApp, auth, runs, backlog;
const TOKEN = 's'.repeat(40);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db('threespeak');
  fake = await startFakeS3();
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'migrator-srv-'));
  cfg = loadConfig({
    PUBLIC_BASE_URL: 'https://migrator.test', SESSION_SECRET: 'x'.repeat(40), ALLOWED_USERS: 'meno',
    MONGODB_URI: mongod.getUri(), S3_ENDPOINT: fake.endpoint, S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's',
    S3_BUCKET: 'videos-test', WORK_DIR: path.join(dir, 'work'), MIGRATOR_SERVICE_TOKEN: TOKEN,
  });
  const bucket = createBucket(cfg.s3, { client: createS3Client(cfg.s3) });
  const budget = new DiskBudget({ dir, budgetBytes: 1e9, reserveBytes: 0, statfs: async () => ({ bavail: 1e12, bsize: 1 }) });
  runs = [];
  // The pipeline itself is tested elsewhere; here every run waits forever.
  const run = (item) => { runs.push(item); return new Promise(() => {}); };
  queue = new Queue({ dbPath: path.join(dir, 'm.db'), workDir: cfg.workDir, maxConcurrent: 1, deps: {}, run });
  queue.start();
  auth = createAuth(cfg, { fetchImpl: fakeHive({ meno: { seeds: ['meno'] }, stranger: { seeds: ['stranger'] } }).fetchImpl });
  backlog = new Backlog({
    queue, list: (ch) => listChannel(db, cfg, ch), plan: async (ref) => (await planItems({ cfg, db, bucket }, [ref]))[0],
    tickMs: 1e9, log: { error() {}, warn() {} },
  });
  backlog.start();
  const deps = { cfg, db, bucket, budget, queue, auth, backlog };
  app = createApp(deps);
  serviceApp = createServiceApp(deps);
});

afterAll(async () => {
  await backlog.stop();
  queue.stopped = true;
  clearInterval(queue.timer);
  queue.db.close();
  await client?.close();
  await mongod?.stop();
  await fake?.close();
  await fs.promises.rm(dir, { recursive: true, force: true });
});

let ids;
beforeEach(async () => {
  await db.collection('videos').deleteMany({});
  await db.collection('embed-video').deleteMany({});
  queue.db.exec('DELETE FROM backlog_videos; DELETE FROM backlog_channels; DELETE FROM settings; DELETE FROM events; DELETE FROM items; DELETE FROM jobs;');
  queue.running.clear();
  runs.length = 0;
  const r = await db.collection('videos').insertMany([
    { owner: 'coolmole', permlink: 'ok', status: 'published', video_v2: `ipfs://${CID}/manifest.m3u8`, title: 'Fine' },
    { owner: 'coolmole', permlink: 'gone', status: 'deleted', video_v2: `ipfs://${CID2}/manifest.m3u8` },
    { owner: 'coolmole', permlink: 'moved', status: 'published', video_v2: `ipfs://${CID2}/manifest.m3u8`, storage_state: 'archived',
      s3_url: `https://buttercloud.b-cdn.net/videos-test/${CID2}/manifest.m3u8`, s3_migrated_at: new Date() },
  ]);
  ids = Object.values(r.insertedIds).map(String);
});

async function cookieFor(user) {
  const agent = request(app);
  const { body } = await agent.get(`/api/auth/challenge?user=${user}`);
  const res = await request(app).post('/api/auth/verify').send({ user, message: body.message, signature: signWith(user, body.message) });
  expect(res.status).toBe(200);
  const cookie = res.headers['set-cookie'][0];
  expect(cookie).toMatch(/HttpOnly/);
  expect(cookie).toMatch(/Secure/);
  expect(cookie).toMatch(/SameSite=Strict/);
  return cookie.split(';')[0];
}
const ref = (i) => ({ collection: 'legacy', id: ids[i] });

describe('read-only routes are open', () => {
  it('channel list with eligibility', async () => {
    const res = await request(app).get('/api/channel/coolmole');
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r) => [r.permlink, r.eligible])).toEqual(expect.arrayContaining([['ok', true], ['gone', false], ['moved', false]]));
  });

  it('me / status / jobs', async () => {
    expect((await request(app).get('/api/me')).body).toEqual({ user: null, authorized: false });
    expect((await request(app).get('/api/status')).body).toMatchObject({ bucket: 'videos-test', maxConcurrent: 1 });
    const jobs = await request(app).get('/api/jobs');
    expect(jobs.body).toEqual([]);
    expect(jobs.headers['cache-control']).toBe('no-store');
  });

  it('serves the page with a strict CSP', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Snapie Migrator');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('without PLAYER_BASE_URL: no preview, and the page may frame nothing', async () => {
    const res = await request(app).get('/api/status');
    expect(res.body).toMatchObject({ player: null, sourceHosts: { bucket: 'videos-test', hot: ['hotipfs-3speak-1.b-cdn.net'] } });
    expect((await request(app).get('/')).headers['content-security-policy']).toContain("frame-src 'none'");
  });

  it('with PLAYER_BASE_URL: the page may frame the player, and only the player', async () => {
    const withPlayer = createApp({ cfg: { ...cfg, playerBaseUrl: 'https://play.test', hotnodeGateway: 'https://hotipfs-1.3speak.tv' }, db, queue, auth, budget: new DiskBudget({ dir, budgetBytes: 1, reserveBytes: 0, statfs: async () => ({ bavail: 1, bsize: 1 }) }) });
    const page = await request(withPlayer).get('/');
    expect(page.headers['content-security-policy']).toMatch(/frame-src https:\/\/play\.test;/);
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    const { body } = await request(withPlayer).get('/api/status');
    expect(body.player).toBe('https://play.test');
    expect(body.sourceHosts).toEqual({
      bucket: 'videos-test',
      s3: [{ host: 'buttercloud.b-cdn.net', label: 'S3 (Bunny zone buttercloud.b-cdn.net)' }, { host: 's3.3speak.tv', label: 'S3 direct (s3.3speak.tv)' }],
      hot: ['hotipfs-3speak-1.b-cdn.net', 'hotipfs-1.3speak.tv'],
    });
  });

  it('bad channel names are 400, unknown API paths 404', async () => {
    expect((await request(app).get('/api/channel/$where')).status).toBe(400);
    expect((await request(app).get('/api/nope')).status).toBe(404);
  });
});

describe('actions need an allowed account', () => {
  const actions = [
    ['/api/dry-run', () => ({ items: [ref(0)] })],
    ['/api/jobs', () => ({ items: [ref(0)] })],
    ['/api/items/check-ipfs', () => ref(0)],
    ['/api/items/revert', () => ref(2)],
    ['/api/jobs/1/cancel', () => ({})],
  ];

  it.each(actions)('%s: 401 when logged out', async (url, body) => {
    expect((await request(app).post(url).send(body())).status).toBe(401);
  });

  it.each(actions)('%s: 403 for a logged-in account not on the list', async (url, body) => {
    const c = await cookieFor('stranger');
    expect((await request(app).post(url).set('Cookie', c).send(body())).status).toBe(403);
  });

  it('refuses non-JSON bodies and other origins (CSRF)', async () => {
    const c = await cookieFor('meno');
    expect((await request(app).post('/api/jobs').set('Cookie', c).type('form').send('x=1')).status).toBe(415);
    expect((await request(app).post('/api/jobs').set('Cookie', c).set('Origin', 'https://evil.test').send({ items: [ref(0)] })).status).toBe(403);
  });

  it('a forged service token on the public listener does nothing', async () => {
    const res = await request(app).post('/api/jobs').set('Authorization', `Bearer ${TOKEN}`).send({ items: [ref(0)] });
    expect(res.status).toBe(401);
  });
});

describe('as an allowed account', () => {
  it('dry run explains each video and writes nothing', async () => {
    const c = await cookieFor('meno');
    const res = await request(app).post('/api/dry-run').set('Cookie', c).send({ items: [ref(0), ref(1)] });
    expect(res.status).toBe(200);
    const [ok, gone] = res.body.plan;
    expect(ok).toMatchObject({ eligible: true, cid: CID, s3: { objectsAlready: 0, carAlready: false }, wouldSet: { storage_state: 'archived' } });
    expect(gone).toMatchObject({ eligible: false, reason: expect.stringContaining('not ready') });
    expect(await db.collection('videos').countDocuments({ storage_state: { $exists: true } })).toBe(1);
    expect(runs).toHaveLength(0);
  });

  it('migrate queues only the eligible ones, by the logged-in user', async () => {
    const c = await cookieFor('meno');
    const res = await request(app).post('/api/jobs').set('Cookie', c).send({ items: [ref(0), ref(1)], channel: 'coolmole' });
    expect(res.status).toBe(202);
    expect(res.body.added).toHaveLength(1);
    expect(res.body.skipped).toEqual([{ collection: 'legacy', id: ids[1], reason: expect.stringContaining('not ready') }]);
    expect(runs).toEqual([expect.objectContaining({ docId: ids[0], by: 'meno', kind: 'migrate', mode: 'archived' })]);
    const job = (await request(app).get(`/api/jobs/${res.body.jobId}`)).body;
    expect(job).toMatchObject({ created_by: 'meno', channel: 'coolmole', total: 1 });
  });

  it('check IPFS and revert are queued; revert only for our own migrations', async () => {
    const c = await cookieFor('meno');
    expect((await request(app).post('/api/items/revert').set('Cookie', c).send(ref(0))).status).toBe(409);
    const r = await request(app).post('/api/items/revert').set('Cookie', c).send(ref(2));
    expect(r.status).toBe(202);
    expect(queue.item(r.body.itemId)).toMatchObject({ kind: 'revert', by: 'meno' });
    // the same video can't be queued twice
    expect((await request(app).post('/api/items/check-ipfs').set('Cookie', c).send(ref(2))).status).toBe(409);
  });

  it('logout clears the cookie', async () => {
    const c = await cookieFor('meno');
    const res = await request(app).post('/api/auth/logout').set('Cookie', c).send({});
    expect(res.headers['set-cookie'][0]).toMatch(/migrator_session=;/);
  });
});

describe('service listener (hotnode)', () => {
  it('needs the token', async () => {
    expect((await request(serviceApp).post('/api/jobs').send({ items: [ref(0)] })).status).toBe(401);
    expect((await request(serviceApp).post('/api/jobs').set('Authorization', 'Bearer wrong').send({ items: [ref(0)] })).status).toBe(401);
  });

  it('queues hot-mode copies as service:hotnode', async () => {
    const res = await request(serviceApp).post('/api/jobs').set('Authorization', `Bearer ${TOKEN}`).send({ items: [ref(0)] });
    expect(res.status).toBe(202);
    expect(runs).toEqual([expect.objectContaining({ by: 'service:hotnode', mode: 'hot' })]);
  });

  it('exposes nothing else', async () => {
    expect((await request(serviceApp).post('/api/items/revert').set('Authorization', `Bearer ${TOKEN}`).send(ref(2))).status).toBe(404);
  });
});

// A real connection from a non-loopback address (the machine's LAN IP), as a request
// that reached the service port from outside would be.
const lanIp = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
describe.skipIf(!lanIp)('service listener from a non-loopback address', () => {
  it('refuses even with the right token', async () => {
    const server = serviceApp.listen(0, '0.0.0.0');
    await new Promise((r) => server.once('listening', r));
    try {
      const res = await fetch(`http://${lanIp}:${server.address().port}/api/jobs/1`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('loopback only');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});


describe('backlog', () => {
  const settled = async () => { for (let i = 0; i < 10; i++) { await new Promise((r) => setTimeout(r, 10)); await backlog.feeding; } };

  it('reads are open, writes need an allowed account', async () => {
    const r = await request(app).get('/api/backlog');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: 'idle', channels: [], pacing: { minAgeDays: 7 } });
    const anon = await request(app).post('/api/backlog/channels').send({ channels: ['coolmole'] });
    expect(anon.status).toBe(401);
    const stranger = await cookieFor('stranger');
    for (const p of ['/api/backlog/channels', '/api/backlog/pause', '/api/backlog/resume', '/api/backlog/channels/1/remove', '/api/backlog/channels/1/retry']) {
      const x = await request(app).post(p).set('Cookie', stranger).send({ channels: ['coolmole'] });
      expect(x.status, p).toBe(403);
    }
  });

  it('lists the channel from Mongo and queues the eligible video at backlog priority', async () => {
    const cookie = await cookieFor('meno');
    const add = await request(app).post('/api/backlog/channels').set('Cookie', cookie).send({ channels: ['@CoolMole', 'no'] });
    expect(add.status).toBe(201);
    expect(add.body).toEqual({ added: ['coolmole'], skipped: [{ channel: 'no', reason: 'not a Hive account name' }] });
    await settled();

    const { body } = await request(app).get('/api/backlog');
    expect(body.state).toBe('running');
    expect(body.channels[0]).toMatchObject({ channel: 'coolmole', addedBy: 'meno', status: 'migrating', queued: 1, present: 1, skipped: 1 });
    const detail = await request(app).get(`/api/backlog/channels/${body.channels[0].id}`);
    const byPermlink = Object.fromEntries(detail.body.videos.map((v) => [v.permlink, v]));
    expect(byPermlink.ok).toMatchObject({ status: 'queued', cid: CID });
    expect(byPermlink.gone).toMatchObject({ status: 'skipped', reason: 'status "deleted" is not ready' });
    expect(byPermlink.moved.status).toBe('present');
    expect(runs.map((x) => x.docId)).toEqual([ids[0]]);
    expect(queue.item(byPermlink.ok.itemId)).toMatchObject({ by: 'meno', mode: 'archived', priority: 10 });

    expect((await request(app).get('/api/backlog/channels/999')).status).toBe(404);
  });

  it('pause and resume, remove, and a bad body', async () => {
    const cookie = await cookieFor('meno');
    const paused = await request(app).post('/api/backlog/pause').set('Cookie', cookie).send({});
    expect(paused.body).toMatchObject({ state: 'paused', hold: { reason: 'paused by @meno', by: 'meno' } });
    await request(app).post('/api/backlog/channels').set('Cookie', cookie).send({ channels: 'coolmole' });
    await settled();
    expect(runs).toEqual([]);   // paused: not even listed
    const { body } = await request(app).get('/api/backlog');
    expect(body.channels[0].status).toBe('pending');

    const removed = await request(app).post(`/api/backlog/channels/${body.channels[0].id}/remove`).set('Cookie', cookie).send({});
    expect(removed.body.status).toBe('removed');
    const retry = await request(app).post(`/api/backlog/channels/${body.channels[0].id}/retry`).set('Cookie', cookie).send({});
    expect(retry.status).toBe(409);
    expect((await request(app).post('/api/backlog/channels/999/remove').set('Cookie', cookie).send({})).status).toBe(404);
    expect((await request(app).post('/api/backlog/channels').set('Cookie', cookie).send({})).status).toBe(400);

    const resumed = await request(app).post('/api/backlog/resume').set('Cookie', cookie).send({});
    expect(resumed.body.hold).toBeNull();
  });
});
