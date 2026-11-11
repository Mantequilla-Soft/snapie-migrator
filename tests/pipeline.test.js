import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { DiskBudget } from '../src/disk.js';
import { CancelledError, ChangedError, NotEligibleError, VerifyError } from '../src/errors.js';
import { runAny } from '../src/actions.js';
import { runItem } from '../src/pipeline.js';
import { MIN_PART_SIZE, createBucket, createS3Client } from '../src/s3.js';
import { buildDag, carBytes, videoFiles } from './helpers/car.js';
import { startFakeS3 } from './helpers/fakeS3.js';

let mongod, client, db, fake, gateway, gatewayUrl, workDir, cfg, bucket, dag, car, files;
const gatewayMode = { tamper: false, hits: 0 };
const player = { answer: null, hits: [] };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db('threespeak');
  fake = await startFakeS3();
  workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'migrator-work-'));

  // Segments bigger than a part, so the multipart path is part of the run.
  files = videoFiles({ segments: 4, segmentBytes: 4000 });
  files.push({ path: 'thumb.jpg', content: Buffer.alloc(MIN_PART_SIZE + 1234, 7) });
  dag = await buildDag(files);
  car = await carBytes([dag.cid], dag.blocks);

  gateway = http.createServer((req, res) => {
    gatewayMode.hits++;
    if (req.url !== `/ipfs/${dag.cid}/`) { res.writeHead(404); return res.end(); }
    const body = Buffer.from(car);
    if (gatewayMode.tamper) body[body.length - 50] ^= 0xff;
    res.writeHead(200, { 'content-type': 'application/vnd.ipld.car; version=1' });
    res.end(body);
  });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;

  cfg = loadConfig({
    PUBLIC_BASE_URL: 'https://migrator.test', SESSION_SECRET: 'x'.repeat(40), ALLOWED_USERS: 'meno',
    MONGODB_URI: mongod.getUri(), S3_ENDPOINT: fake.endpoint, S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's',
    S3_BUCKET: 'videos-test', HOTNODE_GATEWAY: '', IPFS_GATEWAYS: gatewayUrl, WORK_DIR: workDir,
    PLAYER_BASE_URL: 'https://player.test',
  });
  bucket = createBucket(cfg.s3, { client: createS3Client(cfg.s3), partSize: MIN_PART_SIZE });
});

afterAll(async () => {
  await client?.close();
  await mongod?.stop();
  await fake?.close();
  gateway?.closeAllConnections();
  await new Promise((r) => gateway.close(r));
  await fs.promises.rm(workDir, { recursive: true, force: true });
});

// Viewers' hosts (zone + direct) are served by the fake S3; the player answers what we set.
const fetchImpl = async (url, opts) => {
  const u = new URL(url);
  if (u.hostname === cfg.s3.cdnHost || u.hostname === cfg.s3.directHost) {
    if (fetchImpl.blockHost === u.hostname) return new Response('denied', { status: 403 });
    return fetch(`${fake.endpoint}${u.pathname}`, opts);
  }
  if (u.hostname === 'player.test') {
    player.hits.push(url);
    return Response.json(player.answer ?? {});
  }
  return fetch(url, opts);
};

let budget;
const deps = () => ({ cfg, db, bucket, budget, fetchImpl });
const legacyDoc = (over = {}) => ({ owner: 'coolmole', permlink: 'vid1', status: 'published', video_v2: `ipfs://${dag.cid}/manifest.m3u8`, title: 'T', views: 42, ...over });
let seq = 0;
const insertLegacy = async (over) => (await db.collection('videos').insertOne(legacyDoc(over))).insertedId;
const item = (docId, over = {}) => ({ id: ++seq, collection: 'legacy', docId: String(docId), by: 'meno', ...over });
const zone = () => `https://buttercloud.b-cdn.net/videos-test/${dag.cid}/manifest.m3u8`;

beforeEach(async () => {
  fake.objects.clear();
  Object.assign(fake.faults, { corruptPut: false, failPuts: 0, wrongEtag: false });
  gatewayMode.tamper = false;
  fetchImpl.blockHost = null;
  player.answer = null;
  player.hits = [];
  await db.collection('videos').deleteMany({});
  await db.collection('embed-video').deleteMany({});
  budget = new DiskBudget({ dir: workDir, budgetBytes: 1e9, reserveBytes: 0, statfs: async () => ({ bavail: 1e12, bsize: 1 }) });
});

const s3Keys = () => [...fake.objects.keys()].map((k) => k.replace('videos-test/', '')).sort();
const expectNothingWritten = async (id) => {
  const doc = await db.collection('videos').findOne({ _id: id });
  expect(doc.storage_state).toBeUndefined();
  expect(doc.s3_url).toBeUndefined();
};
const expectClean = () => {
  expect(fs.readdirSync(workDir)).toEqual([]);
  expect(budget.used).toBe(0);
};

describe('runItem: success', () => {
  it('copies the directory and the CAR, checks them, and writes only the new fields', async () => {
    const id = await insertLegacy();
    player.answer = { videoUrl: `https://player.test/hls?u=${encodeURIComponent(zone())}&s3=1` };
    const stages = [];
    const r = await runItem(item(id), deps(), { onProgress: (p) => { if (stages.at(-1) !== p.stage) stages.push(p.stage); } });

    expect(stages).toEqual(['resolve', 'download', 'verify', 'upload', 'check', 'mongo', 'player', 'done']);
    expect(r).toMatchObject({ cid: dag.cid.toString(), files: files.length, carBytes: car.length, uploaded: files.length + 1, skipped: 0, gateway: gatewayUrl, resumed: false });
    expect(r.player).toEqual({ ok: true, detail: 'player serves the S3 zone' });
    expect(r.warnings).toEqual([]);

    expect(s3Keys()).toEqual([...files.map((f) => `${dag.cid}/${f.path}`), `car/${dag.cid}.car`].sort());
    for (const f of files) expect(fake.get('videos-test', `${dag.cid}/${f.path}`).body.equals(f.content)).toBe(true);
    expect(fake.get('videos-test', `car/${dag.cid}.car`).body.equals(car)).toBe(true);
    expect(fake.get('videos-test', `${dag.cid}/thumb.jpg`).etag).toMatch(/-2$/);   // went up as multipart

    const doc = await db.collection('videos').findOne({ _id: id });
    expect(doc).toMatchObject({
      storage_state: 'archived', s3_url: zone(), s3_car_url: `https://s3.3speak.tv/videos-test/car/${dag.cid}.car`,
      s3_bytes: files.reduce((n, f) => n + f.content.length, 0), s3_files: files.length, s3_migrated_by: 'meno',
      // untouched
      video_v2: `ipfs://${dag.cid}/manifest.m3u8`, status: 'published', views: 42, title: 'T',
    });
    expectClean();
  });

  it('embed in hot mode keeps the hotnode as the source', async () => {
    const { insertedId } = await db.collection('embed-video').insertOne({ owner: 'coolmole', permlink: 'e1', status: 'published', manifest_cid: dag.cid.toString() });
    player.answer = { videoUrl: `https://player.test/hls?u=x&s3=1` };
    const r = await runItem(item(insertedId, { collection: 'embed', mode: 'hot' }), deps());
    expect(r.player.ok).toBe(true);
    const doc = await db.collection('embed-video').findOne({ _id: insertedId });
    expect(doc).toMatchObject({ storage_state: 'hot', manifest_cid: dag.cid.toString() });
  });

  it('a resumed item skips what is already in S3', async () => {
    const id = await insertLegacy();
    await runItem(item(id), deps());
    await db.collection('videos').updateOne({ _id: id }, { $unset: { storage_state: '', s3_url: '', s3_car_url: '', s3_bytes: '', s3_files: '', s3_migrated_at: '', s3_migrated_by: '' } });
    fake.objects.delete(`videos-test/${dag.cid}/480p/480p_2.ts`);
    const r = await runItem(item(id), deps());
    expect(r).toMatchObject({ uploaded: 1, skipped: files.length });
    expect(s3Keys()).toContain(`${dag.cid}/480p/480p_2.ts`);
  });

  it('after a crash past the Mongo step, a rerun just reports done', async () => {
    const id = await insertLegacy();
    await runItem(item(id), deps());
    gatewayMode.hits = 0;
    const r = await runItem(item(id), deps());
    expect(r.resumed).toBe(true);
    expect(gatewayMode.hits).toBe(0);
  });

  it('a failed player check is a warning, not a lost video', async () => {
    const id = await insertLegacy();
    player.answer = { videoUrl: 'https://player.test/hls?u=https%3A%2F%2Fhotipfs%2Fx' };
    const r = await runItem(item(id), deps());
    expect(r.player.ok).toBe(false);
    expect(r.warnings.join()).toContain('no s3=1');
    expect((await db.collection('videos').findOne({ _id: id })).storage_state).toBe('archived');
  });
});

describe('runItem: a gateway without the video', () => {
  it('an empty CAR from the first gateway (HTTP 200, header only) falls through to the next', async () => {
    const empty = await carBytes([dag.cid], []);
    const hot = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/vnd.ipld.car; version=1' });
      res.end(empty);
    });
    await new Promise((r) => hot.listen(0, '127.0.0.1', r));
    const hotUrl = `http://127.0.0.1:${hot.address().port}`;
    try {
      const cfg2 = loadConfig({
        PUBLIC_BASE_URL: 'https://migrator.test', SESSION_SECRET: 'x'.repeat(40), ALLOWED_USERS: 'meno',
        MONGODB_URI: mongod.getUri(), S3_ENDPOINT: fake.endpoint, S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's',
        S3_BUCKET: 'videos-test', HOTNODE_GATEWAY: hotUrl, IPFS_GATEWAYS: gatewayUrl, WORK_DIR: workDir,
      });
      const id = await insertLegacy();
      const r = await runItem(item(id), { ...deps(), cfg: cfg2 });
      expect(r.gateway).toBe(gatewayUrl);
      expect(r.warnings).toEqual([expect.stringMatching(new RegExp(`^${hotUrl} failed: bad CAR: .*missing`))]);
      expect((await db.collection('videos').findOne({ _id: id })).storage_state).toBe('archived');
      expectClean();
    } finally {
      hot.closeAllConnections();
      await new Promise((r) => hot.close(r));
    }
  });
});

describe('runItem: refuses to finish', () => {
  it('a corrupted CAR from the gateway: nothing uploaded, nothing written', async () => {
    const id = await insertLegacy();
    gatewayMode.tamper = true;
    await expect(runItem(item(id), deps())).rejects.toThrow(VerifyError);
    expect(s3Keys()).toEqual([]);
    await expectNothingWritten(id);
    expectClean();
  });

  it('S3 storing other bytes than sent: Mongo untouched', async () => {
    const id = await insertLegacy();
    fake.faults.corruptPut = true;
    await expect(runItem(item(id), deps())).rejects.toThrow(/ETag|differs/);
    await expectNothingWritten(id);
    expectClean();
  });

  it('an object damaged after upload (a middle segment the read-back skips): the listing catches it', async () => {
    const id = await insertLegacy();
    let damaged = false;
    const onProgress = (p) => {
      if (p.stage === 'check' && !damaged) {
        damaged = true;
        const k = `videos-test/${dag.cid}/480p/480p_1.ts`;
        const body = Buffer.from(fake.objects.get(k).body);
        body[10] ^= 0xff;
        fake.objects.set(k, { ...fake.objects.get(k), body, etag: crypto.createHash('md5').update(body).digest('hex') });
      }
    };
    await expect(runItem(item(id), deps(), { onProgress })).rejects.toThrow(/480p_1.ts in S3 differs/);
    await expectNothingWritten(id);
  });

  it('an object lost after upload: the listing catches it', async () => {
    const id = await insertLegacy();
    const onProgress = (p) => { if (p.stage === 'check') fake.objects.delete(`videos-test/${dag.cid}/480p/480p_2.ts`); };
    await expect(runItem(item(id), deps(), { onProgress })).rejects.toThrow(/S3 lists \d+ objects|480p_2.ts is missing/);
    await expectNothingWritten(id);
  });

  it('an object appearing under the CID during the run: the listing catches it', async () => {
    const id = await insertLegacy();
    const onProgress = (p) => {
      if (p.stage === 'check') fake.objects.set(`videos-test/${dag.cid}/surprise.ts`, { body: Buffer.from('x'), etag: 'e' });
    };
    await expect(runItem(item(id), deps(), { onProgress })).rejects.toThrow(/S3 lists \d+ objects/);
    await expectNothingWritten(id);
  });

  it('viewers unable to fetch through the zone: Mongo untouched', async () => {
    const id = await insertLegacy();
    fetchImpl.blockHost = 'buttercloud.b-cdn.net';
    await expect(runItem(item(id), deps())).rejects.toThrow(/buttercloud.b-cdn.net: manifest.m3u8 answered HTTP 403/);
    await expectNothingWritten(id);
    expectClean();
  });

  it('the document changing during the run: nothing written', async () => {
    const id = await insertLegacy();
    const onProgress = async (p) => {
      if (p.stage === 'check') await db.collection('videos').updateOne({ _id: id }, { $set: { storage_state: 'hot' } });
    };
    await expect(runItem(item(id), deps(), { onProgress })).rejects.toThrow(ChangedError);
    expect((await db.collection('videos').findOne({ _id: id })).s3_url).toBeUndefined();
  });

  it('a video that stopped being eligible', async () => {
    const id = await insertLegacy({ status: 'deleted' });
    gatewayMode.hits = 0;
    await expect(runItem(item(id), deps())).rejects.toThrow(NotEligibleError);
    expect(gatewayMode.hits).toBe(0);
    expect(s3Keys()).toEqual([]);
  });

  it('a video that is gone', async () => {
    await expect(runItem(item('64b000000000000000000000'), deps())).rejects.toThrow('no longer exists');
  });

  it('foreign objects already under the CID in S3', async () => {
    const id = await insertLegacy();
    await bucket.upload({ key: `${dag.cid}/stray.txt`, size: 1, chunks: (async function* () { yield Buffer.from('x'); })() });
    await expect(runItem(item(id), deps())).rejects.toThrow(/not in the video/);
    await expectNothingWritten(id);
  });

  it('a manifest the DAG does not have', async () => {
    const id = await insertLegacy({ video_v2: `ipfs://${dag.cid}/master.m3u8` });
    await expect(runItem(item(id), deps())).rejects.toThrow(/master.m3u8 is not in/);
  });

  it('cancel: stops, cleans up, writes nothing', async () => {
    const id = await insertLegacy();
    const ctrl = new AbortController();
    const onProgress = (p) => { if (p.stage === 'upload') ctrl.abort(); };
    await expect(runItem(item(id), deps(), { signal: ctrl.signal, onProgress })).rejects.toThrow(CancelledError);
    await expectNothingWritten(id);
    expectClean();
  });

  it('no room on disk: refuses before downloading', async () => {
    const id = await insertLegacy();
    budget = new DiskBudget({ dir: workDir, budgetBytes: 1e9, reserveBytes: 5e9, statfs: async () => ({ bavail: 5e9, bsize: 1 }) });
    gatewayMode.hits = 0;
    await expect(runItem(item(id), deps())).rejects.toThrow(/free on disk/);
    expect(gatewayMode.hits).toBe(0);
  });
});

describe('Check IPFS and Revert', () => {
  const migrated = async () => {
    const id = await insertLegacy();
    await runItem(item(id), deps());
    return id;
  };

  it('check: downloads from the IPFS nodes and verifies, writes nothing', async () => {
    const id = await migrated();
    const before = await db.collection('videos').findOne({ _id: id });
    const r = await runAny(item(id, { kind: 'check' }), deps());
    expect(r).toMatchObject({ live: true, cid: dag.cid.toString(), gateway: gatewayUrl, files: files.length });
    expect(await db.collection('videos').findOne({ _id: id })).toEqual(before);
    expectClean();
  });

  it('revert: removes only our fields; the S3 copy stays', async () => {
    const id = await migrated();
    const keys = s3Keys();
    const r = await runAny(item(id, { kind: 'revert' }), deps());
    expect(r.reverted).toBe(true);
    const doc = await db.collection('videos').findOne({ _id: id });
    for (const f of ['storage_state', 's3_url', 's3_car_url', 's3_bytes', 's3_files', 's3_migrated_at', 's3_migrated_by']) expect(doc[f]).toBeUndefined();
    expect(doc).toMatchObject({ video_v2: `ipfs://${dag.cid}/manifest.m3u8`, status: 'published', views: 42, title: 'T' });
    expect(s3Keys()).toEqual(keys);
    expectClean();
  });

  it('revert refuses when the CID is not complete on IPFS', async () => {
    const id = await migrated();
    gatewayMode.tamper = true;
    await expect(runAny(item(id, { kind: 'revert' }), deps())).rejects.toThrow(/no gateway served the CAR|does not match/);
    expect((await db.collection('videos').findOne({ _id: id })).storage_state).toBe('archived');
    expectClean();
  });

  it('revert refuses a video the migrator did not migrate', async () => {
    const id = await insertLegacy({ storage_state: 'archived', s3_url: zone() });
    gatewayMode.hits = 0;
    await expect(runAny(item(id, { kind: 'revert' }), deps())).rejects.toThrow(NotEligibleError);
    expect(gatewayMode.hits).toBe(0);
  });

  it('revert refuses when someone changed the document meanwhile', async () => {
    const id = await migrated();
    const onProgress = async (p) => { if (p.stage === 'verify') await db.collection('videos').updateOne({ _id: id }, { $set: { s3_url: 'changed' } }); };
    await expect(runAny(item(id, { kind: 'revert' }), deps(), { onProgress })).rejects.toThrow(ChangedError);
    expect((await db.collection('videos').findOne({ _id: id })).s3_url).toBe('changed');
  });
});

