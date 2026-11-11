/**
 * Buttercloud S3 access (SPEC §3 steps 5–6).
 *
 * Written for the Buttercloud gateway in front of MinIO, which reads each request
 * body fully into memory and forwards it with a 30 s timeout. So:
 *  - bodies are Buffers of at most `partSize` (default 8 MB), never open-ended streams;
 *  - objects above `partSize` go up as multipart, one buffered part at a time;
 *  - every PUT carries Content-MD5, so MinIO itself rejects a corrupted body;
 *  - the SDK's newer default checksums (aws-chunked streaming) are turned off,
 *    because a SigV4-validating gateway may not pass them through.
 * The expected ETag is computed locally for both kinds of upload (single: the MD5;
 * multipart: MD5 of the parts' MD5s + "-N"), so a listing alone proves every byte.
 */
import crypto from 'node:crypto';
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand,
  HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, UploadPartCommand,
} from '@aws-sdk/client-s3';
import { throwIfAborted } from './errors.js';

export const DEFAULT_PART_SIZE = 8 * 1024 * 1024;
export const MIN_PART_SIZE = 5 * 1024 * 1024;   // S3's minimum for every part but the last
export const CACHE_CONTROL = 'public, max-age=31536000, immutable';   // content-addressed: never changes

const TYPES = {
  m3u8: 'application/vnd.apple.mpegurl',
  ts: 'video/mp2t',
  m4s: 'video/iso.segment',
  mp4: 'video/mp4',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  vtt: 'text/vtt',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  json: 'application/json',
  car: 'application/vnd.ipld.car',
};
export const contentTypeOf = (key) => TYPES[key.split('.').pop()?.toLowerCase()] ?? 'application/octet-stream';

const unquote = (etag) => String(etag ?? '').replace(/^"+|"+$/g, '').toLowerCase();

/** The ETag S3 gives an object uploaded the way uploadObject() uploads it. */
export function expectedEtag(partMd5s) {
  if (partMd5s.length === 1) return partMd5s[0];
  const joined = Buffer.concat(partMd5s.map((h) => Buffer.from(h, 'hex')));
  return `${crypto.createHash('md5').update(joined).digest('hex')}-${partMd5s.length}`;
}

export function createS3Client(s3cfg) {
  return new S3Client({
    endpoint: s3cfg.endpoint,
    region: s3cfg.region,
    credentials: { accessKeyId: s3cfg.accessKeyId, secretAccessKey: s3cfg.secretAccessKey },
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 4,
  });
}

// Re-chunk an async iterable of Uint8Arrays into Buffers of exactly `size` (last may be shorter).
async function* rechunk(source, size) {
  let parts = [];
  let len = 0;
  for await (const chunk of source) {
    let c = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    while (c.length) {
      const take = Math.min(size - len, c.length);
      parts.push(c.subarray(0, take));
      len += take;
      c = c.subarray(take);
      if (len === size) { yield Buffer.concat(parts, len); parts = []; len = 0; }
    }
  }
  if (len) yield Buffer.concat(parts, len);
}

export function createBucket(s3cfg, { client = createS3Client(s3cfg), partSize = DEFAULT_PART_SIZE } = {}) {
  if (partSize < MIN_PART_SIZE) throw new Error(`part size must be at least ${MIN_PART_SIZE} bytes`);
  const Bucket = s3cfg.bucket;

  return {
    partSize,

    /** Every object under `prefix` → Map(key → { size, etag }). */
    async list(prefix, { signal } = {}) {
      const out = new Map();
      let ContinuationToken;
      do {
        const r = await client.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken }), { abortSignal: signal });
        for (const o of r.Contents ?? []) out.set(o.Key, { size: Number(o.Size), etag: unquote(o.ETag) });
        ContinuationToken = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (ContinuationToken);
      return out;
    },

    /** → { size, etag } or null when the object does not exist. */
    async head(key, { signal } = {}) {
      try {
        const r = await client.send(new HeadObjectCommand({ Bucket, Key: key }), { abortSignal: signal });
        return { size: Number(r.ContentLength), etag: unquote(r.ETag) };
      } catch (e) {
        if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound' || e?.name === 'NoSuchKey') return null;
        throw e;
      }
    },

    /**
     * Upload `size` bytes from `chunks` (an async iterable) to `key`.
     * → { etag } — the ETag computed locally, already compared with what S3 returned.
     */
    async upload({ key, size, chunks, contentType = contentTypeOf(key), signal, onBytes = () => {} }) {
      const common = { Bucket, Key: key, ContentType: contentType, CacheControl: CACHE_CONTROL };
      const md5b64 = (buf) => crypto.createHash('md5').update(buf).digest('base64');
      const hex = (b64) => Buffer.from(b64, 'base64').toString('hex');

      if (size <= partSize) {
        const parts = [];
        for await (const p of rechunk(chunks, partSize)) parts.push(p);
        const body = Buffer.concat(parts);
        if (body.length !== size) throw new Error(`${key}: read ${body.length} bytes, expected ${size}`);
        const md5 = md5b64(body);
        throwIfAborted(signal);
        const r = await client.send(new PutObjectCommand({ ...common, Body: body, ContentLength: size, ContentMD5: md5 }), { abortSignal: signal });
        const etag = hex(md5);
        if (r.ETag && unquote(r.ETag) !== etag) throw new Error(`${key}: S3 answered ETag ${unquote(r.ETag)}, expected ${etag}`);
        onBytes(size);
        return { etag };
      }

      const { UploadId } = await client.send(new CreateMultipartUploadCommand(common), { abortSignal: signal });
      try {
        const done = [];
        const md5s = [];
        let sent = 0;
        for await (const part of rechunk(chunks, partSize)) {
          throwIfAborted(signal);
          const PartNumber = done.length + 1;
          const md5 = md5b64(part);
          const r = await client.send(new UploadPartCommand({
            Bucket, Key: key, UploadId, PartNumber, Body: part, ContentLength: part.length, ContentMD5: md5,
          }), { abortSignal: signal });
          md5s.push(hex(md5));
          done.push({ PartNumber, ETag: r.ETag ?? `"${hex(md5)}"` });
          sent += part.length;
          onBytes(part.length);
        }
        if (sent !== size) throw new Error(`${key}: read ${sent} bytes, expected ${size}`);
        const r = await client.send(new CompleteMultipartUploadCommand({ Bucket, Key: key, UploadId, MultipartUpload: { Parts: done } }), { abortSignal: signal });
        const etag = expectedEtag(md5s);
        if (r.ETag && unquote(r.ETag) !== etag) throw new Error(`${key}: S3 answered ETag ${unquote(r.ETag)}, expected ${etag}`);
        return { etag };
      } catch (e) {
        // Drops the unfinished parts only; a completed object is never touched.
        await client.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId })).catch(() => {});
        throw e;
      }
    },
  };
}

/** The ETag we expect for `size` bytes with these hashes, given the part size. */
export async function etagFor(chunks, size, partSize) {
  if (size <= partSize) {
    const h = crypto.createHash('md5');
    for await (const c of chunks) h.update(c);
    return h.digest('hex');
  }
  const md5s = [];
  for await (const p of rechunk(chunks, partSize)) md5s.push(crypto.createHash('md5').update(p).digest('hex'));
  return expectedEtag(md5s);
}
