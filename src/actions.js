/**
 * Check IPFS and Revert (SPEC §6), run through the queue like migrations, so they
 * share its concurrency limit, progress, history and restart handling.
 *
 * "Live on IPFS" is asked of the permanent nodes only (IPFS_GATEWAYS, not the
 * hotnode, which unpins): the CAR must download from one of them and pass the same
 * checks as a migration (root, every block hash, full walk, manifest present).
 * Revert runs that check first, every time, then removes only the migrator's fields
 * from a document still exactly as the migrator left it. S3 objects are never deleted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { downloadCar, openVerifiedCar } from './car.js';
import { loadVideo } from './catalog.js';
import { ChangedError, NotEligibleError, VerifyError, throwIfAborted } from './errors.js';
import { COLLECTION, revertFilter, revertUpdate, sourceOf } from './playerContract.js';
import { runItem } from './pipeline.js';

export const KIND = Object.freeze({ MIGRATE: 'migrate', CHECK: 'check', REVERT: 'revert' });

const collectionName = (cfg, collection) =>
  collection === COLLECTION.LEGACY ? cfg.mongo.legacyCollection : cfg.mongo.embedCollection;

/** Download from the permanent IPFS nodes and verify. → { cid, gateway, blocks, files, bytes, attempts } */
export async function checkLive({ cfg, budget, throttle, fetchImpl }, { cid, manifestPath, itemId, signal, onProgress = () => {} }) {
  const dest = path.join(cfg.workDir, `item-${itemId}.car`);
  let car = null;
  let bytes = 0;
  try {
    await budget.assertCanStart();
    onProgress({ stage: 'download', cid });
    const dl = await downloadCar({
      cid, gateways: cfg.ipfsGateways, dest, budget, throttle, signal, fetchImpl,
      onProgress: (p) => onProgress({ stage: 'download', cid, bytesDone: p.bytes }),
    });
    bytes = dl.bytes;
    onProgress({ stage: 'verify', cid });
    car = await openVerifiedCar(dest, cid, { signal, onProgress: (p) => onProgress({ stage: 'verify', cid, ...p }) });
    if (!car.files.some((f) => f.path === manifestPath)) throw new VerifyError(`${manifestPath} is not in ${cid}`);
    return { cid, gateway: dl.gateway, blocks: car.blocks, files: car.files.length, bytes: car.bytes, attempts: dl.attempts };
  } finally {
    if (car) await car.close().catch(() => {});
    await fs.promises.rm(dest, { force: true }).catch(() => {});
    if (bytes) budget.release(bytes);
  }
}

async function resolve(deps, item) {
  const doc = await loadVideo(deps.db, deps.cfg, item.collection, item.docId);
  if (!doc) throw new ChangedError('the video no longer exists in Mongo');
  const src = sourceOf(item.collection, doc);
  if (!src.cid) throw new NotEligibleError(src.reason);
  return { doc, src };
}

export async function runCheck(item, deps, { signal, onProgress = () => {} } = {}) {
  onProgress({ stage: 'resolve' });
  const { src } = await resolve(deps, item);
  const live = await checkLive(deps, { cid: src.cid, manifestPath: src.manifestPath, itemId: item.id, signal, onProgress });
  onProgress({ stage: 'done', cid: src.cid });
  return { cid: src.cid, live: true, ...live, warnings: live.attempts.map((a) => `${a.gateway} failed: ${a.error}`) };
}

export async function runRevert(item, deps, { signal, onProgress = () => {} } = {}) {
  onProgress({ stage: 'resolve' });
  const { doc, src } = await resolve(deps, item);
  if (doc.s3_migrated_at === undefined) throw new NotEligibleError('not migrated by the migrator; nothing to revert');
  const filter = revertFilter(doc);
  const live = await checkLive(deps, { cid: src.cid, manifestPath: src.manifestPath, itemId: item.id, signal, onProgress });
  throwIfAborted(signal);
  onProgress({ stage: 'mongo', cid: src.cid });
  const r = await deps.db.collection(collectionName(deps.cfg, item.collection)).updateOne(filter, revertUpdate());
  if (r.matchedCount !== 1) throw new ChangedError('the video changed in Mongo meanwhile; nothing was reverted');
  onProgress({ stage: 'done', cid: src.cid });
  return { cid: src.cid, reverted: true, live, warnings: [] };
}

/** The queue's run function: one entry point for every kind of item. */
export function runAny(item, deps, opts) {
  switch (item.kind ?? KIND.MIGRATE) {
    case KIND.MIGRATE: return runItem(item, deps, opts);
    case KIND.CHECK: return runCheck(item, deps, opts);
    case KIND.REVERT: return runRevert(item, deps, opts);
    default: throw new Error(`unknown item kind ${item.kind}`);
  }
}
