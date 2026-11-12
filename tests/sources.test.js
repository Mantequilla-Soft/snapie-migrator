// The preview's verdict (public/sources.js): where the player really plays from.
import { describe, expect, it } from 'vitest';
import { classify, embedUrl, summarize } from '../public/sources.js';
import { CID } from './helpers/env.js';

const hosts = {
  bucket: 'videos-test',
  s3: [{ host: 'buttercloud.b-cdn.net', label: 'S3 zone' }, { host: 's3.3speak.tv', label: 'S3 direct' }],
  hot: ['hotipfs-3speak-1.b-cdn.net', 'hotipfs-1.3speak.tv'],
};
const ZONE = `https://buttercloud.b-cdn.net/videos-test/${CID}`;
const DIRECT = `https://s3.3speak.tv/videos-test/${CID}`;
const HOT = `https://hotipfs-3speak-1.b-cdn.net/ipfs/${CID}`;
const IPFS = `https://ipfs-3speak.b-cdn.net/ipfs/${CID}`;
const seg = (base, n = 0, over = {}) => ({ kind: 'segment', url: `${base}/480p/480p_${n}.ts`, ok: true, proxied: false, ...over });
const list = (base) => ({ kind: 'playlist', url: `${base}/manifest.m3u8`, ok: true, proxied: true });

describe('classify', () => {
  it('S3 only on our hosts and under our bucket', () => {
    expect(classify(`${ZONE}/a.ts`, hosts)).toMatchObject({ kind: 's3', label: 'S3 zone' });
    expect(classify(`${DIRECT}/a.ts`, hosts)).toMatchObject({ kind: 's3', label: 'S3 direct' });
    expect(classify(`https://s3.3speak.tv/someone-else/${CID}/a.ts`, hosts).kind).toBe('other');
    expect(classify(`https://evil.test/videos-test/${CID}/a.ts`, hosts).kind).toBe('other');
  });

  it('the hotnode, its zone, and any other /ipfs/ host as a gateway', () => {
    expect(classify(`${HOT}/a.ts`, hosts)).toMatchObject({ kind: 'hot', label: 'Hotnode (hotipfs-3speak-1.b-cdn.net)' });
    expect(classify(`https://hotipfs-1.3speak.tv/ipfs/${CID}/a.ts`, hosts).kind).toBe('hot');
    expect(classify(`${IPFS}/a.ts`, hosts)).toMatchObject({ kind: 'ipfs', label: 'IPFS gateway (ipfs-3speak.b-cdn.net)' });
    expect(classify('not a url', hosts)).toMatchObject({ kind: 'other', host: null });
  });
});

describe('embedUrl', () => {
  it('legacy videos use /watch, embed-video ones /embed, both framed', () => {
    expect(embedUrl('https://play.test', { collection: 'legacy', owner: 'coolmole', permlink: 'abc' })).toBe('https://play.test/watch?v=coolmole/abc&mode=iframe');
    expect(embedUrl('https://play.test', { collection: 'embed', owner: 'coolmole', permlink: 'a&b' })).toBe('https://play.test/embed?v=coolmole/a%26b&mode=iframe');
  });
});

describe('summarize', () => {
  it('waits until a segment loads', () => {
    expect(summarize([], hosts, 'archived').verdict.level).toBe('wait');
    expect(summarize([list(ZONE)], hosts, 'archived').verdict.level).toBe('wait');
    expect(summarize([seg(ZONE, 0, { ok: false })], hosts, 'archived').verdict).toEqual({ level: 'wait', text: 'No segment has loaded yet. 1 request failed.' });
  });

  it('archived, all from S3 (zone or direct): ok, grouped per source', () => {
    const s = summarize([list(ZONE), seg(ZONE, 0), seg(DIRECT, 1), seg(DIRECT, 2)], hosts, 'archived');
    expect(s.verdict).toEqual({ level: 'ok', text: 'Every segment so far came from S3 (3).' });
    expect(s.groups).toEqual([
      { label: 'S3 direct', kind: 's3', playlists: 0, segments: 2 },
      { label: 'S3 zone', kind: 's3', playlists: 1, segments: 1 },
    ]);
  });

  it('archived but nothing from S3: the fallback the preview is there to catch', () => {
    const s = summarize([seg(IPFS, 0), seg(HOT, 1, { proxied: true })], hosts, 'archived');
    expect(s.verdict.level).toBe('warn');
    expect(s.verdict.text).toBe("None of the 2 segments came from S3. The player fell back to IPFS for all of them, so the S3 copy may be broken or unreachable. 1 segment came through the player's server.");
  });

  it('archived with some segments from IPFS: noted, as S3 being slow for those', () => {
    const s = summarize([seg(ZONE, 0), seg(DIRECT, 1), seg(IPFS, 2)], hosts, 'archived');
    expect(s.verdict).toEqual({ level: 'info', text: '1 of 3 segments came from IPFS instead of S3: S3 was too slow for them when the player asked. The other 2 came from S3.' });
  });

  it('hot: the hotnode and S3 are both expected; gateways are noted', () => {
    expect(summarize([seg(HOT, 0), seg(ZONE, 1)], hosts, 'hot').verdict.level).toBe('ok');
    expect(summarize([seg(HOT, 0), seg(IPFS, 1)], hosts, 'hot').verdict).toMatchObject({ level: 'info', text: expect.stringMatching(/^1 of 2 segments came from IPFS/) });
  });

  it('ipfs: S3 would be wrong, since Mongo has no S3 copy', () => {
    expect(summarize([seg(IPFS, 0), seg(HOT, 1)], hosts, 'ipfs').verdict).toEqual({ level: 'ok', text: 'Every segment so far came from IPFS (2).' });
    expect(summarize([seg(IPFS, 0), seg(ZONE, 1)], hosts, 'ipfs').verdict.level).toBe('warn');
  });

  it('unknown storage only counts, and failures are reported but not counted as sources', () => {
    const s = summarize([seg(IPFS, 0), seg(IPFS, 1, { ok: false }), seg(IPFS, 2, { ok: false })], hosts, 'other');
    expect(s.verdict).toEqual({ level: 'info', text: '1 segment loaded. 2 requests failed.' });
    expect(s.failed).toBe(2);
    expect(s.segments).toBe(1);
  });
});
