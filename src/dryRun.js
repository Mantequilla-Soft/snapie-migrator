/**
 * Dry run (SPEC §5): what a migration of these videos would do, without writing
 * anything or downloading more than a HEAD. Also the gate for real jobs: only what the
 * plan calls eligible is queued.
 */
import { eligibility, loadVideo } from './catalog.js';
import { STORAGE_STATE, carKey, migrateFilter, migratedFields } from './playerContract.js';

export const MAX_ITEMS = 500;

export async function planItems({ cfg, db, bucket, now = () => new Date() }, items, { mode = STORAGE_STATE.ARCHIVED } = {}) {
  if (!Array.isArray(items) || !items.length) throw new TypeError('no items');
  if (items.length > MAX_ITEMS) throw new TypeError(`at most ${MAX_ITEMS} videos at once`);
  if (![STORAGE_STATE.ARCHIVED, STORAGE_STATE.HOT].includes(mode)) throw new TypeError(`unknown mode ${mode}`);

  const out = [];
  for (const { collection, id } of items) {
    const base = { collection, id: String(id) };
    let doc;
    try {
      doc = await loadVideo(db, cfg, collection, id);
    } catch (e) {
      out.push({ ...base, eligible: false, reason: e.message });
      continue;
    }
    if (!doc) { out.push({ ...base, eligible: false, reason: 'not found' }); continue; }
    const info = { ...base, owner: doc.owner, permlink: doc.permlink ?? null, title: doc.title || doc.permlink || null };
    const e = eligibility(collection, doc, { now: now() });
    if (!e.eligible) { out.push({ ...info, eligible: false, reason: e.reason, cid: e.cid ?? null }); continue; }

    const [existing, car] = await Promise.all([bucket.list(`${e.cid}/`), bucket.head(carKey(e.cid))]);
    const sample = migratedFields(cfg.s3, { cid: e.cid, manifestPath: e.manifestPath, bytes: 1, files: 1, by: '-', mode });
    out.push({
      ...info,
      eligible: true,
      cid: e.cid,
      manifestPath: e.manifestPath,
      s3: {
        prefix: `${e.cid}/`,
        objectsAlready: existing.size,   // compared during the run; anything not in the video stops it
        carAlready: !!car,
      },
      wouldSet: {
        ...sample,
        s3_bytes: '(measured from the CAR)',
        s3_files: '(counted from the CAR)',
        s3_migrated_at: '(time of the update)',
        s3_migrated_by: '(you)',
      },
      onlyIf: migrateFilter(collection, doc),
    });
  }
  return out;
}
