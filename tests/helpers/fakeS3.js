// A small S3 server for tests: path-style PUT/GET/HEAD, ListObjectsV2 (paged),
// multipart, Content-MD5 checking and MinIO-style ETags. The real AWS SDK talks to
// it, so request building and response parsing are exercised for real.
// Fault switches: `faults.corruptPut` (store other bytes than sent),
// `faults.failPuts` (n 500s), `faults.wrongEtag` (answer a bogus ETag).
import crypto from 'node:crypto';
import http from 'node:http';

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function startFakeS3({ pageSize = 1000 } = {}) {
  const objects = new Map();   // "bucket/key" → { body, etag, type, cache }
  const uploads = new Map();   // uploadId → { key, parts: Map(n → Buffer), type, cache }
  const faults = { corruptPut: false, failPuts: 0, wrongEtag: false };
  const log = [];

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const [, bucket, ...rest] = url.pathname.split('/');
    const key = rest.map(decodeURIComponent).join('/');
    const id = `${bucket}/${key}`;
    const q = url.searchParams;
    log.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (status, xml = '', headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/xml', ...headers });
      res.end(xml ? `<?xml version="1.0" encoding="UTF-8"?>${xml}` : undefined);
    };
    const error = (status, code) => send(status, `<Error><Code>${code}</Code><Message>${code}</Message></Error>`);
    const checkMd5 = () => {
      const want = req.headers['content-md5'];
      return !want || Buffer.from(want, 'base64').toString('hex') === md5(body);
    };

    if (req.method === 'PUT') {
      if (faults.failPuts > 0) { faults.failPuts--; return error(500, 'InternalError'); }
      if (!checkMd5()) return error(400, 'BadDigest');
      const stored = faults.corruptPut ? Buffer.concat([body, Buffer.from('x')]) : body;
      if (q.has('uploadId')) {
        const up = uploads.get(q.get('uploadId'));
        if (!up) return error(404, 'NoSuchUpload');
        up.parts.set(Number(q.get('partNumber')), stored);
        return send(200, '', { etag: `"${md5(stored)}"` });
      }
      const etag = md5(stored);
      objects.set(id, { body: stored, etag, type: req.headers['content-type'], cache: req.headers['cache-control'] });
      return send(200, '', { etag: `"${faults.wrongEtag ? 'f'.repeat(32) : etag}"` });
    }

    if (req.method === 'POST' && q.has('uploads')) {
      const uploadId = crypto.randomUUID();
      uploads.set(uploadId, { key: id, parts: new Map(), type: req.headers['content-type'], cache: req.headers['cache-control'] });
      return send(200, `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${esc(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (req.method === 'POST' && q.has('uploadId')) {
      const up = uploads.get(q.get('uploadId'));
      if (!up) return error(404, 'NoSuchUpload');
      const nums = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => Number(m[1]));
      const parts = nums.map((n) => up.parts.get(n));
      const all = Buffer.concat(parts);
      const etag = `${md5(Buffer.concat(parts.map((p) => Buffer.from(md5(p), 'hex'))))}-${parts.length}`;
      objects.set(up.key, { body: all, etag, type: up.type, cache: up.cache });
      uploads.delete(q.get('uploadId'));
      return send(200, `<CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${esc(key)}</Key><ETag>"${etag}"</ETag></CompleteMultipartUploadResult>`);
    }
    if (req.method === 'DELETE' && q.has('uploadId')) { uploads.delete(q.get('uploadId')); return send(204); }

    if (req.method === 'GET' && !key && q.get('list-type') === '2') {
      const prefix = `${bucket}/${q.get('prefix') ?? ''}`;
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = Number(q.get('continuation-token') ?? 0);
      const page = keys.slice(start, start + pageSize);
      const more = start + pageSize < keys.length;
      const contents = page.map((k) => {
        const o = objects.get(k);
        return `<Contents><Key>${esc(k.slice(bucket.length + 1))}</Key><Size>${o.body.length}</Size><ETag>"${o.etag}"</ETag></Contents>`;
      }).join('');
      return send(200, `<ListBucketResult><Name>${bucket}</Name><KeyCount>${page.length}</KeyCount><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + pageSize}</NextContinuationToken>` : ''}${contents}</ListBucketResult>`);
    }

    const o = objects.get(id);
    if (req.method === 'HEAD') {
      if (!o) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-length': o.body.length, etag: `"${o.etag}"`, 'content-type': o.type ?? '' });
      return res.end();
    }
    if (req.method === 'GET') {
      if (!o) return error(404, 'NoSuchKey');
      res.writeHead(200, { 'content-length': o.body.length, etag: `"${o.etag}"`, 'content-type': o.type ?? '' });
      return res.end(o.body);
    }
    return error(405, 'MethodNotAllowed');
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  return {
    endpoint, objects, uploads, faults, log,
    get: (bucket, key) => objects.get(`${bucket}/${key}`),
    close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
  };
}
