// Where is the player really playing a video from? The page embeds the real player
// (SnapieVideoPlayer), which posts a '3speak-source' message for every playlist and
// segment it loads (its src/sourceReport.js). This file turns those reports into an
// answer. Plain functions, no DOM: the page uses them, and so do the tests.

export const SOURCE_MESSAGE = '3speak-source';

const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch (_) { return null; } };

/**
 * One report URL → { kind: 's3' | 'hot' | 'ipfs' | 'other', label, host }.
 * `hosts` comes from /api/status: { bucket, s3: [{ host, label }], hot: [host] }; any other
 * host under /ipfs/ is an IPFS gateway.
 * S3 only counts on our hosts AND under our bucket, like the player's own check.
 */
export function classify(url, hosts) {
  const host = hostOf(url);
  if (!host) return { kind: 'other', label: 'Unknown', host: null };
  let path = '';
  try { path = new URL(url).pathname; } catch (_) { /* host parsed, so this can't fail */ }
  const s3 = hosts.s3.find((h) => h.host === host);
  if (s3 && path.startsWith(`/${hosts.bucket}/`)) return { kind: 's3', label: s3.label, host };
  if (hosts.hot.includes(host)) return { kind: 'hot', label: `Hotnode (${host})`, host };
  if (path.startsWith('/ipfs/')) return { kind: 'ipfs', label: `IPFS gateway (${host})`, host };
  return { kind: 'other', label: host, host };
}

/**
 * The player's embed URL for a row: legacy videos are /watch, embed-video ones /embed.
 * `strict`: play only from the source Mongo assigns (the player's ?strict=1).
 */
export function embedUrl(playerBase, row, { strict = false } = {}) {
  const page = row.collection === 'legacy' ? 'watch' : 'embed';
  const v = `${encodeURIComponent(row.owner)}/${encodeURIComponent(row.permlink)}`;
  return `${playerBase}/${page}?v=${v}&mode=iframe${strict ? '&strict=1' : ''}`;
}

// Strict mode only exists for a video with an S3 copy (the player's strictPlayback).
export const STRICT_APPLIES = new Set(['archived', 'hot']);

// Which sources Mongo says this video should play from.
const EXPECTED = { archived: ['s3'], hot: ['hot', 's3'], ipfs: ['hot', 'ipfs'] };

/**
 * All reports so far → { groups, segments, failed, strictOn, verdict: { level, text } }.
 * groups: one per source label, with its playlist and segment counts.
 * level: 'wait' (no segment yet), 'ok', 'warn' (not where Mongo says), 'info'.
 * `strict`: the preview asked the player for strict playback.
 */
export function summarize(reports, hosts, storage, { strict = false } = {}) {
  const out = viewerSummary(reports, hosts, storage);
  out.strictOn = reports.some((r) => r.strict === true);
  if (!strict) return out;
  const v = out.verdict;
  if (!STRICT_APPLIES.has(storage)) {
    out.verdict = { level: v.level, text: `${v.text} (Strict mode only applies to a video with an S3 copy, so this one plays as usual.)` };
  } else if (!out.strictOn) {
    if (reports.length) out.verdict = { level: v.level === 'ok' ? 'info' : v.level, text: `The player ignored strict mode (an older version), so this is normal playback. ${v.text}` };
  } else {
    out.verdict = strictVerdict(out, storage);
  }
  return out;
}

// In strict mode nothing falls back: every failure is the assigned source failing,
// and every segment must come from it.
function strictVerdict(out, storage) {
  const { failed, segments } = out;
  const where = storage === 'archived' ? 'the S3 copy' : 'the hotnode';
  const want = storage === 'archived' ? 's3' : 'hot';
  const fromIt = out.groups.filter((g) => g.kind === want).reduce((n, g) => n + g.segments, 0);
  if (failed) return { level: 'warn', text: `Strict: ${failed} request${failed === 1 ? '' : 's'} to ${where} failed, and nothing falls back in strict mode. ${segments} segment${segments === 1 ? '' : 's'} loaded.` };
  if (!segments) return { level: 'wait', text: `Strict: playing from ${where} only. Press play.` };
  if (fromIt !== segments) return { level: 'warn', text: `Strict: ${segments - fromIt} of ${segments} segments came from somewhere other than ${where}, although strict mode was on.` };
  const hint = storage === 'hot' ? ' (For a hot video the assigned source is the hotnode; S3 is its backup and is not tested here.)' : '';
  return { level: 'ok', text: `Strict: every segment came from ${where} (${segments}), with no fallback.${hint}` };
}

function viewerSummary(reports, hosts, storage) {
  const groups = new Map();
  let segments = 0, failed = 0, proxied = 0;
  const byKind = { s3: 0, hot: 0, ipfs: 0, other: 0 };
  for (const r of reports) {
    if (!r.ok) { failed++; continue; }
    const c = classify(r.url, hosts);
    const g = groups.get(c.label) ?? { label: c.label, kind: c.kind, playlists: 0, segments: 0 };
    if (r.kind === 'playlist') g.playlists++;
    else { g.segments++; segments++; byKind[c.kind]++; if (r.proxied) proxied++; }
    groups.set(c.label, g);
  }
  const out = { groups: [...groups.values()].sort((a, b) => b.segments - a.segments || b.playlists - a.playlists), segments, failed, proxied };
  const notes = [];
  if (failed) notes.push(`${failed} request${failed === 1 ? '' : 's'} failed.`);
  if (proxied) notes.push(`${proxied} segment${proxied === 1 ? '' : 's'} came through the player's server.`);
  const tail = notes.length ? ` ${notes.join(' ')}` : '';

  if (!segments) {
    out.verdict = { level: 'wait', text: failed ? `No segment has loaded yet.${tail}` : 'Press play. The sources show here as the player loads segments.' };
    return out;
  }
  const expected = EXPECTED[storage] ?? [];
  const off = segments - expected.reduce((n, k) => n + byKind[k], 0);
  if (storage === 'archived') {
    // A few fallbacks happen when S3 is slow for a moment: the player's router gives
    // each S3 host a second or two per segment. None from S3 at all is the alarm.
    if (!off) out.verdict = { level: 'ok', text: `Every segment so far came from S3 (${segments}).${tail}` };
    else if (off === segments) out.verdict = { level: 'warn', text: `None of the ${segments} segments came from S3. The player fell back to IPFS for all of them, so the S3 copy may be broken or unreachable.${tail}` };
    else out.verdict = { level: 'info', text: `${off} of ${segments} segments came from IPFS instead of S3: S3 was too slow for them when the player asked. The other ${segments - off} came from S3.${tail}` };
  } else if (storage === 'hot') {
    out.verdict = off
      ? { level: 'info', text: `${off} of ${segments} segments came from IPFS gateways instead of the hotnode or S3.${tail}` }
      : { level: 'ok', text: `Every segment so far came from the hotnode or its S3 backup (${segments}).${tail}` };
  } else if (storage === 'ipfs') {
    out.verdict = byKind.s3
      ? { level: 'warn', text: `${byKind.s3} of ${segments} segments came from S3, but Mongo has no S3 copy for this video.${tail}` }
      : { level: 'ok', text: `Every segment so far came from IPFS (${segments}).${tail}` };
  } else {
    out.verdict = { level: 'info', text: `${segments} segment${segments === 1 ? '' : 's'} loaded.${tail}` };
  }
  return out;
}
