// Snapie Migrator page. Everything from the API is inserted as text (titles come
// from users), never as HTML.

import { SOURCE_MESSAGE, classify, embedUrl, summarize } from './sources.js';

const $ = (sel) => document.querySelector(sel);
const STAGES = ['resolve', 'download', 'verify', 'upload', 'check', 'mongo', 'player', 'done'];
const LIVE_STAGES = { migrate: STAGES, check: ['resolve', 'download', 'verify', 'done'], revert: ['resolve', 'download', 'verify', 'mongo', 'done'] };
const KIND_LABEL = { migrate: 'Migrate', check: 'Check IPFS', revert: 'Revert' };
const STORE_LABEL = { ipfs: 'IPFS', hot: 'Hotnode + S3', archived: 'S3', other: 'Unknown' };

const state = { me: { user: null, authorized: false }, status: null, channel: null, rows: [], picked: new Set(), jobs: new Map(), progress: new Map() };

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v;   // CSSOM: allowed by the CSP, a style attribute is not
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}

const mb = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`);
const ago = (iso) => (iso ? new Date(iso).toLocaleString() : '');

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function notice(text, kind = 'info') {
  const n = $('#notice');
  n.textContent = text;
  n.className = `notice ${kind === 'error' ? 'error' : ''}`;
  n.hidden = !text;
}

// ---------------------------------------------------------------- session

function renderSession() {
  const { user, authorized } = state.me;
  $('#login').hidden = !!user;
  $('#session').hidden = !user;
  if (user) {
    $('#session-user').textContent = `@${user}`;
    const b = $('#session-badge');
    b.textContent = authorized ? 'Can migrate' : 'View only';
    b.className = `badge ${authorized ? 'ok' : 'view'}`;
  }
  renderVideos();
}

async function login(e) {
  e.preventDefault();
  const user = $('#login-user').value.trim().toLowerCase().replace(/^@/, '');
  if (!window.hive_keychain) return notice('Hive Keychain is not installed in this browser. Install the extension, then reload the page.', 'error');
  try {
    const { message } = await api(`/api/auth/challenge?user=${encodeURIComponent(user)}`);
    const signature = await new Promise((resolve, reject) => {
      window.hive_keychain.requestSignBuffer(user, message, 'Posting', (r) => (r?.success ? resolve(r.result) : reject(new Error(r?.message || 'Keychain did not sign'))));
    });
    state.me = await api('/api/auth/verify', { method: 'POST', body: { user, message, signature } });
    notice(state.me.authorized ? '' : `Logged in as @${user}. This account can look but not migrate; ask for it to be added to the allowed list.`);
    renderSession();
  } catch (err) {
    notice(`Login failed: ${err.message}`, 'error');
  }
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
  state.me = { user: null, authorized: false };
  renderSession();
}

// ---------------------------------------------------------------- status

function renderFacts() {
  const s = state.status;
  if (!s) return;
  const fact = (k, v) => el('div', {}, el('dt', {}, k), el('dd', {}, v));
  $('#facts').replaceChildren(
    fact('Bucket', s.bucket),
    fact('Zone', s.cdnHost),
    fact('At a time', String(s.maxConcurrent)),
    fact('Player check', s.playerCheck ? 'on' : 'off'),
  );
  renderDisk(s.disk);
}

function renderDisk(d) {
  if (!d) return;
  const pct = Math.min(100, (d.used / d.budget) * 100);
  const free = d.free === null ? '' : `, ${mb(d.free)} free on disk (${mb(d.reserve)} kept free)`;
  $('#disk').replaceChildren(
    el('div', {}, `Work disk: ${mb(d.used)} of ${mb(d.budget)} budget${free}`),
    el('div', { class: `meter ${pct > 80 ? 'warn' : ''}` }, el('i', { style: `width:${pct}%` })),
  );
}

// ---------------------------------------------------------------- videos

const thumbUrl = (t) => {
  if (!t) return null;
  if (t.startsWith('https://')) return t;
  if (t.startsWith('ipfs://')) return `https://ipfs-3speak.b-cdn.net/ipfs/${t.slice(7)}`;
  return null;
};

async function loadChannel(e) {
  e?.preventDefault();
  const user = $('#channel').value.trim().toLowerCase().replace(/^@/, '');
  if (!user) return;
  try {
    notice('');
    const data = await api(`/api/channel/${encodeURIComponent(user)}`);
    state.channel = data.user;
    state.rows = data.rows;
    state.picked = new Set([...state.picked].filter((k) => data.rows.some((r) => key(r) === k && r.eligible)));
    renderVideos();
    history.replaceState(null, '', `#${user}`);
  } catch (err) {
    notice(`Could not load @${user}: ${err.message}`, 'error');
  }
}

const key = (r) => `${r.collection}:${r.id}`;
const canAct = () => state.me.authorized;
const busy = (r) => r.lastItem && ['queued', 'running'].includes(r.lastItem.status);

function renderVideos() {
  const rows = state.rows;
  const table = $('#videos');
  $('#videos-empty').hidden = !!state.channel;
  table.hidden = !state.channel;
  if (state.channel && !rows.length) {
    $('#videos-empty').hidden = false;
    $('#videos-empty').textContent = `@${state.channel} has no videos in either collection.`;
  }
  const why = canAct() ? null : (state.me.user ? `@${state.me.user} is not on the allowed list` : 'Log in with Keychain to act');

  const body = rows.map((r) => {
    const pickable = r.eligible && !busy(r) && canAct();
    const thumb = thumbUrl(r.thumbnail);
    const last = r.lastItem;
    const migrated = r.storage === 'archived' || r.storage === 'hot';
    const ours = migrated && r.migratedAt;
    return el('tr', { class: r.eligible || ours ? '' : 'off' },
      el('td', { class: 'c-pick' }, el('input', {
        type: 'checkbox', 'aria-label': `Select ${r.title}`, checked: state.picked.has(key(r)), disabled: !pickable,
        title: !r.eligible ? r.reason : why ?? undefined,
        onchange: (e) => { e.target.checked ? state.picked.add(key(r)) : state.picked.delete(key(r)); renderActions(); },
      })),
      el('td', {}, el('div', { class: 'video' },
        thumb ? el('img', { class: 'thumb', src: thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : el('span', { class: 'thumb' }),
        el('div', {},
          el('div', { class: 'v-title' }, r.title),
          el('div', { class: 'v-meta' },
            el('span', {}, r.permlink ?? ''), el('span', {}, r.collection === 'legacy' ? 'videos' : 'embed-video'),
            el('span', {}, r.status ?? ''), r.size ? el('span', {}, mb(r.size)) : null,
            r.created ? el('span', {}, new Date(r.created).toLocaleDateString()) : null),
          ours ? el('div', { class: 'v-ok' }, `In S3 since ${new Date(r.migratedAt).toLocaleString()}`)
            : r.eligible ? null : el('div', { class: 'v-why' }, `Not migratable: ${r.reason}`),
          last ? el('div', { class: `v-last ${last.status}` }, `${KIND_LABEL[last.kind] ?? last.kind}: ${last.status}${last.stage && last.status === 'running' ? ` (${last.stage})` : ''}${last.error && last.status === 'failed' ? `: ${last.error}` : ''}`) : null,
        ))),
      el('td', { class: 'c-store' }, el('span', { class: `store ${r.storage}` }, STORE_LABEL[r.storage] ?? r.storage)),
      el('td', { class: 'c-cid mono', title: r.cid ?? undefined }, r.cid ? `${r.cid.slice(0, 6)}…${r.cid.slice(-6)}` : ''),
      el('td', { class: 'c-do' },
        state.status?.player && r.permlink && r.owner ? el('button', { class: 'btn small quiet', type: 'button', title: 'Play it in the real player and see where it plays from', onclick: () => openPreview(r) }, 'Play') : null,
        r.cid ? el('button', { class: 'btn small', type: 'button', disabled: !canAct() || busy(r), title: why ?? 'Download from the IPFS nodes and verify every block', onclick: () => single('check-ipfs', r) }, 'Check IPFS') : null,
        migrated && r.migratedAt ? el('button', { class: 'btn small danger', type: 'button', disabled: !canAct() || busy(r), title: why ?? 'Check IPFS, then play from IPFS again', onclick: () => single('revert', r) }, 'Revert') : null,
      ),
    );
  });
  table.tBodies[0].replaceChildren(...body);
  renderActions();
}

function renderActions() {
  const eligible = state.rows.filter((r) => r.eligible && !busy(r));
  const all = $('#select-all');
  all.disabled = !canAct() || !eligible.length;
  all.checked = eligible.length > 0 && eligible.every((r) => state.picked.has(key(r)));
  $('#select-all-label').textContent = `Select all eligible (${eligible.length})`;
  const n = state.picked.size;
  for (const id of ['#dry-run', '#migrate']) {
    const b = $(id);
    b.disabled = !canAct() || !n;
    b.title = canAct() ? '' : (state.me.user ? `@${state.me.user} is not on the allowed list` : 'Log in with Keychain to act');
  }
  $('#migrate').textContent = n ? `Migrate ${n} selected` : 'Migrate selected';
}

function toggleAll(e) {
  for (const r of state.rows) if (r.eligible && !busy(r)) e.target.checked ? state.picked.add(key(r)) : state.picked.delete(key(r));
  renderVideos();
}

const pickedItems = () => [...state.picked].map((k) => { const [collection, id] = k.split(':'); return { collection, id }; });

// ---------------------------------------------------------------- dry run + migrate

async function showPlan() {
  let plan;
  try {
    ({ plan } = await api('/api/dry-run', { method: 'POST', body: { items: pickedItems() } }));
  } catch (err) { return notice(`Dry run failed: ${err.message}`, 'error'); }
  const ok = plan.filter((p) => p.eligible);
  $('#plan-summary').textContent = ok.length === plan.length
    ? `${ok.length} video(s) would be copied. Nothing has been written yet.`
    : `${ok.length} of ${plan.length} would be copied; the others are skipped (reasons below). Nothing has been written yet.`;
  $('#plan-body').replaceChildren(...plan.map((p) => el('div', { class: `plan-row ${p.eligible ? '' : 'no'}` },
    el('h3', {}, p.title ?? p.id),
    p.eligible
      ? [
        el('div', {}, `CID `, el('span', { class: 'mono' }, p.cid), `, manifest ${p.manifestPath}`),
        el('div', {}, `In S3 already: ${p.s3.objectsAlready} object(s) under ${p.s3.prefix}${p.s3.carAlready ? ', and the CAR' : ''}`),
        el('pre', {}, `Mongo $set (only if unchanged):\n${JSON.stringify(p.wouldSet, null, 2)}`),
      ]
      : el('div', {}, `Skipped: ${p.reason}`),
  )));
  $('#plan-confirm').disabled = !ok.length;
  $('#plan-confirm').textContent = ok.length ? `Start migration (${ok.length})` : 'Nothing to migrate';
  $('#plan').showModal();
}

async function onPlanClose() {
  if ($('#plan').returnValue !== 'confirm') return;
  try {
    const r = await api('/api/jobs', { method: 'POST', body: { items: pickedItems(), channel: state.channel } });
    state.picked.clear();
    notice(r.jobId ? `Queued ${r.added.length} video(s) as job ${r.jobId}.${r.skipped.length ? ` ${r.skipped.length} skipped.` : ''}` : 'Nothing was queued.');
    await refreshJobs();
    await loadChannel();
  } catch (err) { notice(`Could not start: ${err.message}`, 'error'); }
}

function ask(title, text, yes) {
  return new Promise((resolve) => {
    $('#ask-title').textContent = title;
    $('#ask-text').textContent = text;
    $('#ask-yes').textContent = yes;
    const d = $('#ask');
    d.addEventListener('close', () => resolve(d.returnValue === 'yes'), { once: true });
    d.returnValue = '';
    d.showModal();
  });
}

async function single(action, r) {
  const verb = action === 'revert' ? 'Revert' : 'Check IPFS';
  if (action === 'revert' && !(await ask(`Revert "${r.title}"?`,
    'It is downloaded from the IPFS nodes and checked first. Only if it is complete there does the player go back to IPFS. The S3 copy stays.',
    'Check, then revert'))) return;
  try {
    await api(`/api/items/${action}`, { method: 'POST', body: { collection: r.collection, id: r.id } });
    notice(`${verb} queued for "${r.title}".`);
    await refreshJobs();
    await loadChannel();
  } catch (err) { notice(`${verb} failed: ${err.message}`, 'error'); }
}

// ---------------------------------------------------------------- queue

async function refreshJobs() {
  const jobs = await api('/api/jobs');
  const detailed = await Promise.all(jobs.slice(0, 8).map((j) => api(`/api/jobs/${j.id}`).catch(() => null)));
  state.jobs = new Map(detailed.filter(Boolean).map((j) => [j.id, j]));
  renderJobs();
}

function railFor(item) {
  const stages = LIVE_STAGES[item.kind] ?? STAGES;
  const p = state.progress.get(item.id) ?? item.progress ?? {};
  const current = item.status === 'done' ? 'done' : (p.stage ?? item.stage ?? 'resolve');
  const at = Math.max(0, stages.indexOf(current));
  let frac = null;
  if (current === 'upload' && p.bytesTotal) frac = p.bytesDone / p.bytesTotal;
  else if (current === 'check' && p.total) frac = p.checked / p.total;
  const cls = ['rail', item.status === 'done' ? 'done' : '', item.status === 'failed' ? 'failed' : '', item.status === 'running' && frac === null ? 'indeterminate' : ''].join(' ');
  return el('div', { class: cls, role: 'img', 'aria-label': `${item.status}, stage ${current}` },
    stages.slice(0, -1).map((s, i) => el('span', { class: i < at ? 'past' : i === at && item.status !== 'queued' ? 'now' : '', title: s },
      i === at && item.status === 'running' ? el('i', { style: frac === null ? '' : `width:${Math.round(frac * 100)}%` }) : null)));
}

function itemDetailText(item) {
  const p = state.progress.get(item.id) ?? item.progress ?? {};
  if (item.status !== 'running') return null;
  if (p.stage === 'download' && p.bytesDone) return `Downloaded ${mb(p.bytesDone)}`;
  if (p.stage === 'verify' && p.files) return `Verified ${p.files} file(s), ${mb(p.bytes)}`;
  if (p.stage === 'verify' && p.blocks) return `Checked ${p.blocks} blocks`;
  if (p.stage === 'upload' && p.bytesTotal) return `Uploaded ${mb(p.bytesDone)} of ${mb(p.bytesTotal)}, file ${p.filesDone} of ${p.filesTotal}`;
  if (p.stage === 'check' && p.total) return `Read back ${p.checked} of ${p.total}`;
  return p.stage ? `${p.stage}…` : null;
}

function renderJobs() {
  const jobs = [...state.jobs.values()].sort((a, b) => b.id - a.id);
  $('#jobs-empty').hidden = jobs.length > 0;
  $('#jobs').replaceChildren(...jobs.map((j) => {
    const finished = j.done + j.failed + j.cancelled;
    const active = j.queued + j.running > 0;
    return el('li', { class: 'job' },
      el('div', { class: 'job-head' },
        el('span', { class: 'job-title' }, `${KIND_LABEL[j.kind] ?? 'Migrate'}${j.channel ? ` @${j.channel}` : ''}`),
        active && canAct() ? el('button', { class: 'btn small quiet', type: 'button', onclick: () => api(`/api/jobs/${j.id}/cancel`, { method: 'POST', body: {} }).then(refreshJobs) }, 'Cancel') : null),
      el('div', { class: 'job-sub' }, `Job ${j.id} by ${j.created_by}, ${ago(j.created_at)}. ${j.done} done${j.failed ? `, ${j.failed} failed` : ''}${j.cancelled ? `, ${j.cancelled} cancelled` : ''} of ${j.total}`),
      el('div', { class: 'meter' }, el('i', { style: `width:${j.total ? (finished / j.total) * 100 : 0}%` })),
      el('ol', { class: 'items' }, j.items.map((it) => {
        const warned = it.status === 'done' && (it.result?.warnings?.length || it.result?.player?.ok === false);
        return el('li', { class: 'item', tabindex: '0', onclick: () => showItem(it.id), onkeydown: (e) => { if (e.key === 'Enter') showItem(it.id); } },
          el('div', { class: 'item-head' },
            el('span', { class: 'item-name' }, it.title ?? it.permlink ?? it.doc_id),
            el('span', { class: `item-state ${warned ? 'warn' : it.status}` }, warned ? 'done, see notes' : it.status)),
          railFor(it),
          itemDetailText(it) ? el('div', { class: 'item-detail' }, itemDetailText(it)) : null,
          it.status === 'failed' || (it.status === 'queued' && it.error) ? el('div', { class: 'item-err' }, it.status === 'queued' ? `Retrying: ${it.error}` : it.error) : null);
      })));
  }));
}

async function showItem(id) {
  const it = await api(`/api/items/${id}`);
  $('#detail-title').textContent = it.title ?? it.permlink ?? `Item ${id}`;
  const r = it.result;
  $('#detail-body').replaceChildren(
    el('div', {}, `${KIND_LABEL[it.kind]}: ${it.status}, attempt ${it.attempts}`),
    it.cid ? el('div', {}, 'CID ', el('span', { class: 'mono' }, it.cid)) : null,
    r?.bytes ? el('div', {}, `${r.files} files, ${mb(r.bytes)}, CAR ${mb(r.carBytes)} from ${r.gateway}; ${r.uploaded} uploaded, ${r.skipped} already there`) : null,
    r?.player ? el('div', {}, `Player check: ${r.player.ok ? 'passed' : 'FAILED'}, ${r.player.detail}`) : null,
    it.error ? el('div', { class: 'item-err' }, it.error) : null,
    el('ol', { class: 'events' }, it.events.map((e) => el('li', { class: e.level }, el('time', {}, new Date(e.at).toLocaleTimeString()), e.message))),
  );
  $('#detail').showModal();
}

// ---------------------------------------------------------------- preview

// The real player in a frame. It reports every playlist and segment it loads (see
// public/sources.js), so this shows where the video really plays from: a migrated
// video that fell back to IPFS plays just as well, and only this tells them apart.
const MAX_REPORTS = 5000;
const SILENCE_MS = 20_000;
let preview = null;

// Strict (the default): the player plays only from the source Mongo assigns, with
// no fallback, so a broken copy fails here instead of hiding behind IPFS. "Like a
// viewer" is normal playback, fallbacks and all.
function openPreview(r) {
  preview = { row: r, strict: true };
  $('#preview-title').textContent = r.title;
  for (const input of document.querySelectorAll('input[name="preview-mode"]')) input.checked = input.value === 'strict';
  loadPreviewFrame();
  $('#preview').showModal();
}

function loadPreviewFrame() {
  const p = preview;
  stopPreviewFrame(p);
  const s = state.status;
  const src = embedUrl(s.player, p.row, { strict: p.strict });
  const origin = new URL(s.player).origin;
  const frame = el('iframe', { src, title: `Player: ${p.row.title}`, allow: 'autoplay; fullscreen; picture-in-picture' });
  Object.assign(p, { reports: [], frame, loadedAt: null, timer: null, raf: 0 });
  p.onMessage = (e) => {
    if (e.source !== frame.contentWindow || e.origin !== origin) return;
    const m = e.data;
    if (!m || m.type !== SOURCE_MESSAGE || typeof m.url !== 'string' || !['playlist', 'segment'].includes(m.kind)) return;
    if (p.reports.length < MAX_REPORTS) p.reports.push({ kind: m.kind, url: m.url, ok: m.ok === true, proxied: m.proxied === true, strict: m.strict === true, at: Date.now() });
    if (!p.raf) p.raf = requestAnimationFrame(() => { p.raf = 0; renderPreview(); });
  };
  frame.addEventListener('load', () => { p.loadedAt = Date.now(); clearTimeout(p.timer); p.timer = setTimeout(renderPreview, SILENCE_MS); });
  addEventListener('message', p.onMessage);
  $('#preview-open').href = src;
  $('#preview-frame').replaceChildren(frame);
  renderPreview();
}

function stopPreviewFrame(p) {
  if (!p?.onMessage) return;
  removeEventListener('message', p.onMessage);
  clearTimeout(p.timer);
  cancelAnimationFrame(p.raf);
  p.onMessage = null;
  $('#preview-frame').replaceChildren();   // stops playback
}

function closePreview() {
  stopPreviewFrame(preview);
  preview = null;
}

function setPreviewMode(e) {
  if (!preview || e.target.name !== 'preview-mode') return;
  preview.strict = e.target.value === 'strict';
  loadPreviewFrame();
}

function renderPreview() {
  const p = preview;
  if (!p) return;
  const hosts = state.status.sourceHosts;
  const sum = summarize(p.reports, hosts, p.row.storage, { strict: p.strict });
  let { level, text } = sum.verdict;
  if (!p.reports.length && p.loadedAt && Date.now() - p.loadedAt >= SILENCE_MS) {
    level = 'info';
    text = 'No reports from the player yet. If the video is playing, the player is an older version that does not report its sources (it needs SnapieVideoPlayer #64).';
  }
  const v = $('#preview-verdict');
  v.textContent = text;
  v.className = `verdict ${level}`;
  const stored = STORE_LABEL[p.row.storage] ?? p.row.storage;
  const tail = (url) => { try { const u = new URL(url); return u.pathname.split('/').slice(-2).join('/'); } catch (_) { return url; } };
  $('#preview-body').replaceChildren(
    el('div', {}, 'Mongo says it plays from ', el('span', { class: `store ${p.row.storage}` }, stored)),
    sum.groups.length ? el('table', { class: 'table sources' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Source'), el('th', { class: 'num' }, 'Playlists'), el('th', { class: 'num' }, 'Segments'))),
      el('tbody', {}, sum.groups.map((g) => el('tr', {},
        el('td', {}, el('span', { class: `src ${g.kind}` }, g.label)),
        el('td', { class: 'num' }, String(g.playlists)),
        el('td', { class: 'num' }, String(g.segments)))))) : null,
    p.reports.length ? el('details', {},
      el('summary', {}, `Last requests (${p.reports.length})`),
      el('ol', { class: 'events' }, p.reports.slice(-12).reverse().map((x) => el('li', { class: x.ok ? '' : 'error', title: x.url },
        el('time', {}, new Date(x.at).toLocaleTimeString()),
        `${x.ok ? '' : 'failed: '}${x.kind} ${tail(x.url)} from ${classify(x.url, hosts).label}${x.proxied ? ', through the player' : ''}`)))) : null,
  );
}

// ---------------------------------------------------------------- live updates

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('hello', (e) => { $('#live').textContent = 'live'; $('#live').className = 'live on'; renderDisk(JSON.parse(e.data).disk); });
  es.addEventListener('disk', (e) => renderDisk(JSON.parse(e.data)));
  es.addEventListener('progress', (e) => {
    const p = JSON.parse(e.data);
    state.progress.set(p.itemId, p);
    const job = state.jobs.get(p.jobId);
    const it = job?.items.find((i) => i.id === p.itemId);
    if (it) { it.stage = p.stage; renderJobs(); }
  });
  let pending = null;
  es.addEventListener('item', (e) => {
    const row = JSON.parse(e.data);
    if (row.status !== 'running') state.progress.delete(row.id);
    // Status changes: refresh the queue (and the table when something finishes), batched.
    clearTimeout(pending);
    pending = setTimeout(() => {
      refreshJobs().catch(() => {});
      if (state.channel && ['done', 'failed', 'cancelled'].includes(row.status)) loadChannel().catch(() => {});
    }, 300);
  });
  es.onerror = () => { $('#live').textContent = 'reconnecting'; $('#live').className = 'live'; };
}

// ---------------------------------------------------------------- boot

$('#login').addEventListener('submit', login);
$('#logout').addEventListener('click', logout);
$('#channel-form').addEventListener('submit', loadChannel);
$('#select-all').addEventListener('change', toggleAll);
$('#dry-run').addEventListener('click', showPlan);
$('#migrate').addEventListener('click', showPlan);
$('#plan').addEventListener('close', onPlanClose);
$('#preview').addEventListener('close', closePreview);
$('#preview-mode').addEventListener('change', setPreviewMode);

(async () => {
  try { state.me = await api('/api/me'); } catch (_) { /* logged out */ }
  renderSession();
  try { state.status = await api('/api/status'); renderFacts(); } catch (_) { /* shown as missing facts */ }
  await refreshJobs().catch(() => {});
  connect();
  const fromHash = decodeURIComponent(location.hash.slice(1));
  if (fromHash) { $('#channel').value = fromHash; loadChannel(); }
})();
