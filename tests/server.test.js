import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { DiskBudget } from '../src/disk.js';
import { Queue } from '../src/queue.js';
import { createBucket, createS3Client } from '../src/s3.js';
import { createApp, createServiceApp } from '../src/server.js';
import { startFakeS3 } from './helpers/fakeS3.js';
import { CID, CID2 } from './helpers/env.js';
import { fakeHive, signWith } from './helpers/hive.js';

let mongod, client, db, fake, dir, cfg, queue, app, serviceApp, auth, runs;
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
  const deps = { cfg, db, bucket, budget, queue, auth };
  app = createApp(deps);
  serviceApp = createServiceApp(deps);
});

afterAll(async () => {
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
  queue.db.exec('DELETE FROM events; DELETE FROM items; DELETE FROM jobs;');
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

