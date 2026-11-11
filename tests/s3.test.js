import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CACHE_CONTROL, MIN_PART_SIZE, contentTypeOf, createBucket, createS3Client, etagFor, expectedEtag } from '../src/s3.js';
import { startFakeS3 } from './helpers/fakeS3.js';

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const bytes = (n, seed = 1) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 13 + seed) & 0xff; return b; };
async function* chunked(buf, size = 100_000) { for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size); }

let fake, bucket;
const s3cfg = (endpoint) => ({ endpoint, region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's', bucket: 'videos-test' });

beforeAll(async () => {
  fake = await startFakeS3({ pageSize: 2 });
  bucket = createBucket(s3cfg(fake.endpoint), { partSize: MIN_PART_SIZE, client: createS3Client(s3cfg(fake.endpoint)) });
});
afterAll(() => fake.close());
beforeEach(() => { fake.objects.clear(); Object.assign(fake.faults, { corruptPut: false, failPuts: 0, wrongEtag: false }); });

describe('upload', () => {
  it('a small file is one PUT with Content-MD5, its type and an immutable cache header', async () => {
    const body = bytes(1234);
    const r = await bucket.upload({ key: 'Qm1/480p/480p_0.ts', size: body.length, chunks: chunked(body, 100) });
    expect(r.etag).toBe(md5(body));
    const o = fake.get('videos-test', 'Qm1/480p/480p_0.ts');
    expect(o.body.equals(body)).toBe(true);
    expect(o.type).toBe('video/mp2t');
    expect(o.cache).toBe(CACHE_CONTROL);
  });

  it('a large file goes up as multipart and its ETag is predicted exactly', async () => {
    const body = bytes(MIN_PART_SIZE * 2 + 777, 3);
    let progressed = 0;
    const r = await bucket.upload({ key: 'car/Qm1.car', size: body.length, chunks: chunked(body), onBytes: (n) => { progressed += n; } });
    const o = fake.get('videos-test', 'car/Qm1.car');
    expect(o.body.equals(body)).toBe(true);
    expect(o.etag).toMatch(/-3$/);
    expect(r.etag).toBe(o.etag);
    expect(await etagFor(chunked(body), body.length, MIN_PART_SIZE)).toBe(o.etag);
    expect(progressed).toBe(body.length);
    expect(o.type).toBe('application/vnd.ipld.car');
  });

  it('fails when S3 stores something other than what was sent', async () => {
    fake.faults.wrongEtag = true;
    const body = bytes(500);
    await expect(bucket.upload({ key: 'Qm1/x.ts', size: 500, chunks: chunked(body) })).rejects.toThrow(/answered ETag/);
  });

  it('fails when the source yields fewer bytes than announced', async () => {
    await expect(bucket.upload({ key: 'Qm1/short.ts', size: 999, chunks: chunked(bytes(500)) })).rejects.toThrow(/read 500 bytes, expected 999/);
  });

  it('retries a 500 from the gateway', async () => {
    fake.faults.failPuts = 1;
    const body = bytes(300);
    await expect(bucket.upload({ key: 'Qm1/retry.ts', size: 300, chunks: chunked(body) })).resolves.toEqual({ etag: md5(body) });
  });

  it('aborts an unfinished multipart upload on failure', async () => {
    const body = bytes(MIN_PART_SIZE + 10);
    await expect(bucket.upload({ key: 'car/bad.car', size: body.length + 5, chunks: chunked(body) })).rejects.toThrow();
    expect(fake.uploads.size).toBe(0);
    expect(fake.get('videos-test', 'car/bad.car')).toBeUndefined();
  });

  it('refuses a part size below the S3 minimum', () => {
    expect(() => createBucket(s3cfg(fake.endpoint), { partSize: 1024 })).toThrow('at least');
  });
});

describe('list / head', () => {
  it('lists every page of a prefix with sizes and ETags', async () => {
    for (const k of ['a', 'b', 'c', 'd', 'e']) await bucket.upload({ key: `Qm2/${k}.ts`, size: 3, chunks: chunked(Buffer.from(k.repeat(3))) });
    await bucket.upload({ key: 'Qm3/other.ts', size: 1, chunks: chunked(Buffer.from('z')) });
    const m = await bucket.list('Qm2/');
    expect([...m.keys()]).toEqual(['Qm2/a.ts', 'Qm2/b.ts', 'Qm2/c.ts', 'Qm2/d.ts', 'Qm2/e.ts']);
    expect(m.get('Qm2/c.ts')).toEqual({ size: 3, etag: md5(Buffer.from('ccc')) });
  });

  it('head returns size and ETag, or null', async () => {
    await bucket.upload({ key: 'Qm4/m.m3u8', size: 2, chunks: chunked(Buffer.from('#E')) });
    expect(await bucket.head('Qm4/m.m3u8')).toEqual({ size: 2, etag: md5(Buffer.from('#E')) });
    expect(await bucket.head('Qm4/nope')).toBeNull();
  });
});

describe('helpers', () => {
  it('content types for HLS and friends', () => {
    expect(contentTypeOf('a/manifest.m3u8')).toBe('application/vnd.apple.mpegurl');
    expect(contentTypeOf('a/thumb.JPG')).toBe('image/jpeg');
    expect(contentTypeOf('a/unknown.bin')).toBe('application/octet-stream');
  });

  it('expectedEtag: plain MD5 for one part, MD5-of-MD5s-N for several', () => {
    const a = md5(Buffer.from('a'));
    expect(expectedEtag([a])).toBe(a);
    expect(expectedEtag([a, a])).toMatch(/^[0-9a-f]{32}-2$/);
  });
});
