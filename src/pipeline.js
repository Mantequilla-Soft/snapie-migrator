/**
 * One video, start to finish (SPEC §3). A video is DONE only when:
 *   the CAR is verified (root, every block, full walk)            → step 4
 *   S3 holds exactly those files and the CAR, byte for byte       → step 6
 *   viewers can fetch them through the zone and the direct host   → step 6
 *   the conditional Mongo update matched                          → step 7
 * Step 8 (asking the player) is reported, but a failure there means config, not data.
 * The local CAR is deleted on every way out.
 */
import fs from 'node:fs';
import path from 'node:path';
import { downloadCar, openVerifiedCar } from './car.js';
import { eligibility, loadVideo } from './catalog.js';
import { ChangedError, NotEligibleError, VerifyError, throwIfAborted } from './errors.js';
import { COLLECTION, STORAGE_STATE, carKey, migrateFilter, migratedFields, objectKey, sourceOf } from './playerContract.js';
import { planReadback, readBack } from './readback.js';
import { etagFor } from './s3.js';

export const STAGES = Object.freeze(['resolve', 'download', 'verify', 'upload', 'check', 'mongo', 'player', 'done']);

const collectionName = (cfg, collection) =>
  collection === COLLECTION.LEGACY ? cfg.mongo.legacyCollection : cfg.mongo.embedCollection;

async function* fileChunks(p) {
  yield* fs.createReadStream(p, { highWaterMark: 1024 * 1024 });
}

/** Did a previous run of this item already finish the Mongo step? (crash after step 7) */
function alreadyOurs(doc, expectedUrl) {
  return doc?.s3_migrated_at !== undefined && doc.s3_url === expectedUrl;
}

/**
 * Ask the player what it now serves. → { ok, detail }
 * Archived: videoUrl must go through /hls with u=<our zone URL> and s3=1.
 * Hot: still the hotnode, but with s3=1 (S3 is the backup).
 */
export async function playerCheck({ playerBaseUrl, owner, permlink, fields, fetchImpl = fetch, timeoutMs = 30_000 }) {
  const url = `${playerBaseUrl}/api/watch?v=${encodeURIComponent(owner)}/${encodeURIComponent(permlink)}`;
  let body;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 200) return { ok: false, detail: `player answered HTTP ${res.status}` };
    body = await res.json();
  } catch (e) {
    return { ok: false, detail: `player unreachable: ${e.message}` };
  }
  let hls;
  try { hls = new URL(body.videoUrl); } catch (_) { return { ok: false, detail: `player videoUrl is ${JSON.stringify(body.videoUrl)}` }; }
  if (hls.searchParams.get('s3') !== '1') return { ok: false, detail: 'player does not know about the S3 copy (no s3=1): check its S3_BUCKET' };
  if (fields.storage_state === STORAGE_STATE.ARCHIVED && hls.searchParams.get('u') !== fields.s3_url) {
    return { ok: false, detail: `player plays ${hls.searchParams.get('u')}, expected ${fields.s3_url}` };
  }
  return { ok: true, detail: fields.storage_state === STORAGE_STATE.ARCHIVED ? 'player serves the S3 zone' : 'player keeps the hotnode, S3 as backup' };
}

/**
 * Run one item. `item` = { id, collection, docId, mode, by }.
 * deps = { cfg, db, bucket, budget, throttle, fetchImpl, now }
 * → { cid, bytes, files, carBytes, gateway, uploaded, skipped, warnings, fields, player, resumed }
 */
export async function runItem(item, deps, { signal, onProgress = () => {} } = {}) {
  const { cfg, db, bucket, budget, throttle, fetchImpl = fetch, now = () => new Date() } = deps;
  const mode = item.mode ?? STORAGE_STATE.ARCHIVED;
  const stage = (name, extra = {}) => onProgress({ stage: name, ...extra });
  const warnings = [];
  const dest = path.join(cfg.workDir, `item-${item.id}.car`);
  let car = null;
  let carBytes = 0;

  try {
    // 1. resolve: re-read the document, it may have changed since it was queued
    stage('resolve');
    const doc = await loadVideo(db, cfg, item.collection, item.docId);
    if (!doc) throw new ChangedError('the video no longer exists in Mongo');
    const src = sourceOf(item.collection, doc);
    if (src.cid) {
      const expected = migratedFields(cfg.s3, { cid: src.cid, manifestPath: src.manifestPath, bytes: 1, files: 1, by: '-', mode }).s3_url;
      if (alreadyOurs(doc, expected)) {
        stage('done');
        return { cid: src.cid, resumed: true, warnings: ['already migrated (a previous run finished the Mongo step)'] };
      }
    }
    const e = eligibility(item.collection, doc, { now: now() });
    if (!e.eligible) throw new NotEligibleError(e.reason);
    const { cid, manifestPath } = e;

    // 2. room on disk
    await budget.assertCanStart();
    throwIfAborted(signal);

    // 3. download the CAR
    stage('download', { cid });
    const dl = await downloadCar({
      cid, gateways: cfg.sourceGateways, dest, budget, throttle, signal, fetchImpl,
      onProgress: ({ bytes }) => stage('download', { cid, bytesDone: bytes }),
    });
    carBytes = dl.bytes;
    for (const a of dl.attempts) warnings.push(`${a.gateway} failed: ${a.error}`);

    // 4. verify
    stage('verify', { cid });
    car = await openVerifiedCar(dest, cid, { signal, onProgress: (p) => stage('verify', { cid, ...p }) });
    const filesByPath = new Map(car.files.map((f) => [f.path, f]));
    if (!filesByPath.has(manifestPath)) throw new VerifyError(`${manifestPath} is not in ${cid}: the player could not play it`);

    // 5. upload what isn't there yet (a resumed item skips what it already sent)
    const existing = await bucket.list(`${cid}/`, { signal });
    const wanted = new Map();
    for (const f of car.files) {
      const etag = f.size <= bucket.partSize ? f.md5 : await etagFor(car.readFile(f), f.size, bucket.partSize);
      wanted.set(objectKey(cid, f.path), { file: f, etag });
    }
    const extra = [...existing.keys()].filter((k) => !wanted.has(k));
    if (extra.length) throw new VerifyError(`S3 already has ${extra.length} object(s) under ${cid}/ that are not in the video (e.g. ${extra[0]})`);
    const carEtag = await etagFor(fileChunks(dest), carBytes, bucket.partSize);

    const totalBytes = car.bytes + carBytes;
    let sentBytes = 0;
    let uploaded = 0;
    let skipped = 0;
    const tick = () => stage('upload', { cid, bytesDone: sentBytes, bytesTotal: totalBytes, filesDone: uploaded + skipped, filesTotal: wanted.size + 1 });
    for (const [key, { file, etag }] of wanted) {
      throwIfAborted(signal);
      const have = existing.get(key);
      if (have && have.size === file.size && have.etag === etag) { skipped++; sentBytes += file.size; tick(); continue; }
      await bucket.upload({ key, size: file.size, chunks: car.readFile(file), signal, onBytes: (n) => { sentBytes += n; tick(); } });
      uploaded++;
      tick();
    }
    const haveCar = await bucket.head(carKey(cid), { signal });
    if (haveCar && haveCar.size === carBytes && haveCar.etag === carEtag) { skipped++; sentBytes += carBytes; }
    else {
      await bucket.upload({ key: carKey(cid), size: carBytes, chunks: fileChunks(dest), signal, onBytes: (n) => { sentBytes += n; tick(); } });
      uploaded++;
    }
    tick();

    // 6. check: exactly these objects, byte for byte, and fetchable by viewers
    stage('check', { cid });
    const after = await bucket.list(`${cid}/`, { signal });
    if (after.size !== wanted.size) throw new VerifyError(`S3 lists ${after.size} objects under ${cid}/, expected ${wanted.size}`);
    for (const [key, { file, etag }] of wanted) {
      const o = after.get(key);
      if (!o) throw new VerifyError(`${key} is missing from S3`);
      if (o.size !== file.size || o.etag !== etag) throw new VerifyError(`${key} in S3 differs (size ${o.size}/${file.size}, etag ${o.etag}/${etag})`);
    }
    const carObj = await bucket.head(carKey(cid), { signal });
    if (!carObj || carObj.size !== carBytes || carObj.etag !== carEtag) throw new VerifyError(`${carKey(cid)} in S3 differs or is missing`);

    const readText = async (p) => {
      const chunks = [];
      for await (const c of car.readFile(filesByPath.get(p))) chunks.push(c);
      return Buffer.concat(chunks).toString('utf8');
    };
    const plan = await planReadback(manifestPath, filesByPath, readText);
    warnings.push(...plan.warnings);
    await readBack({ s3: cfg.s3, cid, paths: plan.paths, filesByPath, fetchImpl, signal, onProgress: (p) => stage('check', { cid, ...p }) });

    // 7. Mongo, only if the document is still exactly as we read it. Not cancellable.
    throwIfAborted(signal);
    stage('mongo', { cid });
    const fields = migratedFields(cfg.s3, { cid, manifestPath, bytes: car.bytes, files: car.files.length, by: item.by, mode, now: now() });
    const r = await db.collection(collectionName(cfg, item.collection)).updateOne(migrateFilter(item.collection, doc), { $set: fields });
    if (r.matchedCount !== 1) throw new ChangedError('the video changed in Mongo during the migration; nothing was written (the S3 copy stays)');

    // 8. ask the player (optional)
    let player = null;
    if (cfg.playerBaseUrl && doc.permlink) {
      stage('player', { cid });
      player = await playerCheck({ playerBaseUrl: cfg.playerBaseUrl, owner: doc.owner, permlink: doc.permlink, fields, fetchImpl });
      if (!player.ok) warnings.push(`player check: ${player.detail}`);
    }

    stage('done', { cid });
    return { cid, bytes: car.bytes, files: car.files.length, carBytes, gateway: dl.gateway, uploaded, skipped, warnings, fields, player, resumed: false };
  } finally {
    // 9. clean up, whatever happened
    if (car) await car.close().catch(() => {});
    await fs.promises.rm(dest, { force: true }).catch(() => {});
    if (carBytes) budget.release(carBytes);
  }
}
