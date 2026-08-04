import test from 'node:test';
import assert from 'node:assert/strict';

// Mock Drive9 backend via globalThis.fetch interception.
// Stores files and index as raw bytes, handles gzip for index.
const drive9Store = new Map();  // path → Uint8Array | string body
let drive9SearchRows = [];
let drive9SearchStatus = 200;
let lastDrive9SearchURL = null;
// Per-path override for the ?stat=1 response. Default (no override) is the
// production-realistic "not analyzed yet" stat: an empty semantic_text field.
const drive9StatOverride = new Map();  // fsPath → stat JSON object

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = typeof url === 'string' ? url : url.toString();
  const parsedURL = new URL(u);
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

  if (method === 'GET' && fsPath === '/photovault/photos/' && parsedURL.searchParams.has('grep')) {
    lastDrive9SearchURL = parsedURL;
    return new Response(JSON.stringify(drive9SearchRows), { status: drive9SearchStatus });
  }

  // Stat endpoint (must check before generic GET)
  if (method === 'GET' && fsPath && u.includes('?stat=1')) {
    const override = drive9StatOverride.get(fsPath);
    return new Response(JSON.stringify(override ?? { semantic_text: '' }), { status: 200 });
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
  drive9SearchRows = [];
  drive9SearchStatus = 200;
  lastDrive9SearchURL = null;
  drive9StatOverride.clear();
}

// The objectKey a POST /api/photos upload maps to on Drive9. The worker stores
// uploads under /photos/<id>.<ext>; we discover it from the store so the stat
// override targets the exact stat path the refresh will query.
function drive9ObjectPath(photoId) {
  for (const key of drive9Store.keys()) {
    if (key.includes(photoId)) return key;
  }
  return null;
}

// Helper: upload a file and return the response body
async function uploadFile(name, type, data) {
  const form = new FormData();
  form.append('file', new File([data], name, { type }));
  const req = new Request('http://localhost/api/photos', { method: 'POST', body: form });
  const res = await handler(req, env);
  return { status: res.status, body: await res.json() };
}

function updatePhotoMeta(photo, patch) {
  const path = `/photovault/meta/${photo.id}.json`;
  const stored = drive9Store.get(path);
  assert.equal(typeof stored, 'string', `missing metadata for ${photo.id}`);
  drive9Store.set(path, JSON.stringify({ ...JSON.parse(stored), ...patch }));
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

test('POST /api/photos rejects video exceeding 25MB with 413 and writes nothing', async () => {
  resetState();
  const storeKeysBefore = [...drive9Store.keys()];
  const oversize = new Uint8Array(25 * 1024 * 1024 + 1);
  const { status, body } = await uploadFile('big.mp4', 'video/mp4', oversize);
  assert.equal(status, 413);
  assert.ok(body.error.includes('25'));
  // No Drive9 object, meta, or index writes should have occurred
  const storeKeysAfter = [...drive9Store.keys()];
  assert.deepEqual(storeKeysAfter, storeKeysBefore, 'no Drive9 writes should happen for oversized upload');
});

test('POST /api/photos accepts image upload with mediaKind=image', async () => {
  resetState();
  const { status, body } = await uploadFile('photo.jpg', 'image/jpeg', new Uint8Array(100));
  assert.equal(status, 201);
  assert.equal(body.photo.mediaKind, 'image');
});

test('GET /api/photos uses ranked Drive9 search paths', async () => {
  resetState();
  const cat = await uploadFile('cat.jpg', 'image/jpeg', new Uint8Array(10));
  const adapter = await uploadFile('adapter.jpg', 'image/jpeg', new Uint8Array(10));
  const unreturned = await uploadFile('unreturned.jpg', 'image/jpeg', new Uint8Array(10));
  updatePhotoMeta(unreturned.body.photo, { aiTagsEn: ['feline pet'], aiTextEn: 'feline pet' });
  drive9SearchRows = [
    { path: cat.body.photo.objectKey, score: 0.8 },
    { path: '/outside/photovault.jpg', score: 0.7 },
    { path: adapter.body.photo.objectKey, score: 0.6 },
  ];

  const res = await handler(new Request('http://localhost/api/photos?q=feline%20pet'), env);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body.photos.map((photo) => photo.id), [cat.body.photo.id, adapter.body.photo.id]);
  assert.deepEqual(body.photos.map((photo) => photo.score), [0.8, 0.6]);
  assert.equal(lastDrive9SearchURL.pathname, '/v1/fs/photovault/photos/');
  assert.equal(lastDrive9SearchURL.searchParams.get('grep'), 'feline pet');
  assert.equal(lastDrive9SearchURL.searchParams.get('limit'), '100');
});

test('GET /api/photos reranks only Drive9 candidates with structured semantic fields', async () => {
  resetState();
  const cat = await uploadFile('cat.jpg', 'image/jpeg', new Uint8Array(10));
  const catEars = await uploadFile('cat-ears.jpg', 'image/jpeg', new Uint8Array(10));
  const autumn = await uploadFile('autumn.jpg', 'image/jpeg', new Uint8Array(10));
  const unreturnedCat = await uploadFile('unreturned-cat.jpg', 'image/jpeg', new Uint8Array(10));
  updatePhotoMeta(cat.body.photo, {
    aiCaptionZh: '一只橘猫正视镜头，画面聚焦于猫脸特写。',
    aiTagsZh: ['橘猫', '宠物猫', '猫咪表情'],
    aiTextZh: '一只橘猫正视镜头。',
  });
  updatePhotoMeta(catEars.body.photo, {
    aiCaptionZh: '四名Q版动漫少女角色并排站立。',
    aiTagsZh: ['猫耳', '动漫角色'],
    aiTextZh: '动漫角色佩戴猫耳耳机。',
  });
  updatePhotoMeta(autumn.body.photo, {
    aiCaptionZh: '秋日林间公路。',
    aiTagsZh: ['秋日', '公路'],
    aiTextZh: '秋日林间公路。',
  });
  updatePhotoMeta(unreturnedCat.body.photo, {
    aiCaptionZh: '一只可爱的橘猫。',
    aiTagsZh: ['橘猫'],
    aiTextZh: '一只可爱的橘猫。',
  });
  drive9SearchRows = [
    { path: catEars.body.photo.objectKey, score: 0.9 },
    { path: cat.body.photo.objectKey, score: 0.8 },
    { path: autumn.body.photo.objectKey, score: 0.7 },
  ];

  const res = await handler(new Request('http://localhost/api/photos?q=%E4%B8%80%E5%8F%AA%E5%8F%AF%E7%88%B1%E7%9A%84%E6%A9%98%E7%8C%AB'), env);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body.photos.map((photo) => photo.id), [cat.body.photo.id]);
  assert.equal(body.photos[0].score, 0.8);
  assert.ok(!body.photos.some((photo) => photo.id === unreturnedCat.body.photo.id));
});

test('GET /api/photos applies metadata filters before the search result limit', async () => {
  resetState();
  const photos = [];
  for (let index = 0; index < 13; index++) {
    const upload = await uploadFile(`autumn-${index}.jpg`, 'image/jpeg', new Uint8Array(10));
    const photo = upload.body.photo;
    updatePhotoMeta(photo, {
      aiTagsEn: ['autumn'],
      aiTextEn: 'autumn',
      favorite: index === 12,
    });
    photos.push(photo);
  }
  drive9SearchRows = photos.map((photo, index) => ({
    path: photo.objectKey,
    score: 1 - index / 100,
  }));

  const res = await handler(new Request('http://localhost/api/photos?q=autumn&favorite=true'), env);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body.photos.map((photo) => photo.id), [photos[12].id]);
});

test('GET /api/photos treats a null Drive9 search response as no matches', async () => {
  resetState();
  await uploadFile('cat.jpg', 'image/jpeg', new Uint8Array(10));
  drive9SearchRows = null;

  const res = await handler(new Request('http://localhost/api/photos?q=no-match'), env);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body.photos, []);
  assert.equal(body.count, 0);
});

test('GET /api/photos treats whitespace as an unfiltered list', async () => {
  resetState();
  const cat = await uploadFile('cat.jpg', 'image/jpeg', new Uint8Array(10));

  const res = await handler(new Request('http://localhost/api/photos?q=%20%20%20'), env);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body.photos.map((photo) => photo.id), [cat.body.photo.id]);
  assert.equal(lastDrive9SearchURL, null);
});

test('GET /api/photos reports a Drive9 search failure', async () => {
  resetState();
  drive9SearchStatus = 503;

  const res = await handler(new Request('http://localhost/api/photos?q=cat'), env);
  const body = await res.json();

  assert.equal(res.status, 500);
  assert.match(body.error, /^drive9 search failed: 503/);
});

test('GET /api/photos rejects an invalid Drive9 search response', async () => {
  resetState();
  drive9SearchRows = {};

  const res = await handler(new Request('http://localhost/api/photos?q=cat'), env);
  const body = await res.json();

  assert.equal(res.status, 500);
  assert.equal(body.error, 'drive9 search returned an invalid response');
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

// -- Semantic refresh: Drive9 tags-only result must be persisted, not dropped --

// task #6 REVISE (adversary-1, blocker 4): Drive9 can finish with usable image
// tags (drive9.image.tag.en.*) but no caption/description text — e.g. when the
// semantic_text tail is truncated so no caption survives. The persist gate used
// to require caption text (analysis.text.*), so those real tags were dropped and
// the image stayed 'pending' forever. This is the exact task-title scenario:
// "show usable tags, don't pend". Reproduced through the real handler path.
test('GET /api/photos persists Drive9 tags-only result (no caption text) instead of staying pending', async () => {
  resetState();
  const { body: { photo } } = await uploadFile('cat.jpg', 'image/jpeg', new Uint8Array(64));
  assert.equal(photo.analysisStatus, 'pending');

  // Drive9 finished: non-empty but unrecoverable semantic_text (no caption/
  // description survives) PLUS real image tags. Target the exact stat path.
  const statPath = drive9ObjectPath(photo.id);
  assert.ok(statPath, 'uploaded object path should be discoverable');
  drive9StatOverride.set(statPath, {
    semantic_text: '{"caption_en":"a cat on a so',  // truncated mid-value → no caption recovered
    tags: {
      'drive9.image.tag.en.0': 'cat',
      'drive9.image.tag.en.1': 'sofa',
      'drive9.image.tag.zh.0': '猫',
      'drive9.image.tag.zh.1': '沙发',
    },
  });

  const res = await handler(new Request('http://localhost/api/photos'), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  const got = body.photos.find((p) => p.id === photo.id);
  assert.ok(got, 'photo should be listed');

  // The real Drive9 tags must surface — not dropped, not pending, not unavailable.
  assert.equal(got.analysisStatus, 'drive9');
  assert.deepEqual(got.aiTagsEn, ['cat', 'sofa']);
  assert.deepEqual(got.aiTagsZh, ['猫', '沙发']);
  assert.deepEqual(got.tags, ['cat', 'sofa']);
  // No fabricated caption from the truncated half-value.
  assert.equal(got.aiCaptionEn, '');
  assert.doesNotMatch((got.aiCaptionEn || '') + (got.aiTextEn || ''), /a cat on a so/);
});

test('GET /api/photos does not re-poll a persisted Drive9 tags-only result', async () => {
  resetState();
  const { body: { photo } } = await uploadFile('cat2.jpg', 'image/jpeg', new Uint8Array(64));
  const statPath = drive9ObjectPath(photo.id);
  drive9StatOverride.set(statPath, {
    semantic_text: '{"caption_en":"trunc',
    tags: { 'drive9.image.tag.en.0': 'dog' },
  });

  // First list persists the tags-only 'drive9' state.
  await handler(new Request('http://localhost/api/photos'), env);

  // Drive9 stat now regresses to empty (as if a later poll saw nothing). A
  // terminal 'drive9' result must NOT be re-polled and downgraded — the tags
  // stay put.
  drive9StatOverride.set(statPath, { semantic_text: '' });
  const res = await handler(new Request('http://localhost/api/photos'), env);
  const body = await res.json();
  const got = body.photos.find((p) => p.id === photo.id);
  assert.equal(got.analysisStatus, 'drive9');
  assert.deepEqual(got.aiTagsEn, ['dog']);
});
