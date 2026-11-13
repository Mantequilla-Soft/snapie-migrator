/**
 * The hotnode integration (issue #8; hotnode#19 is the other side).
 *
 * The hotnode knows CIDs, not Mongo ids. It asks for copies by CID, hears back
 * through signed callbacks, flips a video to `archived` once it has unpinned it, and
 * can ask for the state of a CID at any time to catch up on anything it missed.
 *
 *  - requestCids: each CID → every ready document that holds it → queue items
 *    (one request row per CID, linked to its items);
 *  - settle: once every item of a request has finished, one `copied` or `failed`
 *    event goes into the outbox, in the same SQLite transaction that closes the
 *    request. It runs after every item change, on a timer and on boot, so a crash
 *    between the last item and the event only delays it;
 *  - deliver: the outbox is POSTed to HOTNODE_CALLBACK_URL in order, signed, with
 *    backoff, until a 2xx or EVENT_GIVE_UP_MS;
 *  - archive: the conditional flip `hot` → `archived` after the hotnode unpinned;
 *  - cidState: the state from Mongo plus our own tables, right even if events were lost.
 *
 * Copying itself is the normal pipeline: nothing here downloads or uploads.
 */
import crypto from 'node:crypto';
import { COLLECTION, CID_RE, STORAGE_STATE, parseS3Url, sourceOf } from './playerContract.js';
import { EMBED_READY, LEGACY_READY, eligibility, isExpiredStory } from './catalog.js';
import { ERROR_CODES, codeOf } from './errors.js';
import { KIND } from './actions.js';
import { PRIORITY } from './queue.js';
import { playerCheck } from './pipeline.js';

export const MAX_CIDS = 100;
export const BY = 'service:hotnode';
const MINUTE = 60_000;
export const EVENT_BACKOFF_MS = Object.freeze({ first: MINUTE, max: 60 * MINUTE });
export const EVENT_GIVE_UP_MS = 7 * 24 * 60 * MINUTE;
export const SIGNATURE_MAX_SKEW_S = 300;   // what the hotnode accepts; documented for it

export const REJECT = Object.freeze({
  NOT_A_CID: 'not_a_cid', NOT_IN_MONGO: 'not_in_mongo', NOT_READY: 'not_ready', NOT_IPFS: 'not_ipfs', CONFLICT: 'conflict',
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cid_requests (
  id INTEGER PRIMARY KEY,
  cid TEXT NOT NULL,
  mode TEXT NOT NULL,
  job_id INTEGER,
  status TEXT NOT NULL,            -- open | copied | failed
  requested_at TEXT NOT NULL,
  closed_at TEXT,
  event_id TEXT
);
CREATE INDEX IF NOT EXISTS cid_requests_cid ON cid_requests(cid, id);
CREATE INDEX IF NOT EXISTS cid_requests_status ON cid_requests(status);
CREATE TABLE IF NOT EXISTS cid_request_docs (
  request_id INTEGER NOT NULL REFERENCES cid_requests(id),
  collection TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  item_id INTEGER,                 -- null: the document was already copied when asked
  PRIMARY KEY (request_id, collection, doc_id)
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  cid TEXT NOT NULL,
  event TEXT NOT NULL,             -- copied | failed | archived
  body TEXT NOT NULL,              -- the exact JSON that is signed and sent
  status TEXT NOT NULL,            -- pending | delivered | given_up | off (no callback configured)
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS outbox_next ON outbox(status, id);
CREATE INDEX IF NOT EXISTS outbox_cid ON outbox(cid, id);
`;

const ACTIVE = new Set(['queued', 'running']);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const httpError = (status, code, message = code, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });

/** `sha256=<hex>` over `${timestamp}.${body}`: what X-Migrator-Signature carries. */
export function sign(secret, timestamp, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** Checks a signature the way the hotnode must (for tests and the hotnode's own reference). */
export function verifySignature(secret, { timestamp, signature, body, now = Date.now() }) {
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(now / 1000 - ts) > SIGNATURE_MAX_SKEW_S) return false;
  const want = Buffer.from(sign(secret, timestamp, body));
  const got = Buffer.from(String(signature ?? ''));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/** Is this document's s3_url one of ours, for this CID? */
const s3For = (s3, doc, cid) => {
  const p = parseS3Url(s3, doc?.s3_url);
  return !!p && p.cidPath.startsWith(`${cid}/`);
};

/**
 * Where one document stands, for the hotnode. → { kind, reason? }
 *  - not_ready: a status the player doesn't play (ignored, like the player ignores it)
 *  - not_ipfs: a ready legacy video whose video_v2 isn't ipfs:// (S3 can't serve it)
 *  - archived / copied: our verified fields are there, for this CID
 *  - eligible: can be copied now
 *  - conflict: anything else (foreign s3_* fields, unknown storage_state, promoting)
 */
export function classify(collection, doc, s3, cid, now = new Date()) {
  const status = String(doc?.status ?? '').toLowerCase();
  const ready = collection === COLLECTION.LEGACY ? LEGACY_READY : EMBED_READY;
  if (!ready.includes(status)) return { kind: 'not_ready', reason: `status "${doc?.status ?? 'none'}"` };
  if (collection === COLLECTION.EMBED && isExpiredStory(doc, now)) return { kind: 'not_ready', reason: 'expired story' };
  const src = sourceOf(collection, doc);
  if (!src.cid) return { kind: 'not_ipfs', reason: src.reason };
  if (src.cid !== cid) return { kind: 'not_ready', reason: 'another CID' };   // only via a stale query match
  const ours = doc.s3_migrated_by !== undefined && s3For(s3, doc, cid);
  if (doc.storage_state === STORAGE_STATE.ARCHIVED && ours) return { kind: 'archived' };
  if (doc.storage_state === STORAGE_STATE.HOT && ours) return { kind: 'copied' };
  const e = eligibility(collection, doc, { now });
  if (e.eligible) return { kind: 'eligible' };
  return { kind: 'conflict', reason: e.reason };
}

const docRef = (collection, doc, extra = {}) => ({
  collection, id: String(doc._id), owner: doc.owner ?? null, permlink: doc.permlink ?? null, ...extra,
});

export class HotnodeService {
  /**
   * opts: { queue, db (Mongo Db), cfg, fetchImpl, now, log, sweepMs, deliverMs, timeoutMs }
   * `cfg.callback` = { url, secret } or null (then events are kept, marked `off`).
   */
  constructor({ queue, db, cfg, fetchImpl = fetch, now = () => Date.now(), log = console,
    sweepMs = 30_000, deliverMs = 5_000, timeoutMs = 10_000 }) {
    this.queue = queue;
    this.sql = queue.db;
    this.sql.exec(SCHEMA);
    this.db = db;
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.log = log;
    this.sweepMs = sweepMs;
    this.deliverMs = deliverMs;
    this.timeoutMs = timeoutMs;
    this.settling = null;
    this.delivering = null;
    this.stopped = true;
    this.onItem = (row) => { if (!ACTIVE.has(row.status) && this.linked(row.id)) this.kick(); };
  }

  iso(t = this.now()) { return new Date(t).toISOString(); }

  // ------------------------------------------------------------ lifecycle

  start() {
    this.queue.on('item', this.onItem);
    this.stopped = false;
    this.timers = [
      setInterval(() => this.kick(), this.sweepMs),
      setInterval(() => this.deliverSoon(), this.deliverMs),
    ];
    for (const t of this.timers) t.unref?.();
    this.kick();
  }

  async stop() {
    this.stopped = true;
    for (const t of this.timers ?? []) clearInterval(t);
    this.queue.off('item', this.onItem);
    await Promise.allSettled([this.settling, this.delivering]);
  }

  /** Settle soon, then deliver (never inside a queue event handler, which may be mid-update). */
  kick() {
    if (this.stopped) return;
    setImmediate(() => { this.settle().then(() => this.deliverSoon(), (e) => this.log.error('[hotnode] settle', e)); });
  }

  deliverSoon() {
    if (this.stopped || !this.cfg.callback) return;
    this.delivering ??= this.deliver().catch((e) => this.log.error('[hotnode] deliver', e)).finally(() => { this.delivering = null; });
  }

  linked(itemId) {
    return !!this.sql.prepare(`SELECT 1 FROM cid_request_docs d JOIN cid_requests r ON r.id = d.request_id
      WHERE d.item_id = ? AND r.status = 'open'`).get(itemId);
  }

  // ------------------------------------------------------------ Mongo

  /** cid → [{ collection, doc }] for every document that references it, in both collections. */
  async findDocs(cids) {
    const out = new Map(cids.map((c) => [c, []]));
    if (!cids.length) return out;
    const { legacyCollection, embedCollection } = this.cfg.mongo;
    // video_v2 is indexed and the regexes are anchored, so this stays an index scan.
    // A bare CID in video_v2 is matched too, only to answer `not_ipfs`.
    const legacyQuery = { video_v2: { $in: [...cids.map((c) => new RegExp(`^ipfs://${escapeRe(c)}(/|$)`)), ...cids] } };
    const [legacy, embed] = await Promise.all([
      this.db.collection(legacyCollection).find(legacyQuery).toArray(),
      this.db.collection(embedCollection).find({ manifest_cid: { $in: cids } }).toArray(),
    ]);
    for (const doc of legacy) {
      const v = String(doc.video_v2);
      const cid = cids.find((c) => v === c || v === `ipfs://${c}` || v.startsWith(`ipfs://${c}/`));
      if (cid) out.get(cid).push({ collection: COLLECTION.LEGACY, doc });
    }
    for (const doc of embed) out.get(doc.manifest_cid)?.push({ collection: COLLECTION.EMBED, doc });
    return out;
  }

  /** The documents of a CID that matter, classified. → { relevant: [{ collection, doc, kind, reason }], all } */
  classifyAll(cid, found) {
    const now = new Date(this.now());
    const all = found.map((f) => ({ ...f, ...classify(f.collection, f.doc, this.cfg.s3, cid, now) }));
    return { all, relevant: all.filter((d) => d.kind !== 'not_ready') };
  }

  /** Why a CID can't be copied, or null. */
  static rejection(found, relevant) {
    if (!found.length) return { reason: REJECT.NOT_IN_MONGO };
    if (!relevant.length) return { reason: REJECT.NOT_READY };
    const conflict = relevant.find((d) => d.kind === 'conflict');
    if (conflict) return { reason: REJECT.CONFLICT, detail: `${conflict.collection} ${conflict.doc._id}: ${conflict.reason}` };
    const notIpfs = relevant.find((d) => d.kind === 'not_ipfs');
    if (notIpfs) return { reason: REJECT.NOT_IPFS, detail: `${notIpfs.collection} ${notIpfs.doc._id}: ${notIpfs.reason}` };
    return null;
  }

  // ------------------------------------------------------------ requests

  openRequest(cid) {
    return this.sql.prepare(`SELECT * FROM cid_requests WHERE cid = ? AND status = 'open' ORDER BY id DESC LIMIT 1`).get(cid);
  }

  requestItems(requestId) {
    return this.sql.prepare('SELECT item_id FROM cid_request_docs WHERE request_id = ? AND item_id IS NOT NULL ORDER BY item_id')
      .all(requestId).map((r) => r.item_id);
  }

  /**
   * POST /api/jobs { cids, mode }. → { jobId, cids: [{ cid, status, items?, reason?, detail? }] }
   * Idempotent: a CID already in progress answers with its items; one already copied
   * answers `already_copied` and still gets its `copied` event.
   */
  async requestCids(input, mode = STORAGE_STATE.HOT) {
    if (!Array.isArray(input) || !input.length) throw httpError(400, 'bad_request', 'cids must be a non-empty array');
    if (input.length > MAX_CIDS) throw httpError(400, 'bad_request', `at most ${MAX_CIDS} CIDs at once`);
    if (![STORAGE_STATE.HOT, STORAGE_STATE.ARCHIVED].includes(mode)) throw httpError(400, 'bad_request', `unknown mode ${mode}`);
    const cids = [...new Set(input.map((c) => String(c ?? '').trim()))];
    const valid = cids.filter((c) => CID_RE.test(c));
    const found = await this.findDocs(valid);

    // From here on everything is synchronous: two calls can't interleave between the
    // "already in progress?" check and the new request.
    let jobId = null;
    const answers = [];
    for (const cid of cids) {
      if (!CID_RE.test(cid)) { answers.push({ cid, status: 'rejected', reason: REJECT.NOT_A_CID }); continue; }
      const open = this.openRequest(cid);
      if (open) { answers.push({ cid, status: 'in_progress', items: this.requestItems(open.id) }); continue; }
      const docs = found.get(cid);
      const { relevant } = this.classifyAll(cid, docs);
      const rejected = HotnodeService.rejection(docs, relevant);
      if (rejected) { answers.push({ cid, status: 'rejected', ...rejected }); continue; }

      const eligible = relevant.filter((d) => d.kind === 'eligible');
      if (!eligible.length) {
        this.closeNow(cid, mode, relevant);
        answers.push({ cid, status: 'already_copied' });
        continue;
      }
      const r = this.queue.enqueue({
        by: BY, mode, kind: KIND.MIGRATE, priority: PRIORITY.NORMAL, jobId,
        items: eligible.map(({ collection, doc }) => ({
          collection, docId: String(doc._id), owner: doc.owner, permlink: doc.permlink, title: doc.title || doc.permlink || null, cid,
        })),
      });
      jobId = r.jobId;
      const itemFor = new Map(r.added.map((id) => { const it = this.queue.item(id); return [`${it.collection}:${it.doc_id}`, id]; }));
      // A document already in the queue (a manual run, the backlog) is followed as it
      // is, moved up to normal priority so the hotnode doesn't wait behind the backlog.
      for (const s of r.skipped) {
        const active = this.sql.prepare(`SELECT id FROM items WHERE collection = ? AND doc_id = ? AND status IN ('queued', 'running') ORDER BY id DESC LIMIT 1`)
          .get(s.collection, String(s.docId));
        if (active) {
          this.sql.prepare('UPDATE items SET priority = MIN(priority, ?) WHERE id = ?').run(PRIORITY.NORMAL, active.id);
          itemFor.set(`${s.collection}:${s.docId}`, active.id);
        }
      }
      const requestId = this.sql.transaction(() => {
        const id = Number(this.sql.prepare(`INSERT INTO cid_requests (cid, mode, job_id, status, requested_at) VALUES (?, ?, ?, 'open', ?)`)
          .run(cid, mode, jobId, this.iso()).lastInsertRowid);
        const link = this.sql.prepare('INSERT INTO cid_request_docs (request_id, collection, doc_id, item_id) VALUES (?, ?, ?, ?)');
        for (const d of relevant) link.run(id, d.collection, String(d.doc._id), itemFor.get(`${d.collection}:${d.doc._id}`) ?? null);
        return id;
      })();
      answers.push({ cid, status: 'queued', items: this.requestItems(requestId) });
    }
    this.kick();
    return { jobId, cids: answers };
  }

  /** Every document is already copied: record the request closed, with its `copied` event. */
  closeNow(cid, mode, relevant) {
    const body = this.copiedBody(cid, relevant.map((d) => ({ collection: d.collection, doc: d.doc, item: null })), []);
    this.sql.transaction(() => {
      const id = Number(this.sql.prepare(`INSERT INTO cid_requests (cid, mode, status, requested_at, closed_at, event_id) VALUES (?, ?, 'copied', ?, ?, ?)`)
        .run(cid, mode, this.iso(), this.iso(), body.id).lastInsertRowid);
      const link = this.sql.prepare('INSERT INTO cid_request_docs (request_id, collection, doc_id) VALUES (?, ?, ?)');
      for (const d of relevant) link.run(id, d.collection, String(d.doc._id));
      this.enqueueEvent(body);
    })();
  }

  // ------------------------------------------------------------ settling

  /** Close every open request whose items have all finished. Serialized. */
  settle() {
    const run = async () => {
      const ready = this.sql.prepare(`SELECT r.* FROM cid_requests r WHERE r.status = 'open' AND NOT EXISTS (
        SELECT 1 FROM cid_request_docs d JOIN items i ON i.id = d.item_id
        WHERE d.request_id = r.id AND i.status IN ('queued', 'running')) ORDER BY r.id`).all();
      for (const req of ready) await this.settleOne(req);
      return ready.length;
    };
    this.settling = (this.settling ?? Promise.resolve()).catch(() => {}).then(run);
    return this.settling;
  }

  async settleOne(req) {
    const links = this.sql.prepare('SELECT * FROM cid_request_docs WHERE request_id = ? ORDER BY rowid').all(req.id);
    const items = links.map((l) => (l.item_id ? this.queue.item(l.item_id) : null));
    const bad = items.find((it) => it && it.status !== 'done');
    let body;
    if (bad) {
      body = this.failedBody(req.cid, links, items, bad);
    } else {
      // Read Mongo again: the event says what is there now, not what the items reported.
      const now = (await this.findDocs([req.cid])).get(req.cid);
      const fresh = links.map((l) => now.find((f) => f.collection === l.collection && String(f.doc._id) === l.doc_id) ?? null);
      const missing = links.findIndex((l, i) => !fresh[i] || !['copied', 'archived'].includes(classify(l.collection, fresh[i].doc, this.cfg.s3, req.cid, new Date(this.now())).kind));
      if (missing >= 0) {
        const l = links[missing];
        body = this.failedBody(req.cid, links, items, { error_code: 'changed_during_migration', error: `${l.collection} ${l.doc_id} no longer has the S3 fields (changed or reverted meanwhile)` });
      } else {
        const warnings = items.flatMap((it) => it?.result?.warnings ?? []);
        body = this.copiedBody(req.cid, links.map((l, i) => ({ collection: l.collection, doc: fresh[i].doc, item: l.item_id })), warnings);
      }
    }
    this.sql.transaction(() => {
      const r = this.sql.prepare(`UPDATE cid_requests SET status = ?, closed_at = ?, event_id = ? WHERE id = ? AND status = 'open'`)
        .run(body.event === 'copied' ? 'copied' : 'failed', this.iso(), body.id, req.id);
      if (r.changes === 1) this.enqueueEvent(body);
    })();
  }

  // ------------------------------------------------------------ events

  newEvent(event, cid, fields) {
    return { id: `evt_${crypto.randomBytes(12).toString('hex')}`, event, cid, at: this.iso(), ...fields };
  }

  copiedBody(cid, docs, warnings) {
    const first = docs[0].doc;
    return this.newEvent('copied', cid, {
      documents: docs.map(({ collection, doc, item }) => docRef(collection, doc, { item })),
      s3_url: first.s3_url,
      s3_car_url: first.s3_car_url,
      bytes: first.s3_bytes ?? null,
      files: first.s3_files ?? null,
      warnings,
    });
  }

  failedBody(cid, links, items, bad) {
    const code = codeOf(bad);
    return this.newEvent('failed', cid, {
      documents: links.map((l, i) => ({ collection: l.collection, id: l.doc_id, item: l.item_id, status: items[i]?.status ?? 'copied' })),
      error: { code, message: bad.error ?? code },
      retryable: ERROR_CODES[code].retryable,
    });
  }

  enqueueEvent(body) {
    this.sql.prepare(`INSERT INTO outbox (event_id, cid, event, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(body.id, body.cid, body.event, JSON.stringify(body), this.cfg.callback ? 'pending' : 'off', this.now());
  }

  /** POST the outbox, oldest first. One that keeps failing holds the rest back, until it gives up. */
  async deliver() {
    const { url, secret } = this.cfg.callback;
    for (;;) {
      if (this.stopped) return;
      const row = this.sql.prepare(`SELECT * FROM outbox WHERE status = 'pending' ORDER BY id LIMIT 1`).get();
      if (!row) return;
      const t = this.now();
      if (t - row.created_at > EVENT_GIVE_UP_MS) {
        this.sql.prepare(`UPDATE outbox SET status = 'given_up' WHERE id = ?`).run(row.id);
        this.log.error(`[hotnode] gave up on event ${row.event_id} (${row.event} ${row.cid}) after ${row.attempts} attempts: ${row.last_error}`);
        continue;
      }
      if (row.next_at > t) return;
      const timestamp = String(Math.floor(t / 1000));
      let error = null;
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Migrator-Event': row.event_id,
            'X-Migrator-Timestamp': timestamp,
            'X-Migrator-Signature': sign(secret, timestamp, row.body),
          },
          body: row.body,
          redirect: 'error',   // never follow the hotnode anywhere else
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        await res.arrayBuffer().catch(() => {});
        if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
      } catch (e) {
        error = e.name === 'TimeoutError' ? 'timed out' : (e.cause?.code ?? e.message);
      }
      const attempts = row.attempts + 1;
      if (!error) {
        this.sql.prepare(`UPDATE outbox SET status = 'delivered', attempts = ?, delivered_at = ?, last_error = NULL WHERE id = ?`).run(attempts, this.now(), row.id);
        continue;
      }
      const wait = Math.min(EVENT_BACKOFF_MS.first * 2 ** (attempts - 1), EVENT_BACKOFF_MS.max);
      this.sql.prepare('UPDATE outbox SET attempts = ?, next_at = ?, last_error = ? WHERE id = ?').run(attempts, this.now() + wait, error, row.id);
      return;
    }
  }

  // ------------------------------------------------------------ archive

  /**
   * POST /api/archive { cid }: the hotnode has unpinned it, so the player should go
   * straight to S3. Only documents still `hot` with our verified fields are flipped.
   */
  async archive(cid) {
    if (!CID_RE.test(String(cid ?? ''))) throw httpError(400, REJECT.NOT_A_CID, 'send { cid }');
    const found = (await this.findDocs([cid])).get(cid);
    const { relevant } = this.classifyAll(cid, found);
    if (!found.length) throw httpError(404, REJECT.NOT_IN_MONGO);
    if (!relevant.length) throw httpError(409, REJECT.NOT_READY);
    const notCopied = relevant.filter((d) => !['copied', 'archived'].includes(d.kind));
    if (notCopied.length) {
      throw httpError(409, 'not_copied', `not copied: ${notCopied.map((d) => `${d.collection} ${d.doc._id} (${d.reason ?? d.kind})`).join(', ')}`);
    }

    // The copy must be there for viewers, through the zone, before the player relies on it alone.
    for (const url of new Set(relevant.map((d) => d.doc.s3_url))) {
      let res;
      try {
        res = await this.fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(15_000) });
      } catch (e) {
        throw httpError(503, 'copy_check_unavailable', `could not check ${url}: ${e.message}`);
      }
      if (res.status === 404 || res.status === 403) throw httpError(409, 'copy_missing', `${url} answered HTTP ${res.status}`);
      if (res.status !== 200) throw httpError(503, 'copy_check_unavailable', `${url} answered HTTP ${res.status}`);
    }

    let flipped = 0;
    const docs = [];
    for (const d of relevant) {
      const coll = this.db.collection(d.collection === COLLECTION.LEGACY ? this.cfg.mongo.legacyCollection : this.cfg.mongo.embedCollection);
      if (d.kind === 'copied') {
        const r = await coll.updateOne(
          { _id: d.doc._id, storage_state: STORAGE_STATE.HOT, s3_url: d.doc.s3_url, s3_migrated_by: { $exists: true } },
          { $set: { storage_state: STORAGE_STATE.ARCHIVED } },
        );
        if (r.matchedCount !== 1) {
          const now = await coll.findOne({ _id: d.doc._id });
          if (classify(d.collection, now, this.cfg.s3, cid, new Date(this.now())).kind !== 'archived') {
            throw httpError(409, 'changed', `${d.collection} ${d.doc._id} changed meanwhile; not archived`);
          }
        } else flipped++;
      }
      docs.push(docRef(d.collection, d.doc, { state: STORAGE_STATE.ARCHIVED }));
    }

    const warnings = [];
    if (this.cfg.playerBaseUrl) {
      for (const d of relevant.filter((x) => x.doc.permlink && x.doc.owner)) {
        const p = await playerCheck({
          playerBaseUrl: this.cfg.playerBaseUrl, owner: d.doc.owner, permlink: d.doc.permlink, fetchImpl: this.fetchImpl, timeoutMs: 15_000,
          fields: { storage_state: STORAGE_STATE.ARCHIVED, s3_url: d.doc.s3_url },
        });
        if (!p.ok) warnings.push(`player check (${d.doc.owner}/${d.doc.permlink}): ${p.detail}`);
      }
    }
    const body = this.newEvent('archived', cid, { documents: docs, s3_url: relevant[0].doc.s3_url, archived: flipped, warnings });
    this.enqueueEvent(body);
    this.deliverSoon();
    return { cid, documents: docs, archived: flipped, already: relevant.length - flipped, warnings };
  }

  // ------------------------------------------------------------ state

  /** GET /api/cids/:cid → { cid, state, reason?, documents, items, last_event } */
  async cidState(cid) {
    if (!CID_RE.test(String(cid ?? ''))) throw httpError(400, REJECT.NOT_A_CID, `"${cid}" is not a CID`);
    const found = (await this.findDocs([cid])).get(cid);
    const { relevant } = this.classifyAll(cid, found);
    const items = this.sql.prepare(`SELECT id, job_id, collection, doc_id, mode, status, stage, attempts, error, error_code, finished_at
      FROM items WHERE cid = ? ORDER BY id DESC LIMIT 20`).all(cid);
    const lastRow = this.sql.prepare('SELECT body, status FROM outbox WHERE cid = ? ORDER BY id DESC LIMIT 1').get(cid);
    const last_event = lastRow ? { ...JSON.parse(lastRow.body), delivery: lastRow.status } : null;
    const lastReq = this.sql.prepare('SELECT * FROM cid_requests WHERE cid = ? ORDER BY id DESC LIMIT 1').get(cid);

    let state = 'unknown';
    let reason;
    const rejected = HotnodeService.rejection(found, relevant);
    if (lastReq?.status === 'open') state = 'in_progress';
    else if (!rejected && relevant.every((d) => d.kind === 'archived')) state = 'archived';
    else if (!rejected && relevant.every((d) => ['copied', 'archived'].includes(d.kind))) state = 'copied';
    else if (lastReq?.status === 'failed') state = 'failed';
    if (rejected && state !== 'in_progress') reason = rejected.reason;
    return {
      cid, state, ...(reason ? { reason } : {}),
      documents: relevant.map((d) => docRef(d.collection, d.doc, { kind: d.kind, storage_state: d.doc.storage_state ?? null, s3_url: d.doc.s3_url ?? null })),
      items, last_event,
    };
  }

  /** For /api/status and the page: is anything stuck on the way to the hotnode? */
  summary() {
    const c = (sql, ...a) => this.sql.prepare(sql).get(...a).n;
    const head = this.sql.prepare(`SELECT created_at, attempts, last_error FROM outbox WHERE status = 'pending' ORDER BY id LIMIT 1`).get();
    return {
      callback: !!this.cfg.callback,
      openRequests: c(`SELECT COUNT(*) AS n FROM cid_requests WHERE status = 'open'`),
      pending: c(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'`),
      givenUp: c(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'given_up'`),
      oldestPendingAt: head ? new Date(head.created_at).toISOString() : null,
      lastError: head?.last_error ?? null,
    };
  }
}
