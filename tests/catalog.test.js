import { MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMBED_READY, LEGACY_READY, eligibility, listChannel, loadVideo, storageOf } from '../src/catalog.js';
import { loadConfig } from '../src/config.js';
import { CID, CID2, baseEnv } from './helpers/env.js';

const cfg = loadConfig(baseEnv());
const ctx = { s3: cfg.s3, now: new Date('2026-11-11T12:00:00Z') };
const V2 = `ipfs://${CID}/manifest.m3u8`;
const S3_OK = `https://buttercloud.b-cdn.net/videos-test/${CID}/manifest.m3u8`;
const legacy = (over = {}) => ({ owner: 'coolmole', permlink: 'p1', status: 'published', video_v2: V2, ...over });
const embed = (over = {}) => ({ owner: 'coolmole', permlink: 'e1', status: 'published', manifest_cid: CID, ...over });

describe('eligibility', () => {
  it.each(LEGACY_READY.concat(['PUBLISHED']))('legacy status %s is ready', (status) => {
    expect(eligibility('legacy', legacy({ status }), ctx)).toEqual({ eligible: true, cid: CID, manifestPath: 'manifest.m3u8' });
  });

  it.each(['deleted', 'delete', 'self_deleted', 'encoding_failed', 'failed', 'encoding_ipfs', 'ipfs_pinning', 'uploaded', 'banned', undefined])(
    'legacy status %s is skipped', (status) => {
      const e = eligibility('legacy', legacy({ status }), ctx);
      expect(e.eligible).toBe(false);
      expect(e.reason).toContain('is not ready');
    });

  it.each(['publish_later', 'scheduled', 'processing', 'deleted'])('embed status %s is skipped (only published plays)', (status) => {
    expect(eligibility('embed', embed({ status }), ctx).eligible).toBe(false);
  });

  it('embed published is ready', () => {
    expect(EMBED_READY).toEqual(['published']);
    expect(eligibility('embed', embed(), ctx).eligible).toBe(true);
  });

  it('an expired story is skipped, a live one is not', () => {
    expect(eligibility('embed', embed({ story: true, story_expires_at: new Date('2026-11-10') }), ctx).reason).toBe('expired story');
    expect(eligibility('embed', embed({ story: true, story_expires_at: new Date('2026-11-12') }), ctx).eligible).toBe(true);
  });

  it('dead and unplayable-from-S3 sources are skipped with the reason', () => {
    expect(eligibility('legacy', legacy({ video_v2: undefined }), ctx).reason).toContain('dead video');
    expect(eligibility('legacy', legacy({ video_v2: CID }), ctx).reason).toContain('not an ipfs:// URL');
    expect(eligibility('embed', embed({ manifest_cid: undefined }), ctx).reason).toBe('no manifest_cid');
  });

  it('videos on the hotnode can be migrated', () => {
    expect(eligibility('legacy', legacy({ storage_state: 'hot' }), ctx).eligible).toBe(true);
  });

  it.each([
    [{ storage_state: 'archived', s3_url: S3_OK }, 'already archived'],
    [{ storage_state: 'hot', s3_url: S3_OK }, 'already has an S3 copy'],
    [{ storage_state: 'promoting', s3_url: S3_OK }, 'being promoted'],
    [{ storage_state: 'frozen' }, 'unknown storage_state'],
    [{ s3_bytes: 5 }, 'already has s3_bytes'],
  ])('%o is skipped (%s)', (over, reason) => {
    const e = eligibility('legacy', legacy(over), ctx);
    expect(e.eligible).toBe(false);
    expect(e.reason).toContain(reason);
    expect(e.cid).toBe(CID);
  });
});

describe('storageOf', () => {
  it.each([
    [{}, 'ipfs'],
    [{ storage_state: 'hot' }, 'ipfs'],
    [{ storage_state: 'hot', s3_url: S3_OK }, 'hot'],
    [{ storage_state: 'archived', s3_url: S3_OK }, 'archived'],
    [{ storage_state: 'archived', s3_url: 'https://evil.test/x/y' }, 'other'],
    [{ storage_state: 'promoting', s3_url: S3_OK }, 'other'],
  ])('%o → %s', (doc, want) => expect(storageOf(doc, cfg.s3)).toBe(want));
});

describe('listChannel / loadVideo (Mongo)', () => {
  let mongod, client, db;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    client = await MongoClient.connect(mongod.getUri());
    db = client.db('threespeak');
    await db.collection('videos').insertMany([
      legacy({ permlink: 'old', created: new Date('2024-01-01'), title: 'Old one', size: 1000 }),
      legacy({ permlink: 'gone', status: 'deleted', created: new Date('2025-01-01') }),
      legacy({ owner: 'someoneelse', permlink: 'not-mine' }),
    ]);
    await db.collection('embed-video').insertMany([
      embed({ permlink: 'new', manifest_cid: CID2, createdAt: new Date('2026-06-01'), thumbnail_url: 'ipfs://QmThumb' }),
    ]);
  });

  afterAll(async () => {
    await client?.close();
    await mongod?.stop();
  });

  it('lists both collections for the owner only, newest first', async () => {
    const rows = await listChannel(db, cfg, 'CoolMole', { now: ctx.now });
    expect(rows.map((r) => [r.collection, r.permlink, r.eligible])).toEqual([
      ['embed', 'new', true],
      ['legacy', 'gone', false],
      ['legacy', 'old', true],
    ]);
    expect(rows[0]).toMatchObject({ cid: CID2, storage: 'ipfs', thumbnail: 'ipfs://QmThumb', title: 'new' });
    expect(rows[2]).toMatchObject({ title: 'Old one', size: 1000 });
    expect(rows[1].reason).toContain('"deleted" is not ready');
    expect(typeof rows[0].id).toBe('string');
  });

  it('rejects something that is not a Hive account', async () => {
    await expect(listChannel(db, cfg, '{"$ne":null}')).rejects.toThrow('not a Hive account name');
  });

  it('loadVideo re-reads one document by its string id', async () => {
    const [row] = (await listChannel(db, cfg, 'coolmole')).filter((r) => r.permlink === 'old');
    const doc = await loadVideo(db, cfg, 'legacy', row.id);
    expect(doc._id).toBeInstanceOf(ObjectId);
    expect(doc.permlink).toBe('old');
    await expect(loadVideo(db, cfg, 'nope', row.id)).rejects.toThrow('unknown collection');
  });
});
