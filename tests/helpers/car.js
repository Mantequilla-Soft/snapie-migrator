// Builds real CAR files for tests: an HLS-like directory imported with a small chunk
// size, so files span several blocks and every failure mode can be made precisely.
import fs from 'node:fs';
import { CarWriter } from '@ipld/car/writer';
import { importer } from 'ipfs-unixfs-importer';
import { fixedSize } from 'ipfs-unixfs-importer/chunker';

export function videoFiles({ segments = 2, segmentBytes = 3000, seed = 1 } = {}) {
  const seg = (i) => {
    const b = Buffer.alloc(segmentBytes);
    for (let j = 0; j < b.length; j++) b[j] = (j * 31 + i * 7 + seed) & 0xff;
    return b;
  };
  const variant = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6',
    ...Array.from({ length: segments }, (_, i) => [`#EXTINF:6.0,`, `480p_${i}.ts`]).flat(), '#EXT-X-ENDLIST', ''].join('\n');
  return [
    { path: 'manifest.m3u8', content: Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480\n480p/index.m3u8\n') },
    { path: '480p/index.m3u8', content: Buffer.from(variant) },
    ...Array.from({ length: segments }, (_, i) => ({ path: `480p/480p_${i}.ts`, content: seg(i) })),
  ];
}

/** → { cid, blocks: [{ cid, bytes }] } with the root directory as `cid`. */
export async function buildDag(files, { chunkSize = 1024 } = {}) {
  const store = new Map();
  const blockstore = {
    put: async (cid, bytes) => { store.set(cid.toString(), { cid, bytes }); return cid; },
    get: async function* (cid) { yield store.get(cid.toString()).bytes; },
    has: async (cid) => store.has(cid.toString()),
  };
  let root;
  for await (const entry of importer(files.map((f) => ({ path: f.path, content: f.content })), blockstore, {
    wrapWithDirectory: true, chunker: fixedSize({ chunkSize }), cidVersion: 0, rawLeaves: false,
  })) {
    if (entry.path === '') root = entry.cid;
  }
  return { cid: root, blocks: [...store.values()] };
}

/** Write a CAR with the given roots and blocks; returns its bytes. */
export async function carBytes(roots, blocks) {
  const { writer, out } = CarWriter.create(roots);
  const chunks = [];
  const done = (async () => { for await (const c of out) chunks.push(c); })();
  for (const b of blocks) await writer.put(b);
  await writer.close();
  await done;
  return Buffer.concat(chunks);
}

export async function writeCar(path, roots, blocks) {
  const bytes = await carBytes(roots, blocks);
  await fs.promises.writeFile(path, bytes);
  return bytes;
}
