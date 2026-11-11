import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { downloadCar, openVerifiedCar } from '../src/car.js';
import { DiskBudget } from '../src/disk.js';
import { CancelledError, OutOfSpaceError, VerifyError } from '../src/errors.js';
import { buildDag, carBytes, videoFiles, writeCar } from './helpers/car.js';

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
let dir, files, dag, good;

beforeAll(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'migrator-car-'));
  files = videoFiles({ segments: 3, segmentBytes: 5000 });
  dag = await buildDag(files);
  good = await carBytes([dag.cid], dag.blocks);
});
afterAll(() => fs.promises.rm(dir, { recursive: true, force: true }));

const carFile = async (name, bytes) => { const p = path.join(dir, name); await fs.promises.writeFile(p, bytes); return p; };
const budget = (over = {}) => new DiskBudget({ dir, budgetBytes: 1e9, reserveBytes: 0, statfs: async () => ({ bavail: 1e9, bsize: 1 }), ...over });

describe('openVerifiedCar', () => {
  it('accepts the complete DAG and lists every file with its hashes', async () => {
    const car = await openVerifiedCar(await carFile('good.car', good), dag.cid.toString());
    try {
      expect(car.blocks).toBe(dag.blocks.length);
      expect(car.files.map((f) => f.path).sort()).toEqual(files.map((f) => f.path).sort());
      for (const f of files) {
        const got = car.files.find((x) => x.path === f.path);
        expect(got).toMatchObject({ size: f.content.length, md5: md5(f.content) });
        const chunks = [];
        for await (const c of car.readFile(got)) chunks.push(c);
        expect(Buffer.concat(chunks).equals(f.content)).toBe(true);
      }
      expect(car.bytes).toBe(files.reduce((n, f) => n + f.content.length, 0));
    } finally { await car.close(); }
  });

  it('rejects a truncated CAR', async () => {
    const p = await carFile('trunc.car', good.subarray(0, Math.floor(good.length * 0.6)));
    await expect(openVerifiedCar(p, dag.cid.toString())).rejects.toThrow(VerifyError);
  });

  it('rejects a CAR with one byte changed in a block', async () => {
    const bad = Buffer.from(good);
    const seg = files.find((f) => f.path === '480p/480p_1.ts').content;
    const at = bad.indexOf(seg.subarray(100, 140));   // inside a data block
    expect(at).toBeGreaterThan(0);
    bad[at] ^= 0xff;
    await expect(openVerifiedCar(await carFile('tamper.car', bad), dag.cid.toString())).rejects.toThrow(/does not match its hash/);
  });

  it('rejects a CAR whose root is another CID', async () => {
    const other = await buildDag(videoFiles({ seed: 9 }));
    await expect(openVerifiedCar(await carFile('good2.car', good), other.cid.toString())).rejects.toThrow(/CAR root is/);
  });

  it('rejects a CAR with a block missing', async () => {
    const leaf = dag.blocks.find((b) => b.bytes.length > 900);  // a full data chunk
    const p = path.join(dir, 'missing.car');
    await writeCar(p, [dag.cid], dag.blocks.filter((b) => b !== leaf));
    await expect(openVerifiedCar(p, dag.cid.toString())).rejects.toThrow(/missing|DAG walk failed/);
  });

  it('rejects a CID that is a single file, not a directory', async () => {
    const single = dag.blocks.find((b) => b.cid.toString() !== dag.cid.toString());
    const p = path.join(dir, 'file.car');
    await writeCar(p, [single.cid], dag.blocks);
    await expect(openVerifiedCar(p, single.cid.toString())).rejects.toThrow(VerifyError);
  });

  it('rejects garbage', async () => {
    await expect(openVerifiedCar(await carFile('junk.car', Buffer.from('<html>not a car</html>')), dag.cid.toString())).rejects.toThrow(VerifyError);
  });
});

describe('downloadCar', () => {
  let server, base;
  const hits = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url);
      const [, gw] = req.url.split('/');
      if (req.headers.accept !== 'application/vnd.ipld.car') { res.writeHead(400); return res.end(); }
      if (gw === 'redirect') { res.writeHead(302, { location: '/elsewhere' }); return res.end(); }
      if (gw === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>'); }
      if (gw === 'down') { res.writeHead(502); return res.end(); }
      if (gw === 'stall') { res.writeHead(200, { 'content-type': 'application/vnd.ipld.car; version=1' }); res.write(good.subarray(0, 100)); return; }
      res.writeHead(200, { 'content-type': 'application/vnd.ipld.car; version=1; order=dfs; dups=n' });
      res.end(good);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => { server.closeAllConnections(); return new Promise((r) => server.close(r)); });

  const gws = (...names) => names.map((n) => `${base}/${n}`);
  const run = (names, over = {}) => downloadCar({
    cid: dag.cid.toString(), gateways: gws(...names), dest: path.join(dir, `dl-${Math.random()}.car`),
    budget: budget(), idleTimeoutMs: 300, ...over,
  });

  it('uses the header form with a trailing slash and no query string', async () => {
    hits.length = 0;
    const r = await run(['ok']);
    expect(hits).toEqual([`/ok/ipfs/${dag.cid}/`]);
    expect(r).toMatchObject({ gateway: `${base}/ok`, bytes: good.length, md5: md5(good), attempts: [] });
  });

  it('falls through redirects, non-CAR answers, errors and stalls to the next gateway', async () => {
    const dest = path.join(dir, 'fallback.car');
    const r = await run(['redirect', 'html', 'down', 'stall', 'ok'], { dest });
    expect(r.gateway).toBe(`${base}/ok`);
    expect(r.attempts.map((a) => a.error)).toEqual(['HTTP 302', 'not a CAR (content-type "text/html")', 'HTTP 502', 'stalled (idle timeout)']);
    expect((await fs.promises.readFile(dest)).equals(good)).toBe(true);
  });

  it('fails with every reason when no gateway serves it, and leaves no file', async () => {
    const dest = path.join(dir, 'none.car');
    await expect(run(['down', 'html'], { dest })).rejects.toThrow(/no gateway served the CAR: .*HTTP 502.*not a CAR/);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('stops at the budget, without trying other gateways, and gives the bytes back', async () => {
    const b = budget({ budgetBytes: 1000 });
    const dest = path.join(dir, 'big.car');
    hits.length = 0;
    await expect(run(['ok', 'ok'], { budget: b, dest })).rejects.toThrow(OutOfSpaceError);
    expect(hits).toHaveLength(1);
    expect(b.used).toBe(0);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('stops when cancelled', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(run(['ok'], { signal: ctrl.signal })).rejects.toThrow(CancelledError);
  });

  it('keeps the bytes counted in the budget after a successful download', async () => {
    const b = budget();
    await run(['ok'], { budget: b });
    expect(b.used).toBe(good.length);
  });
});
