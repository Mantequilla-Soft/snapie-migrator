import { describe, expect, it } from 'vitest';
import { DiskBudget, MIN_START_BYTES } from '../src/disk.js';
import { CancelledError, OutOfSpaceError } from '../src/errors.js';
import { planReadback, playlistRefs } from '../src/readback.js';
import { Throttle } from '../src/throttle.js';

const GB = 1024 ** 3;

describe('DiskBudget', () => {
  const make = (free, over = {}) => new DiskBudget({ dir: '/', budgetBytes: 20 * GB, reserveBytes: 5 * GB, statfs: async () => ({ bavail: free, bsize: 1 }), ...over });

  it('lets an item start only with room in the budget and on disk', async () => {
    await expect(make(100 * GB).assertCanStart()).resolves.toBeUndefined();
    await expect(make(5 * GB + 1).assertCanStart()).rejects.toThrow(OutOfSpaceError);
    const full = make(100 * GB);
    full.used = 20 * GB - MIN_START_BYTES + 1;
    await expect(full.assertCanStart()).rejects.toThrow(/budget nearly used/);
  });

  it('tracks a real disk: refuses exactly at the reserve, and only measures every ~64 MB', async () => {
    let stats = 0;
    let written = 0;
    const disk = (free) => async () => { stats++; return { bavail: free - written, bsize: 1 }; };
    const write = async (b, n) => { await b.take(n); written += n; };

    const tight = new DiskBudget({ dir: '/', budgetBytes: 20 * GB, reserveBytes: 0, statfs: disk(1000) });
    await write(tight, 600);
    await write(tight, 400);                 // exactly down to the reserve: allowed
    await expect(tight.take(1)).rejects.toThrow(OutOfSpaceError);

    stats = 0;
    written = 0;
    const roomy = new DiskBudget({ dir: '/', budgetBytes: 20 * GB, reserveBytes: 0, statfs: disk(100 * GB) });
    for (let i = 0; i < 10; i++) await write(roomy, 1024 * 1024);
    expect(stats).toBe(1);                   // 10 MB written, measured once
    expect(roomy.used).toBe(10 * 1024 * 1024);
  });

  it('refuses a write past the budget, and counts what it allowed', async () => {
    const b = make(100 * GB, { budgetBytes: 1000 });
    await b.take(600);
    await expect(b.take(500)).rejects.toThrow(/budget/);
    expect(b.used).toBe(600);
    b.release(600);
    expect(b.used).toBe(0);
  });

  it('refuses a write that would eat into the reserve', async () => {
    // A real filesystem: free space shrinks as we write.
    const b = new DiskBudget({ dir: '/', budgetBytes: 20 * GB, reserveBytes: 5 * GB, statfs: async () => ({ bavail: 5 * GB + 1000 - b.used, bsize: 1 }) });
    await b.take(900);
    await expect(b.take(200)).rejects.toThrow(/less than 5.00 GB free/);
  });
});

describe('Throttle', () => {
  it('unlimited when the rate is 0', async () => {
    await new Throttle(0).take(1e12);
  });

  it('waits once the bucket is empty, and can be cancelled while waiting', async () => {
    let t = 0;
    const th = new Throttle(1000, { now: () => t });
    await th.take(1000);                     // the first second's tokens
    const ctrl = new AbortController();
    const waiting = th.take(500, ctrl.signal);
    ctrl.abort();
    await expect(waiting).rejects.toThrow(CancelledError);
    t += 1000;
    await th.take(500);                      // a second later there are tokens again
  });
});

describe('playlists', () => {
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n480p/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\n720p/index.m3u8\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/index.m3u8"\n';
  const media = (n) => `#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n${Array.from({ length: n }, (_, i) => `#EXTINF:6,\nseg_${i}.ts`).join('\n')}\n#EXT-X-ENDLIST\n`;

  it('reads playlist and segment references', () => {
    expect(playlistRefs(master)).toEqual({ isMaster: true, refs: [
      { uri: '480p/index.m3u8', kind: 'playlist' }, { uri: '720p/index.m3u8', kind: 'playlist' }, { uri: 'audio/index.m3u8', kind: 'playlist' },
    ] });
    expect(playlistRefs(media(2)).refs).toEqual([{ uri: 'init.mp4', kind: 'init' }, { uri: 'seg_0.ts', kind: 'segment' }, { uri: 'seg_1.ts', kind: 'segment' }]);
  });

  it('picks every playlist plus the first and last segment (and init) of each', async () => {
    const texts = { 'manifest.m3u8': master, '480p/index.m3u8': media(5), '720p/index.m3u8': media(1), 'audio/index.m3u8': media(3) };
    const files = new Map(['manifest.m3u8', ...Object.keys(texts), ...['480p', '720p', 'audio'].flatMap((d) => ['init.mp4', 'seg_0.ts', 'seg_1.ts', 'seg_2.ts', 'seg_3.ts', 'seg_4.ts'].map((f) => `${d}/${f}`))].map((p) => [p, {}]));
    const { paths, warnings } = await planReadback('manifest.m3u8', files, async (p) => texts[p]);
    expect(paths.sort()).toEqual([
      '480p/index.m3u8', '480p/init.mp4', '480p/seg_0.ts', '480p/seg_4.ts',
      '720p/index.m3u8', '720p/init.mp4', '720p/seg_0.ts',
      'audio/index.m3u8', 'audio/init.mp4', 'audio/seg_0.ts', 'audio/seg_2.ts',
      'manifest.m3u8',
    ]);
    expect(warnings).toEqual([]);
  });

  it('warns about absolute, escaping and missing references instead of failing', async () => {
    const text = '#EXTM3U\n#EXTINF:6,\nhttps://ipfs.io/ipfs/Qm/x.ts\n#EXTINF:6,\n../../etc/passwd\n#EXTINF:6,\nmissing.ts\n#EXTINF:6,\nok.ts\n';
    const { paths, warnings } = await planReadback('v/index.m3u8', new Map([['v/index.m3u8', {}], ['v/ok.ts', {}]]), async () => text);
    expect(paths.sort()).toEqual(['v/index.m3u8', 'v/ok.ts']);
    expect(warnings).toHaveLength(3);
    expect(warnings.join('\n')).toMatch(/absolute URI[\s\S]*leaves the video directory[\s\S]*not in the directory/);
  });
});
