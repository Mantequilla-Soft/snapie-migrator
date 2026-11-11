#!/usr/bin/env node
/**
 * Proves the real Buttercloud setup accepts what the migrator sends, before any video
 * is touched. Run on the VPS with the real .env:  npm run smoke:s3
 *
 *  1. a single PUT with Content-MD5           (how segments and playlists go up)
 *  2. a 2-part multipart upload               (how CARs and big files go up)
 *  3. ListObjectsV2 + HEAD: sizes and ETags as predicted
 *  4. public GET through the Bunny zone and s3.3speak.tv: same bytes, and the CORS
 *     header browsers need
 *
 * It writes ~9 MB under _smoke/<timestamp>/ and never deletes anything (the migrator
 * has no delete permission by design); remove those objects by hand if you like.
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { publicUrl } from '../src/readback.js';
import { DEFAULT_PART_SIZE, createBucket, etagFor } from '../src/s3.js';

const cfg = loadConfig();
const bucket = createBucket(cfg.s3);
const prefix = `_smoke/${new Date().toISOString().replace(/[:.]/g, '-')}/`;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const gen = (n, seed) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 131 + seed) & 0xff; return b; };
async function* once(b) { yield b; }

const objects = [
  { key: `${prefix}manifest.m3u8`, body: Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n') },
  { key: `${prefix}segment.ts`, body: gen(300_000, 1) },
  { key: `${prefix}big.car`, body: gen(DEFAULT_PART_SIZE + 1_000_000, 2) },   // 2 parts
];

let failed = 0;
const step = async (name, fn) => {
  try { const r = await fn(); console.log(`ok    ${name}${r ? `: ${r}` : ''}`); } catch (e) { failed++; console.log(`FAIL  ${name}: ${e.message}`); }
};

console.log(`bucket ${cfg.s3.bucket} via ${cfg.s3.endpoint}, prefix ${prefix}\n`);
for (const o of objects) {
  o.etag = await etagFor(once(o.body), o.body.length, bucket.partSize);
  await step(`upload ${o.key.slice(prefix.length)} (${o.body.length} bytes${o.body.length > bucket.partSize ? ', multipart' : ''})`,
    async () => (await bucket.upload({ key: o.key, size: o.body.length, chunks: once(o.body) })).etag);
}
await step('list: every object, sizes and ETags as predicted', async () => {
  const m = await bucket.list(prefix);
  for (const o of objects) {
    const got = m.get(o.key);
    if (!got) throw new Error(`${o.key} not listed`);
    if (got.size !== o.body.length || got.etag !== o.etag) throw new Error(`${o.key}: ${got.size}/${got.etag}, expected ${o.body.length}/${o.etag}`);
  }
  return `${m.size} objects`;
});
await step('head', async () => {
  const h = await bucket.head(objects[2].key);
  if (h?.etag !== objects[2].etag) throw new Error(`etag ${h?.etag}, expected ${objects[2].etag}`);
});
for (const host of [cfg.s3.cdnHost, cfg.s3.directHost]) {
  for (const o of objects.slice(0, 2)) {
    await step(`GET https://${host}/…/${o.key.slice(prefix.length)}`, async () => {
      const res = await fetch(publicUrl(host, cfg.s3.bucket, o.key), { headers: { Origin: 'https://play.3speak.tv' } });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      if (sha(body) !== sha(o.body)) throw new Error(`came back different (${body.length} bytes)`);
      const acao = res.headers.get('access-control-allow-origin');
      if (!acao) throw new Error('same bytes, but no Access-Control-Allow-Origin: browsers could not play it');
      return `content-type ${res.headers.get('content-type')}, ACAO ${acao}`;
    });
  }
}
console.log(failed ? `\n${failed} check(s) failed: fix these before migrating anything.` : '\nAll good: Buttercloud accepts what the migrator sends.');
process.exit(failed ? 1 : 0);
