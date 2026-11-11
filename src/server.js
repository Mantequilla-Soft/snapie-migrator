/**
 * HTTP API (SPEC §8) and the page.
 *
 * Two listeners:
 *  - the public app (behind nginx): read-only routes for everyone, every route that
 *    changes something requires a Keychain session of an ALLOWED_USERS account;
 *  - the service app, bound to 127.0.0.1 on SERVICE_PORT and never proxied: the
 *    hotnode's Bearer-token API. It lives apart because behind a local nginx every
 *    public request also comes from 127.0.0.1, so "loopback only" on the public
 *    listener would protect nothing.
 */
import path from 'node:path';
import express from 'express';
import { COOKIE, SESSION_TTL_MS } from './auth.js';
import { listChannel, loadVideo } from './catalog.js';
import { planItems } from './dryRun.js';
import { KIND } from './actions.js';
import { COLLECTION, STORAGE_STATE, sourceOf } from './playerContract.js';

const PUBLIC_DIR = path.resolve(import.meta.dirname, '../public');

const isRef = (x) => x && Object.values(COLLECTION).includes(x.collection)
  && typeof x.id === 'string' && x.id.length > 0 && x.id.length <= 64;

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const httpError = (status, message) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function errorHandler(err, _req, res, _next) {
  const status = err.status ?? (err instanceof TypeError ? 400 : 500);
  if (status >= 500) console.error('[api]', err);
  res.status(status).json({ error: status >= 500 ? 'internal error' : err.message });
}

/** Shared by both listeners: plan, then queue only what is eligible. */
async function startMigration(deps, { items, mode, by, channel }) {
  if (!Array.isArray(items) || !items.every(isRef)) throw httpError(400, 'items must be [{ collection, id }]');
  const plan = await planItems(deps, items, { mode });
  const eligible = plan.filter((p) => p.eligible);
  const notEligible = plan.filter((p) => !p.eligible).map((p) => ({ collection: p.collection, id: p.id, reason: p.reason }));
  if (!eligible.length) return { jobId: null, added: [], skipped: notEligible };
  const r = deps.queue.enqueue({
    by, channel, mode, kind: KIND.MIGRATE,
    items: eligible.map((p) => ({ collection: p.collection, docId: p.id, owner: p.owner, permlink: p.permlink, title: p.title, cid: p.cid })),
  });
  return { jobId: r.jobId, added: r.added, skipped: [...notEligible, ...r.skipped.map((s) => ({ collection: s.collection, id: s.docId, reason: s.reason }))] };
}

export function createApp(deps) {
  const { cfg, db, queue, auth, budget } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  const origin = new URL(cfg.publicBaseUrl).origin;
  const secure = cfg.publicBaseUrl.startsWith('https://');

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    req.session = auth.session(cookies(req)[COOKIE]);
    next();
  });
  app.use(express.json({ limit: '200kb' }));
  // API answers are live state (what is migrated, what runs): never from a cache.
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  // Every request that changes something: JSON only (a form can't send it), from our
  // own origin when the browser says where it comes from, and by an allowed account.
  const mutating = (req, _res, next) => {
    if (!req.is('application/json')) return next(httpError(415, 'send application/json'));
    if (req.headers.origin && req.headers.origin !== origin) return next(httpError(403, 'wrong origin'));
    next();
  };
  const authorized = (req, _res, next) => {
    if (!req.session) return next(httpError(401, 'log in with Hive Keychain'));
    if (!req.session.authorized) return next(httpError(403, `@${req.session.user} is not allowed to act here`));
    next();
  };

  // --- auth ---
  app.get('/api/me', (req, res) => res.json(req.session ?? { user: null, authorized: false }));
  app.get('/api/auth/challenge', (req, res, next) => {
    try { res.json(auth.challenge(req.query.user)); } catch (e) { next(httpError(400, e.message)); }
  });
  app.post('/api/auth/verify', mutating, wrap(async (req, res) => {
    let who;
    try { who = await auth.verify(req.body ?? {}); } catch (e) { throw httpError(401, e.message); }
    res.cookie(COOKIE, auth.issue(who.user), { httpOnly: true, secure, sameSite: 'strict', maxAge: SESSION_TTL_MS, path: '/' });
    res.json(who);
  }));
  app.post('/api/auth/logout', mutating, (_req, res) => {
    res.clearCookie(COOKIE, { httpOnly: true, secure, sameSite: 'strict', path: '/' });
    res.json({ ok: true });
  });

  // --- read-only ---
  app.get('/api/status', (_req, res) => res.json({
    bucket: cfg.s3.bucket, cdnHost: cfg.s3.cdnHost, sources: cfg.sourceGateways, maxConcurrent: cfg.maxConcurrent,
    running: queue.running.size, disk: budget.snapshot(), playerCheck: !!cfg.playerBaseUrl,
  }));
  app.get('/api/channel/:user', wrap(async (req, res) => {
    let rows;
    try { rows = await listChannel(db, cfg, req.params.user); } catch (e) { throw httpError(400, e.message); }
    for (const c of Object.values(COLLECTION)) {
      const latest = queue.latestFor(c, rows.filter((r) => r.collection === c).map((r) => r.id));
      for (const r of rows) if (r.collection === c && latest.has(r.id)) {
        const it = latest.get(r.id);
        r.lastItem = { id: it.id, kind: it.kind, status: it.status, stage: it.stage, error: it.error, finishedAt: it.finished_at };
      }
    }
    res.json({ user: req.params.user.toLowerCase(), rows });
  }));
  app.get('/api/jobs', (_req, res) => res.json(queue.jobs()));
  app.get('/api/jobs/:id', (req, res, next) => {
    const job = queue.job(Number(req.params.id));
    return job ? res.json(job) : next(httpError(404, 'no such job'));
  });
  app.get('/api/items/:id', (req, res, next) => {
    const item = queue.item(Number(req.params.id));
    return item ? res.json({ ...item, events: queue.events(item.id) }) : next(httpError(404, 'no such item'));
  });

  // Live progress. Per-item progress is throttled; status changes always go out.
  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const last = new Map();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const onItem = (row) => send('item', row);
    const onProgress = (p) => {
      const t = Date.now();
      const prev = last.get(p.itemId);
      if (prev && prev.stage === p.stage && t - prev.t < 500) return;
      last.set(p.itemId, { t, stage: p.stage });
      send('progress', p);
      send('disk', budget.snapshot());
    };
    queue.on('item', onItem);
    queue.on('progress', onProgress);
    const beat = setInterval(() => { res.write(': keep-alive\n\n'); send('disk', budget.snapshot()); }, 15_000);
    send('hello', { running: queue.running.size, disk: budget.snapshot() });
    req.on('close', () => { clearInterval(beat); queue.off('item', onItem); queue.off('progress', onProgress); });
  });

  // --- actions (allowed accounts only) ---
  app.post('/api/dry-run', mutating, authorized, wrap(async (req, res) => {
    const { items, mode = STORAGE_STATE.ARCHIVED } = req.body ?? {};
    if (!Array.isArray(items) || !items.every(isRef)) throw httpError(400, 'items must be [{ collection, id }]');
    res.json({ mode, plan: await planItems(deps, items, { mode }) });
  }));
  app.post('/api/jobs', mutating, authorized, wrap(async (req, res) => {
    const { items, mode = STORAGE_STATE.ARCHIVED, channel = null } = req.body ?? {};
    res.status(202).json(await startMigration(deps, { items, mode, channel, by: req.session.user }));
  }));
  app.post('/api/jobs/:id/cancel', mutating, authorized, (req, res) => res.json({ cancelled: queue.cancelJob(Number(req.params.id)) }));
  app.post('/api/items/:id/cancel', mutating, authorized, (req, res, next) => {
    const r = queue.cancelItem(Number(req.params.id));
    return r ? res.json(r) : next(httpError(404, 'no such item'));
  });

  const singleAction = (kind) => wrap(async (req, res) => {
    const ref = req.body ?? {};
    if (!isRef(ref)) throw httpError(400, 'send { collection, id }');
    const doc = await loadVideo(db, cfg, ref.collection, ref.id);
    if (!doc) throw httpError(404, 'video not found');
    const src = sourceOf(ref.collection, doc);
    if (!src.cid) throw httpError(409, src.reason);
    if (kind === KIND.REVERT && doc.s3_migrated_at === undefined) throw httpError(409, 'not migrated by the migrator; nothing to revert');
    const r = queue.enqueue({
      by: req.session.user, channel: doc.owner, kind,
      items: [{ collection: ref.collection, docId: ref.id, owner: doc.owner, permlink: doc.permlink, title: doc.title, cid: src.cid }],
    });
    if (!r.added.length) throw httpError(409, r.skipped[0]?.reason ?? 'already queued');
    res.status(202).json({ jobId: r.jobId, itemId: r.added[0] });
  });
  app.post('/api/items/check-ipfs', mutating, authorized, singleAction(KIND.CHECK));
  app.post('/api/items/revert', mutating, authorized, singleAction(KIND.REVERT));

  app.use('/api', (_req, _res, next) => next(httpError(404, 'not found')));
  // Revalidate every time (ETag): a deploy shows up on the next reload, never a stale mix.
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', cacheControl: true, maxAge: 0 }));
  app.use(errorHandler);
  return app;
}

/** The hotnode's API: Bearer token, 127.0.0.1 only (bind it there; see index.js). */
export function createServiceApp(deps) {
  const { queue, auth } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '200kb' }));
  app.use((req, _res, next) => {
    const peer = req.socket.remoteAddress;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)) return next(httpError(403, 'loopback only'));
    if (!auth.serviceOk(req.headers.authorization)) return next(httpError(401, 'bad service token'));
    next();
  });
  app.post('/api/jobs', wrap(async (req, res) => {
    const { items, mode = STORAGE_STATE.HOT, channel = null } = req.body ?? {};
    res.status(202).json(await startMigration(deps, { items, mode, channel, by: 'service:hotnode' }));
  }));
  app.get('/api/jobs/:id', (req, res, next) => {
    const job = queue.job(Number(req.params.id));
    return job ? res.json(job) : next(httpError(404, 'no such job'));
  });
  app.get('/api/items/:id', (req, res, next) => {
    const item = queue.item(Number(req.params.id));
    return item ? res.json(item) : next(httpError(404, 'no such item'));
  });
  app.use((_req, _res, next) => next(httpError(404, 'not found')));
  app.use(errorHandler);
  return app;
}
