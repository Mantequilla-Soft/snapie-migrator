/**
 * The fields SnapieVideoPlayer reads to choose where a video plays from, and how the
 * migrator writes them. Mirrors, in SnapieVideoPlayer:
 *   - server.js  getVideoUrlsForLegacyStatus / getVideoUrlsForEmbedStatus (where the
 *                CID comes from) and storagePlan (storage_state + s3_url → source)
 *   - hlsGateways.js  s3Parts (what counts as one of our S3 URLs)
 * If the player changes any of these, change this file with it. The cross-check test
 * (tests/playerContract.test.js) loads the player's own s3Parts when it is next door.
 *
 * Rules (SPEC §1): we only ADD fields. video_v2, manifest_cid, status and every other
 * existing field are never written.
 */

export const COLLECTION = Object.freeze({ LEGACY: 'legacy', EMBED: 'embed' });

export const STORAGE_STATE = Object.freeze({ HOT: 'hot', ARCHIVED: 'archived', PROMOTING: 'promoting' });

// Every field the migrator owns. Revert unsets exactly these; nothing else.
export const MIGRATOR_FIELDS = Object.freeze([
  'storage_state',
  's3_url',
  's3_car_url',
  's3_bytes',
  's3_files',
  's3_migrated_at',
  's3_migrated_by',
]);

// The source field per collection: the value we read, and later require unchanged.
export const SOURCE_FIELD = Object.freeze({ [COLLECTION.LEGACY]: 'video_v2', [COLLECTION.EMBED]: 'manifest_cid' });

// The player's CID regex in storagePlan: `ipfs://<cid>` up to the first / ? or #.
const IPFS_URL_RE = /^ipfs:\/\/([^/?#]+)(?:\/([^?#]*))?$/;
// CIDv0 (Qm…, base58btc) or CIDv1 (b…, base32 lower). Anything else is not a CID we can fetch.
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/;

/**
 * Where a document's video lives on IPFS, as the player sees it.
 * → { cid, manifestPath, field, value } or { reason } when the player could not
 *   serve this video from S3 even if we copied it.
 */
export function sourceOf(collection, doc) {
  const field = SOURCE_FIELD[collection];
  if (!field) throw new Error(`unknown collection ${collection}`);
  const value = doc?.[field];

  if (collection === COLLECTION.EMBED) {
    if (typeof value !== 'string' || !value) return { reason: 'no manifest_cid' };
    if (!CID_RE.test(value)) return { reason: `manifest_cid "${value}" is not a CID` };
    // The player always plays `ipfs://<manifest_cid>/manifest.m3u8`.
    return { cid: value, manifestPath: 'manifest.m3u8', field, value };
  }

  if (typeof value !== 'string' || !value) return { reason: 'no video_v2 (dead video)' };
  const m = value.match(IPFS_URL_RE);
  // storagePlan only finds a CID in `ipfs://…`; a bare CID or an https source keeps
  // playing from IPFS whatever we write, so copying it would change nothing.
  if (!m) return { reason: 'video_v2 is not an ipfs:// URL (the player cannot serve it from S3)' };
  const cid = m[1];
  if (!CID_RE.test(cid)) return { reason: `video_v2 CID "${cid}" is not a CID` };
  // `ipfs://<cid>` with no file: the player appends manifest.m3u8.
  const manifestPath = (m[2] || '').replace(/^\/+|\/+$/g, '') || 'manifest.m3u8';
  if (manifestPath.split('/').some((seg) => seg === '..' || seg === '.')) {
    return { reason: `video_v2 path "${manifestPath}" is not a plain path` };
  }
  return { cid, manifestPath, field, value };
}

/** Object key of a file inside the copied directory: `<cid>/<path>`. */
export const objectKey = (cid, path) => `${cid}/${path}`;
/** Object key of the CAR export: outside the `<cid>/` folder the player serves. */
export const carKey = (cid) => `car/${cid}.car`;

const objectUrl = (host, bucket, key) =>
  `https://${host}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;

/**
 * Same rule as the player's s3Parts: `https://<cdn or direct host>/<bucket>/<cid>/<file>`,
 * read from the parsed URL. → { host, cidPath } or null.
 */
export function parseS3Url(s3, url) {
  let u;
  try { u = new URL(url); } catch (_) { return null; }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.port || u.username || u.password) return null;
  if (host !== s3.cdnHost && host !== s3.directHost) return null;
  const prefix = `/${s3.bucket}/`;
  if (!u.pathname.startsWith(prefix)) return null;
  const cidPath = u.pathname.slice(prefix.length);
  return /^[^/]+\/./.test(cidPath) ? { host, cidPath } : null;
}

/** The fields to $set once a copy is verified (SPEC §1). */
export function migratedFields(s3, { cid, manifestPath, bytes, files, by, mode = STORAGE_STATE.ARCHIVED, now = new Date() }) {
  if (![STORAGE_STATE.ARCHIVED, STORAGE_STATE.HOT].includes(mode)) throw new Error(`unknown mode ${mode}`);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('bytes must be a positive integer');
  if (!Number.isSafeInteger(files) || files <= 0) throw new Error('files must be a positive integer');
  if (!by) throw new Error('by is required');
  const s3Url = objectUrl(s3.cdnHost, s3.bucket, objectKey(cid, manifestPath));
  const parsed = parseS3Url(s3, s3Url);
  // Belt and braces: never write a URL the player would reject or tie to another CID.
  if (!parsed || parsed.cidPath.split('/')[0] !== cid) throw new Error(`built s3_url ${s3Url} would not pass the player`);
  return {
    storage_state: mode,
    s3_url: s3Url,
    s3_car_url: objectUrl(s3.directHost, s3.bucket, carKey(cid)),
    s3_bytes: bytes,
    s3_files: files,
    s3_migrated_at: now,
    s3_migrated_by: by,
  };
}

/** Our fields already on the document (other than an expected storage_state). */
export function fieldConflicts(doc) {
  return MIGRATOR_FIELDS.filter((f) => f !== 'storage_state' && doc?.[f] !== undefined);
}

/**
 * Filter for the final update: the document must still be exactly what we read when
 * the job started (same source, same storage_state, still no s3_url). Zero matches
 * means someone changed it meanwhile, and we write nothing.
 */
export function migrateFilter(collection, doc) {
  const src = sourceOf(collection, doc);
  if (!src.cid) throw new Error(`not migratable: ${src.reason}`);
  return {
    _id: doc._id,
    [src.field]: src.value,
    storage_state: doc.storage_state === undefined ? { $exists: false } : doc.storage_state,
    s3_url: { $exists: false },
  };
}

/** Revert only a migration of ours that is still as we left it. */
export function revertFilter(doc) {
  if (doc?.s3_migrated_at === undefined || !doc.s3_url) throw new Error('not migrated by the migrator');
  return { _id: doc._id, storage_state: doc.storage_state, s3_url: doc.s3_url, s3_migrated_at: doc.s3_migrated_at };
}

export const revertUpdate = () => ({ $unset: Object.fromEntries(MIGRATOR_FIELDS.map((f) => [f, ''])) });
