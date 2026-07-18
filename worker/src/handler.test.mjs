import test from 'node:test';
import assert from 'node:assert/strict';

// Mock Drive9 backend via globalThis.fetch interception.
// Stores files and index as raw bytes, handles gzip for index.
const drive9Store = new Map();  // path → Uint8Array | string body

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = typeof url === 'string' ? url : url.toString();
  const method = opts.method || 'GET';
  // Extract the path portion after /v1/fs
  const fsMatch = u.match(/\/v1\/fs(\/.*?)(?:\?.*)?$/);
  const fsPath = fsMatch ? fsMatch[1] : null;

  if (method === 'PUT' && fsPath) {
    // Store whatever body is sent (gzipped index, JSON meta, raw file bytes)
    const body = opts.body;
    let stored;
    if (body instanceof ArrayBuffer) stored = new Uint8Array(body);
    else if (body instanceof Uint8Array) stored = body;
    else if (typeof body === 'string') stored = body;
    else if (body && typeof body.arrayBuffer === 'function') stored = new Uint8Array(await body.arrayBuffer());
    else stored = body;
    drive9Store.set(fsPath, stored);
    return new Response('', { status: 200 });
  }

  // Stat endpoint (must check before generic GET)
  if (method === 'GET' && fsPath && u.includes('?stat=1')) {
    return new Response(JSON.stringify({ semantic_text: '' }), { status: 200 });
  }

  if (method === 'GET' && fsPath) {
    const data = drive9Store.get(fsPath);
    if (data === undefined) return new Response('not found', { status: 404 });

    // Handle Range requests for file proxy tests
    const rangeHdr = typeof opts.headers === 'object' && !(opts.headers instanceof Headers)
      ? opts.headers?.range
      : (opts.headers instanceof Headers ? opts.headers.get('range') : undefined);

    if (rangeHdr && data instanceof Uint8Array) {
      const total = data.byteLength;
      const m = rangeHdr.match(/bytes=(\d+)-(\d*)/);
      if (m) {
        const start = parseInt(m[1], 10);
        const end = m[2] ? parseInt(m[2], 10) : total - 1;
        if (start >= total) {
          return new Response('', { status: 416, headers: { 'content-range': `bytes */${total}` } });
        }
        const slice = data.slice(start, end + 1);
        return new Response(slice, {
          status: 206,
          headers: {
            'content-range': `bytes ${start}-${end}/${total}`,
            'content-length': String(slice.byteLength),
            'accept-ranges': 'bytes',
          },
        });
      }
    }

    // Return stored data
    const respBody = data instanceof Uint8Array ? data : data;
    const headers = {};
    if (data instanceof Uint8Array) {
      headers['content-length'] = String(data.byteLength);
      headers['accept-ranges'] = 'bytes';
    }
    return new Response(respBody, { status: 200, headers });
  }

  if (method === 'DELETE' && fsPath) {
    drive9Store.delete(fsPath);
    return new Response('', { status: 200 });
  }

  // Health / status
  if (u.includes('/v1/status')) {
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }

  return new Response('{}', { status: 200 });
};

// Import handler after fetch mock is in place
const worker = await import('../dist/index.js');
const handler = worker.default.fetch || worker.default.default?.fetch;

const env = { DRIVE9_API_KEY: 'test-key', DRIVE9_SERVER: 'http://localhost:9999' };

function resetState() {
  drive9Store.clear();
}

// Helper: upload a file and return the response body
async function uploadFile(name, type, data) {
  const form = new FormData();
  form.append('file', new File([data], name, { type }));
  const req = new Request('http://localhost/api/photos', { method: 'POST', body: form });
  const res = await handler(req, env);
  return { status: res.status, body: await res.json() };
}

// -- Upload validation --

test('POST /api/photos rejects unsupported MIME type with 400', async () => {
  resetState();
  const { status, body } = await uploadFile('doc.pdf', 'application/pdf', new Uint8Array(10));
  assert.equal(status, 400);
  assert.ok(body.error.includes('unsupported'));
});

test('POST /api/photos accepts video/mp4 upload', async () => {
  resetState();
  const { status, body } = await uploadFile('clip.mp4', 'video/mp4', new Uint8Array(100));
  assert.equal(status, 201);
  assert.equal(body.photo.mime, 'video/mp4');
  assert.equal(body.photo.mediaKind, 'video');
});

test('POST /api/photos resolves MIME via extension when type is empty', async () => {
  resetState();
  const { status, body } = await uploadFile('clip.mov', '', new Uint8Array(50));
  assert.equal(status, 201);
  assert.equal(body.photo.mime, 'video/quicktime');
  assert.equal(body.photo.mediaKind, 'video');
});

test('POST /api/photos resolves MIME via extension for text/plain (Drive9 parity)', async () => {
  resetState();
  const { status, body } = await uploadFile('clip.webm', 'text/plain', new Uint8Array(50));
  assert.equal(status, 201);
  assert.equal(body.photo.mime, 'video/webm');
  assert.equal(body.photo.mediaKind, 'video');
});

test('POST /api/photos rejects video exceeding 25MB with 413', async () => {
  resetState();
  const oversize = new Uint8Array(25 * 1024 * 1024 + 1);
  const { status, body } = await uploadFile('big.mp4', 'video/mp4', oversize);
  assert.equal(status, 413);
  assert.ok(body.error.includes('25'));
});

test('POST /api/photos accepts image upload with mediaKind=image', async () => {
  resetState();
  const { status, body } = await uploadFile('photo.jpg', 'image/jpeg', new Uint8Array(100));
  assert.equal(status, 201);
  assert.equal(body.photo.mediaKind, 'image');
});

// -- File proxy / Range --

test('GET /api/photos/:id/file proxies 200 with accept-ranges from upstream', async () => {
  resetState();
  const { body: { photo } } = await uploadFile('test.jpg', 'image/jpeg', new Uint8Array(64));
  const req = new Request(`http://localhost/api/photos/${photo.id}/file`);
  const res = await handler(req, env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
});

test('GET /api/photos/:id/file forwards Range and returns 206', async () => {
  resetState();
  const data = new Uint8Array(256);
  for (let i = 0; i < 256; i++) data[i] = i;
  const { body: { photo } } = await uploadFile('range.jpg', 'image/jpeg', data);
  const req = new Request(`http://localhost/api/photos/${photo.id}/file`, {
    headers: { range: 'bytes=0-9' },
  });
  const res = await handler(req, env);
  assert.equal(res.status, 206);
  assert.ok(res.headers.get('content-range')?.startsWith('bytes 0-9/'));
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
});

test('GET /api/photos/:id/file returns 416 for out-of-range request', async () => {
  resetState();
  const { body: { photo } } = await uploadFile('tiny.jpg', 'image/jpeg', new Uint8Array(10));
  const req = new Request(`http://localhost/api/photos/${photo.id}/file`, {
    headers: { range: 'bytes=9999-' },
  });
  const res = await handler(req, env);
  assert.equal(res.status, 416);
  assert.ok(res.headers.get('content-range')?.includes('*'));
});

// -- Collections / media totals --

test('GET /api/collections returns separate image and video counts', async () => {
  resetState();
  await uploadFile('pic.jpg', 'image/jpeg', new Uint8Array(10));
  await uploadFile('clip.mp4', 'video/mp4', new Uint8Array(10));
  const res = await handler(new Request('http://localhost/api/collections'), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.totals.images, 1);
  assert.equal(body.totals.videos, 1);
  assert.equal(body.totals.photos, 2);
});
