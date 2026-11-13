/**
 * Playback check over HTTPS (SPEC §3 step 6): fetch what a viewer's player would
 * fetch, through the Bunny zone AND straight from s3.3speak.tv, and compare every
 * byte with the source:
 *   - the master manifest and every playlist it names,
 *   - the first and last segment of each media playlist (plus its init segment).
 * This catches what a listing can't: a bucket that isn't public, a CDN zone pointed
 * at the wrong origin, wrong content types.
 */
import crypto from 'node:crypto';
import path from 'node:path/posix';
import { VerifyError, throwIfAborted } from './errors.js';

export const DEFAULT_READBACK_TIMEOUT_MS = 60_000;

// URIs a playlist points at: plain lines, and URI="…" in EXT-X-MEDIA / -MAP / -I-FRAME-STREAM-INF.
export function playlistRefs(text) {
  const refs = [];
  let isMaster = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-STREAM-INF') || line.startsWith('#EXT-X-I-FRAME-STREAM-INF')) isMaster = true;
      const m = line.match(/^#EXT-X-(MEDIA|MAP|I-FRAME-STREAM-INF)[:,].*?URI="([^"]+)"/);
      if (m) refs.push({ uri: m[2], kind: m[1] === 'MAP' ? 'init' : 'playlist' });
      continue;
    }
    refs.push({ uri: line, kind: null });
  }
  // Plain lines are playlists in a master playlist, segments in a media playlist.
  for (const r of refs) if (!r.kind) r.kind = isMaster ? 'playlist' : 'segment';
  return { isMaster, refs };
}

/** Resolve a playlist reference to a path inside the directory, or explain why not. */
function resolveRef(fromPath, uri) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.startsWith('//')) return { warning: `absolute URI ${uri} in ${fromPath}` };
  if (uri.startsWith('/')) return { warning: `root-relative URI ${uri} in ${fromPath}` };
  const clean = uri.split(/[?#]/)[0];
  const p = path.normalize(path.join(path.dirname(fromPath), decodeURIComponent(clean)));
  if (p.startsWith('..')) return { warning: `URI ${uri} in ${fromPath} leaves the video directory` };
  return { path: p };
}

/**
 * Which files to fetch back, starting at the manifest. Problems in the playlists
 * (absolute URIs, files the DAG doesn't have) are warnings: the copy is still exact,
 * the video was like that on IPFS too.
 * → { paths: string[], warnings: string[] }
 */
export async function planReadback(manifestPath, filesByPath, readText) {
  const warnings = [];
  const picked = new Set([manifestPath]);
  const seen = new Set();
  const queue = [manifestPath];
  while (queue.length) {
    const pl = queue.shift();
    if (seen.has(pl)) continue;
    seen.add(pl);
    const { refs } = playlistRefs(await readText(pl));
    const segments = [];
    for (const r of refs) {
      const res = resolveRef(pl, r.uri);
      if (res.warning) { warnings.push(res.warning); continue; }
      if (!filesByPath.has(res.path)) { warnings.push(`${pl} names ${res.path}, which is not in the directory`); continue; }
      if (r.kind === 'playlist') { picked.add(res.path); queue.push(res.path); }
      else if (r.kind === 'init') picked.add(res.path);
      else segments.push(res.path);
    }
    if (segments.length) { picked.add(segments[0]); picked.add(segments[segments.length - 1]); }
  }
  return { paths: [...picked], warnings };
}

export const publicUrl = (host, bucket, key) =>
  `https://${host}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;

/**
 * Fetch each path from each host and compare its SHA-256. Throws VerifyError on the
 * first mismatch or failure, naming the host and file.
 */
export async function readBack({ s3, cid, paths, filesByPath, fetchImpl = fetch, signal, timeoutMs = DEFAULT_READBACK_TIMEOUT_MS, onProgress = () => {} }) {
  const hosts = [s3.cdnHost, s3.directHost];
  let done = 0;
  for (const host of hosts) {
    for (const p of paths) {
      throwIfAborted(signal);
      const url = publicUrl(host, s3.bucket, `${cid}/${p}`);
      const want = filesByPath.get(p);
      const attemptSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      let res;
      try {
        res = await fetchImpl(url, { signal: attemptSignal, headers: { 'cache-control': 'no-cache' } });
      } catch (e) {
        throwIfAborted(signal);
        throw new VerifyError(`${host}: ${p} could not be fetched (${e.message})`, { code: 'readback_failed' });
      }
      if (res.status !== 200) throw new VerifyError(`${host}: ${p} answered HTTP ${res.status}`, { code: 'readback_failed' });
      const body = Buffer.from(await res.arrayBuffer());
      const sha = crypto.createHash('sha256').update(body).digest('hex');
      if (body.length !== want.size || sha !== want.sha256) {
        throw new VerifyError(`${host}: ${p} came back different (${body.length} bytes, expected ${want.size})`, { code: 'readback_failed' });
      }
      onProgress({ checked: ++done, total: hosts.length * paths.length });
    }
  }
  return { checked: done, hosts };
}
