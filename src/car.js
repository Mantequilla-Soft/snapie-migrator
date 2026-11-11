/**
 * CAR export: download, verify, walk (SPEC §2, §3 steps 3–4).
 *
 * A CAR is the video's IPFS blocks packed into one file, exactly as IPFS stores them.
 * We keep it so `ipfs dag import` can revive the video under the same CID, and we
 * use it to prove the copy is complete and correct:
 *   1. its single root is the CID we asked for,
 *   2. every block's hash matches its CID (nothing corrupted), and
 *   3. the whole directory can be walked from the root (nothing missing).
 * Only then is the file list (path, size, sha256, md5) handed to the uploader.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { CarIndexedReader } from '@ipld/car/indexed-reader';
import { exporter } from 'ipfs-unixfs-exporter';
import { CID } from 'multiformats/cid';
import { CancelledError, OutOfSpaceError, VerifyError, throwIfAborted } from './errors.js';

const SHA2_256 = 0x12;
const IDENTITY = 0x00;
const CAR_TYPE = 'application/vnd.ipld.car';
// No byte from a gateway for this long: give up on it and try the next one.
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

/**
 * Download `<gateway>/ipfs/<cid>/` as a CAR to `dest`, trying each gateway in order.
 * The header form with a trailing slash and no query string is the one the hotnode's
 * nginx serves (it 302-redirects `?format=car` and the bare `/ipfs/<cid>`).
 * → { gateway, bytes, md5, sha256, attempts: [{ gateway, error }] }
 */
export async function downloadCar({
  cid, gateways, dest, budget, throttle, signal, onProgress = () => {},
  fetchImpl = fetch, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
}) {
  const attempts = [];
  for (const gateway of gateways) {
    throwIfAborted(signal);
    try {
      const result = await downloadFrom({ gateway, cid, dest, budget, throttle, signal, onProgress, fetchImpl, idleTimeoutMs });
      return { gateway, ...result, attempts };
    } catch (err) {
      await fs.promises.rm(dest, { force: true });
      // Out of space or cancelled: another gateway won't help.
      if (err instanceof OutOfSpaceError || err instanceof CancelledError) throw err;
      attempts.push({ gateway, error: err.message });
    }
  }
  const err = new Error(`no gateway served the CAR: ${attempts.map((a) => `${a.gateway}: ${a.error}`).join('; ')}`);
  err.attempts = attempts;
  throw err;
}

async function downloadFrom({ gateway, cid, dest, budget, throttle, signal, onProgress, fetchImpl, idleTimeoutMs }) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let idle;
  const arm = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(new Error('idle timeout')), idleTimeoutMs); };

  let fh = null;
  let written = 0;
  try {
    arm();
    let res;
    try {
      res = await fetchImpl(`${gateway}/ipfs/${cid}/`, {
        headers: { Accept: CAR_TYPE },
        redirect: 'manual',      // a redirect means this gateway won't give us a CAR
        signal: ctrl.signal,
      });
    } catch (e) {
      if (signal?.aborted) throw new CancelledError();
      throw new Error(ctrl.signal.reason?.message === 'idle timeout' ? 'timed out' : e.message, { cause: e });
    }
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (!type.startsWith(CAR_TYPE)) throw new Error(`not a CAR (content-type "${type}")`);

    const md5 = crypto.createHash('md5');
    const sha256 = crypto.createHash('sha256');
    fh = await fs.promises.open(dest, 'w');
    const reader = res.body.getReader();
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (signal?.aborted) throw new CancelledError();
        throw new Error(ctrl.signal.reason?.message === 'idle timeout' ? 'stalled (idle timeout)' : `read failed: ${e.message}`, { cause: e });
      }
      if (chunk.done) break;
      const buf = chunk.value;
      arm();
      await budget.take(buf.length);
      written += buf.length;
      await throttle?.take(buf.length, signal);
      await fh.write(buf);
      md5.update(buf);
      sha256.update(buf);
      onProgress({ bytes: written });
    }
    await fh.close();
    fh = null;
    if (written === 0) throw new Error('empty response');
    return { bytes: written, md5: md5.digest('hex'), sha256: sha256.digest('hex') };
  } catch (err) {
    budget.release(written);
    throw err;
  } finally {
    clearTimeout(idle);
    signal?.removeEventListener('abort', onAbort);
    if (fh) await fh.close().catch(() => {});
  }
}

function verifyBlock(cid, bytes) {
  const { code, digest } = cid.multihash;
  if (code === SHA2_256) {
    const got = crypto.createHash('sha256').update(bytes).digest();
    if (!got.equals(Buffer.from(digest))) throw new VerifyError(`block ${cid} does not match its hash`);
  } else if (code === IDENTITY) {
    if (!Buffer.from(digest).equals(Buffer.from(bytes))) throw new VerifyError(`identity block ${cid} does not match`);
  } else {
    throw new VerifyError(`block ${cid} uses hash 0x${code.toString(16)}, which we can't verify`);
  }
}

// Names we will turn into S3 keys. IPFS allows almost anything; S3 keys and the
// player's URL handling do not, so anything odd stops the job for a human to look at.
const SAFE_NAME = /^[^/\\\0]+$/;

async function* walk(cid, path, blockstore, signal) {
  throwIfAborted(signal);
  const entry = await exporter(cid, blockstore, { signal });
  if (entry.type === 'directory') {
    for await (const child of entry.entries({ signal })) {
      if (!SAFE_NAME.test(child.name) || child.name === '.' || child.name === '..') {
        throw new VerifyError(`unusable file name ${JSON.stringify(child.name)} in ${path || '/'}`);
      }
      yield* walk(child.cid, path ? `${path}/${child.name}` : child.name, blockstore, signal);
    }
  } else if (entry.type === 'file' || entry.type === 'raw' || entry.type === 'identity') {
    yield { path, cid: entry.cid, entry };
  } else {
    throw new VerifyError(`unexpected ${entry.type} node at ${path || '/'}`);
  }
}

/**
 * Open a downloaded CAR and prove it is the complete, unmodified DAG of `cid`.
 * → { files: [{ path, cid, size, md5, sha256 }], bytes, blocks, readFile(file), close() }
 * The caller must call close().
 */
export async function openVerifiedCar(carPath, cidString, { signal, onProgress = () => {} } = {}) {
  const root = CID.parse(cidString);
  let reader;
  try {
    reader = await CarIndexedReader.fromFile(carPath);
  } catch (e) {
    throw new VerifyError(`CAR is unreadable (truncated or corrupt): ${e.message}`);
  }
  try {
    const roots = await reader.getRoots();
    if (roots.length !== 1 || !roots[0].equals(root)) {
      throw new VerifyError(`CAR root is ${roots.map(String).join(',') || 'missing'}, expected ${cidString}`);
    }

    // 2. every block matches its hash
    let blocks = 0;
    try {
      for await (const block of reader.blocks()) {
        verifyBlock(block.cid, block.bytes);
        if (++blocks % 256 === 0) { throwIfAborted(signal); onProgress({ step: 'blocks', blocks }); }
      }
    } catch (e) {
      // A truncated last block only shows up when it is read.
      throw e instanceof VerifyError || e instanceof CancelledError ? e : new VerifyError(`CAR is truncated or corrupt: ${e.message}`);
    }

    // 3. the whole directory walks from the root; a missing block fails here
    // ipfs-unixfs-exporter 16 wants get() to return an (async) iterable of chunks.
    const blockstore = {
      get: (c) => (async function* () {
        const b = await reader.get(c);
        if (!b) throw new VerifyError(`block ${c} is missing from the CAR`);
        yield b.bytes;
      })(),
    };
    const rootEntry = await exporter(root, blockstore, { signal }).catch((e) => { throw asVerify(e); });
    if (rootEntry.type !== 'directory') throw new VerifyError(`${cidString} is a ${rootEntry.type}, not a video directory`);

    const files = [];
    let bytes = 0;
    try {
      for await (const f of walk(root, '', blockstore, signal)) {
        const md5 = crypto.createHash('md5');
        const sha256 = crypto.createHash('sha256');
        let size = 0;
        for await (const chunk of f.entry.content({ signal })) {
          md5.update(chunk);
          sha256.update(chunk);
          size += chunk.length;
        }
        if (BigInt(size) !== BigInt(f.entry.size)) throw new VerifyError(`${f.path}: read ${size} bytes, the DAG says ${f.entry.size}`);
        files.push({ path: f.path, cid: f.cid.toString(), size, md5: md5.digest('hex'), sha256: sha256.digest('hex') });
        bytes += size;
        onProgress({ step: 'walk', files: files.length, bytes });
      }
    } catch (e) {
      throw asVerify(e);
    }
    if (!files.length) throw new VerifyError(`${cidString} has no files`);

    return {
      files,
      bytes,
      blocks,
      /** The file's bytes, streamed out of the CAR (nothing is unpacked to disk). */
      async *readFile(file) {
        const entry = await exporter(CID.parse(file.cid), blockstore, { signal });
        yield* entry.content({ signal });
      },
      close: () => reader.close(),
    };
  } catch (e) {
    await reader.close().catch(() => {});
    throw e;
  }
}

// The exporter wraps our blockstore errors in its own; a missing or bad block is a
// verification failure, not a network one.
function asVerify(e) {
  if (e instanceof VerifyError || e instanceof CancelledError) return e;
  if (e?.name === 'AbortError') return new CancelledError();
  return new VerifyError(`DAG walk failed: ${e?.message ?? e}`);
}
