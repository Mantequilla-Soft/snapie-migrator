import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  COLLECTION, MIGRATOR_FIELDS, carKey, fieldConflicts, migrateFilter, migratedFields, objectKey,
  parseS3Url, revertFilter, revertUpdate, sourceOf,
} from '../src/playerContract.js';
import { CID, CID2, baseEnv } from './helpers/env.js';

const cfg = loadConfig(baseEnv());
const { s3 } = cfg;
const fields = (over = {}) => migratedFields(s3, { cid: CID, manifestPath: 'manifest.m3u8', bytes: 2281302, files: 4, by: 'meno', now: new Date('2026-11-11T00:00:00Z'), ...over });

describe('sourceOf', () => {
  it.each([
    [`ipfs://${CID}/manifest.m3u8`, 'manifest.m3u8'],
    [`ipfs://${CID}`, 'manifest.m3u8'],
    [`ipfs://${CID}/`, 'manifest.m3u8'],
    [`ipfs://${CID}/hls/master.m3u8`, 'hls/master.m3u8'],
  ])('legacy %s → %s', (video_v2, manifestPath) => {
    expect(sourceOf(COLLECTION.LEGACY, { video_v2 })).toEqual({ cid: CID, manifestPath, field: 'video_v2', value: video_v2 });
  });

  it.each([
    [undefined, 'no video_v2'],
    ['', 'no video_v2'],
    [CID, 'not an ipfs:// URL'],                        // bare CID: storagePlan finds no CID
    ['https://files.test/v.mp4', 'not an ipfs:// URL'],
    ['ipfs://not-a-cid/manifest.m3u8', 'is not a CID'],
    [`ipfs://${CID}/../x/manifest.m3u8`, 'not a plain path'],
  ])('legacy %s is not migratable (%s)', (video_v2, reason) => {
    expect(sourceOf(COLLECTION.LEGACY, { video_v2 }).reason).toContain(reason);
  });

  it('embed always plays <manifest_cid>/manifest.m3u8', () => {
    expect(sourceOf(COLLECTION.EMBED, { manifest_cid: CID })).toEqual({ cid: CID, manifestPath: 'manifest.m3u8', field: 'manifest_cid', value: CID });
    expect(sourceOf(COLLECTION.EMBED, {}).reason).toBe('no manifest_cid');
    expect(sourceOf(COLLECTION.EMBED, { manifest_cid: 'ipfs://x' }).reason).toContain('is not a CID');
  });

  it('accepts a CIDv1', () => {
    const v1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
    expect(sourceOf(COLLECTION.EMBED, { manifest_cid: v1 }).cid).toBe(v1);
  });
});

describe('keys and URLs', () => {
  it('keeps the IPFS layout under <cid>/ and the CAR outside it', () => {
    expect(objectKey(CID, '480p/index.m3u8')).toBe(`${CID}/480p/index.m3u8`);
    expect(carKey(CID)).toBe(`car/${CID}.car`);
  });

  it('parseS3Url follows the player: our hosts, our bucket, <cid>/<file>', () => {
    expect(parseS3Url(s3, `https://buttercloud.b-cdn.net/videos-test/${CID}/manifest.m3u8`)).toEqual({ host: 'buttercloud.b-cdn.net', cidPath: `${CID}/manifest.m3u8` });
    expect(parseS3Url(s3, `https://s3.3speak.tv/videos-test/${CID}/manifest.m3u8`)?.host).toBe('s3.3speak.tv');
    for (const bad of [
      `https://evil.test/videos-test/${CID}/manifest.m3u8`,
      `https://s3.3speak.tv/other-bucket/${CID}/manifest.m3u8`,
      `http://s3.3speak.tv/videos-test/${CID}/manifest.m3u8`,
      `https://s3.3speak.tv:8443/videos-test/${CID}/manifest.m3u8`,
      `https://s3.3speak.tv/videos-test/${CID}`,
      'not a url',
    ]) expect(parseS3Url(s3, bad)).toBeNull();
  });
});

describe('migratedFields', () => {
  it('writes exactly the migrator fields, with the zone URL the player expects', () => {
    const f = fields();
    expect(Object.keys(f).sort()).toEqual([...MIGRATOR_FIELDS].sort());
    expect(f).toEqual({
      storage_state: 'archived',
      s3_url: `https://buttercloud.b-cdn.net/videos-test/${CID}/manifest.m3u8`,
      s3_car_url: `https://s3.3speak.tv/videos-test/car/${CID}.car`,
      s3_bytes: 2281302,
      s3_files: 4,
      s3_migrated_at: new Date('2026-11-11T00:00:00Z'),
      s3_migrated_by: 'meno',
    });
  });

  it('mode hot keeps the hotnode as the source with S3 as backup', () => {
    expect(fields({ mode: 'hot' }).storage_state).toBe('hot');
    expect(() => fields({ mode: 'promoting' })).toThrow('unknown mode');
  });

  it('refuses nonsense totals and a missing author', () => {
    expect(() => fields({ bytes: 0 })).toThrow();
    expect(() => fields({ files: 1.5 })).toThrow();
    expect(() => fields({ by: '' })).toThrow();
  });
});

describe('filters', () => {
  const legacy = { _id: 'a1', video_v2: `ipfs://${CID}/manifest.m3u8`, status: 'published' };

  it('migrate: the document must be unchanged and still without s3_url', () => {
    expect(migrateFilter(COLLECTION.LEGACY, legacy)).toEqual({
      _id: 'a1', video_v2: legacy.video_v2, storage_state: { $exists: false }, s3_url: { $exists: false },
    });
    expect(migrateFilter(COLLECTION.EMBED, { _id: 'e1', manifest_cid: CID, storage_state: 'hot' })).toEqual({
      _id: 'e1', manifest_cid: CID, storage_state: 'hot', s3_url: { $exists: false },
    });
    expect(() => migrateFilter(COLLECTION.LEGACY, { _id: 'x', video_v2: CID })).toThrow('not migratable');
  });

  it('revert: only our own migration, as we left it, and unsets only our fields', () => {
    const at = new Date();
    const doc = { _id: 'a1', storage_state: 'archived', s3_url: 'u', s3_migrated_at: at };
    expect(revertFilter(doc)).toEqual({ _id: 'a1', storage_state: 'archived', s3_url: 'u', s3_migrated_at: at });
    expect(() => revertFilter({ _id: 'a1', storage_state: 'archived', s3_url: 'u' })).toThrow('not migrated by the migrator');
    expect(Object.keys(revertUpdate().$unset).sort()).toEqual([...MIGRATOR_FIELDS].sort());
  });

  it('fieldConflicts ignores storage_state, reports the rest', () => {
    expect(fieldConflicts({ storage_state: 'hot' })).toEqual([]);
    expect(fieldConflicts({ s3_url: 'x', s3_bytes: 1 })).toEqual(['s3_url', 's3_bytes']);
  });
});

// Drift guard: when the player repo sits next to this one, run our URLs through the
// player's own s3Parts. Skipped elsewhere (e.g. on the VPS).
const PLAYER = path.resolve(import.meta.dirname, '../../SnapieVideoPlayer/hlsGateways.js');
describe.skipIf(!fs.existsSync(PLAYER))('cross-check with the player (SnapieVideoPlayer/hlsGateways.js)', () => {
  const load = () => {
    process.env.S3_BUCKET = s3.bucket;
    process.env.S3_CDN_HOST = s3.cdnHost;
    const require = createRequire(import.meta.url);
    delete require.cache[PLAYER];
    return require(PLAYER);
  };

  it('the player accepts our s3_url and ties it to the same CID', () => {
    const player = load();
    expect(player.S3_BUCKET).toBe(s3.bucket);
    expect(player.S3_CDN_HOST).toBe(s3.cdnHost);
    for (const manifestPath of ['manifest.m3u8', 'hls/master.m3u8']) {
      const { s3_url } = fields({ manifestPath });
      const parts = player.s3Parts(s3_url);
      expect(parts).toEqual({ host: s3.cdnHost, cidPath: `${CID}/${manifestPath}` });
      expect(parts.cidPath.split('/')[0]).toBe(CID);   // storagePlan's CID check
    }
  });

  it('agrees with the player on URLs it rejects', () => {
    const player = load();
    for (const url of [
      `https://s3.3speak.tv/videos-test/${CID2}/manifest.m3u8`,
      `https://evil.test/videos-test/${CID}/manifest.m3u8`,
      `https://s3.3speak.tv/other/${CID}/manifest.m3u8`,
      `https://s3.3speak.tv/videos-test/${CID}`,
    ]) expect(parseS3Url(s3, url)).toEqual(player.s3Parts(url));
  });
});
