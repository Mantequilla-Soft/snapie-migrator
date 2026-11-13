/**
 * A channel's videos from both collections, and which of them can be migrated.
 *
 * "Ready" mirrors SnapieVideoPlayer/server.js: the statuses for which
 * getVideoUrlsForLegacyStatus / getVideoUrlsForEmbedStatus serve the real video (not
 * a placeholder). Only those are worth copying (SPEC §3 step 1).
 */
import { ObjectId } from 'mongodb';
import { HIVE_USER_RE } from './config.js';
import { COLLECTION, STORAGE_STATE, fieldConflicts, parseS3Url, sourceOf } from './playerContract.js';

// SnapieVideoPlayer/videoStatus.js, "Ready statuses" (legacy branch of server.js).
export const LEGACY_READY = Object.freeze(['published', 'publish_later', 'publish_manual', 'scheduled']);
// Embed branch: only `published` with a manifest_cid.
export const EMBED_READY = Object.freeze(['published']);

export const STORAGE = Object.freeze({ IPFS: 'ipfs', HOT: 'hot', ARCHIVED: 'archived', OTHER: 'other' });

// Same as the player's storyExpiresAt / isExpiredStory: an expired story plays a
// placeholder clip, so its video is never shown again.
export function isExpiredStory(doc, now) {
  if (doc?.story !== true || !doc.story_expires_at) return false;
  const at = new Date(doc.story_expires_at);
  return !Number.isNaN(at.getTime()) && at.getTime() <= now.getTime();
}

/** Where the player currently plays it from, for the table's "storage" column. */
export function storageOf(doc, s3) {
  const state = doc?.storage_state;
  if (state === undefined || state === null) return STORAGE.IPFS;
  if (state === STORAGE_STATE.HOT) return doc.s3_url ? STORAGE.HOT : STORAGE.IPFS;
  if (state === STORAGE_STATE.ARCHIVED && parseS3Url(s3, doc.s3_url)) return STORAGE.ARCHIVED;
  return STORAGE.OTHER;
}

/**
 * Can this document be migrated now? → { eligible, reason?, cid?, manifestPath? }
 * `reason` is shown as the tooltip on a greyed-out row.
 */
export function eligibility(collection, doc, { now = new Date() } = {}) {
  const status = String(doc?.status ?? '').toLowerCase();
  const ready = collection === COLLECTION.LEGACY ? LEGACY_READY : EMBED_READY;
  if (!ready.includes(status)) return { eligible: false, reason: `status "${doc?.status ?? 'none'}" is not ready` };
  if (collection === COLLECTION.EMBED && isExpiredStory(doc, now)) return { eligible: false, reason: 'expired story' };

  const src = sourceOf(collection, doc);
  if (!src.cid) return { eligible: false, reason: src.reason };

  const state = doc.storage_state;
  if (state === STORAGE_STATE.ARCHIVED) return { eligible: false, reason: 'already archived in S3', cid: src.cid };
  if (state === STORAGE_STATE.PROMOTING) return { eligible: false, reason: 'being promoted to the hotnode', cid: src.cid };
  if (state === STORAGE_STATE.HOT && doc.s3_url) return { eligible: false, reason: 'already has an S3 copy (hot)', cid: src.cid };
  if (state !== undefined && state !== null && state !== STORAGE_STATE.HOT) {
    return { eligible: false, reason: `unknown storage_state "${state}"`, cid: src.cid };
  }
  const conflicts = fieldConflicts(doc);
  if (conflicts.length) return { eligible: false, reason: `already has ${conflicts.join(', ')}`, cid: src.cid };

  return { eligible: true, cid: src.cid, manifestPath: src.manifestPath };
}

const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

// Display fields differ per collection; fall back across the known spellings.
function rowOf(collection, doc, ctx) {
  const e = eligibility(collection, doc, ctx);
  return {
    collection,
    id: String(doc._id),
    owner: doc.owner,
    permlink: doc.permlink ?? null,
    title: doc.title || doc.hive_title || doc.permlink || '(untitled)',
    status: doc.status ?? null,
    created: doc.created ?? doc.createdAt ?? doc.created_at ?? null,
    thumbnail: doc.thumbnail ?? doc.thumbnail_url ?? null,
    size: num(doc.size) ?? num(doc.file_size) ?? num(doc.s3_bytes),
    storage: storageOf(doc, ctx.s3),
    cid: e.cid ?? null,
    eligible: e.eligible,
    reason: e.reason ?? null,
    migratedAt: doc.s3_migrated_at ?? null,
  };
}

// Only what the table and the eligibility check need (never the whole document).
const PROJECTION = {
  owner: 1, permlink: 1, title: 1, hive_title: 1, status: 1, created: 1, createdAt: 1, created_at: 1,
  thumbnail: 1, thumbnail_url: 1, size: 1, file_size: 1, video_v2: 1, manifest_cid: 1, story: 1,
  story_expires_at: 1, storage_state: 1, s3_url: 1, s3_car_url: 1, s3_bytes: 1, s3_files: 1,
  s3_migrated_at: 1, s3_migrated_by: 1,
};

/**
 * Every video of `owner` in both collections, newest first.
 * `db` is a connected mongodb Db; `cfg` the loaded config.
 */
export async function listChannel(db, cfg, owner, { now = new Date() } = {}) {
  const user = String(owner ?? '').trim().toLowerCase();
  if (!HIVE_USER_RE.test(user)) throw new TypeError(`"${owner}" is not a Hive account name`);
  const ctx = { s3: cfg.s3, now };
  const [legacy, embed] = await Promise.all([
    db.collection(cfg.mongo.legacyCollection).find({ owner: user }, { projection: PROJECTION }).toArray(),
    db.collection(cfg.mongo.embedCollection).find({ owner: user }, { projection: PROJECTION }).toArray(),
  ]);
  const rows = [
    ...legacy.map((d) => rowOf(COLLECTION.LEGACY, d, ctx)),
    ...embed.map((d) => rowOf(COLLECTION.EMBED, d, ctx)),
  ];
  const t = (r) => (r.created ? new Date(r.created).getTime() || 0 : 0);
  return rows.sort((a, b) => t(b) - t(a));
}

/** Re-read one document right before acting on it (SPEC §3 step 1). */
export async function loadVideo(db, cfg, collection, id) {
  const name = collection === COLLECTION.LEGACY ? cfg.mongo.legacyCollection
    : collection === COLLECTION.EMBED ? cfg.mongo.embedCollection : null;
  if (!name) throw new TypeError(`unknown collection ${collection}`);
  const _id = ObjectId.isValid(id) && String(new ObjectId(id)) === String(id) ? new ObjectId(id) : id;
  return db.collection(name).findOne({ _id });
}
