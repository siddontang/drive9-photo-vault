import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

class NodeDigestStream extends WritableStream {
  constructor(algorithm) {
    const hash = createHash(algorithm.replace('-', '').toLowerCase());
    let resolveDigest;
    let rejectDigest;
    const digest = new Promise((resolve, reject) => {
      resolveDigest = resolve;
      rejectDigest = reject;
    });
    super({
      write(chunk) {
        const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        hash.update(bytes);
      },
      close() {
        const bytes = hash.digest();
        resolveDigest(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      },
      abort(reason) { rejectDigest(reason); },
    });
    this.digest = digest;
  }
}

Object.defineProperty(globalThis.crypto, 'DigestStream', { configurable: true, value: NodeDigestStream });

// Mock Drive9 backend via globalThis.fetch interception.
// Stores files and index as raw bytes, handles gzip for index.
const drive9Store = new Map();  // path → Uint8Array | string body
let drive9SearchRows = [];
let drive9SearchStatus = 200;
let lastDrive9SearchURL = null;
// Per-path override for the ?stat=1 response. Default (no override) is the
// production-realistic "not analyzed yet" stat: an empty semantic_text field.
const drive9StatOverride = new Map();  // fsPath → stat JSON object
const MULTIPART_PART_SIZE = 8 * 1024 * 1024;
const multipartSessions = new Map();
let uploadSequence = 0;
let multipartAbortCount = 0;
let multipartCompleteCount = 0;
let maxMultipartPartBytes = 0;
let failMultipartPartNumber = null;
let failDrive9PutPath = null;
let failDrive9GetPath = null;
let failImageTransform = false;
let failMediaTransform = false;
let failMediaTransformMode = null;
let imageTransformCalls = [];
let imageSourceFetches = [];
let mediaTransformCalls = [];
const SAFE_IMAGE_RENDITION = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0xff, 0xd9]);
const SAFE_VIDEO_RENDITION = new TextEncoder().encode('privacy-safe-video');
const SAFE_VIDEO_POSTER = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0xff, 0xd9]);
let imageRenditionBytes = null;
let videoRenditionBytes = SAFE_VIDEO_RENDITION;
let videoPosterBytes = SAFE_VIDEO_POSTER;

function containsBytes(bytes, needle) {
  return Buffer.from(bytes).includes(Buffer.from(needle));
}

async function bodyBytes(body) {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body && typeof body.arrayBuffer === 'function') return new Uint8Array(await body.arrayBuffer());
  return new Uint8Array();
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = typeof url === 'string' ? url : url.toString();
  const parsedURL = new URL(u);
  const method = opts.method || 'GET';
  // Extract the path portion after /v1/fs
  const fsMatch = u.match(/\/v1\/fs(\/.*?)(?:\?.*)?$/);
  const fsPath = fsMatch ? fsMatch[1] : null;

  if (method === 'GET' && fsPath && fsPath === failDrive9GetPath) {
    return new Response('sensitive upstream detail', { status: 503 });
  }

  if (method === 'POST' && parsedURL.pathname === '/v2/uploads/initiate') {
    const request = JSON.parse(String(opts.body));
    const uploadID = `upload-${++uploadSequence}`;
    const totalParts = Math.ceil(request.total_size / MULTIPART_PART_SIZE);
    multipartSessions.set(uploadID, { path: request.path, totalSize: request.total_size, parts: new Map() });
    return new Response(JSON.stringify({ upload_id: uploadID, part_size: MULTIPART_PART_SIZE, total_parts: totalParts }), { status: 200 });
  }

  const presignMatch = parsedURL.pathname.match(/^\/v2\/uploads\/([^/]+)\/presign-batch$/);
  if (method === 'POST' && presignMatch) {
    const uploadID = presignMatch[1];
    const session = multipartSessions.get(uploadID);
    if (!session) return new Response('missing upload', { status: 404 });
    const request = JSON.parse(String(opts.body));
    const parts = request.parts.map(({ part_number: number }) => ({
      number,
      url: `http://upload.local/${uploadID}/${number}`,
      size: Math.min(MULTIPART_PART_SIZE, session.totalSize - (number - 1) * MULTIPART_PART_SIZE),
    }));
    return new Response(JSON.stringify({ parts }), { status: 200 });
  }

  const uploadedPartMatch = parsedURL.hostname === 'upload.local' && parsedURL.pathname.match(/^\/([^/]+)\/(\d+)$/);
  if (method === 'PUT' && uploadedPartMatch) {
    const uploadID = uploadedPartMatch[1];
    const partNumber = Number(uploadedPartMatch[2]);
    if (partNumber === failMultipartPartNumber) return new Response('part failed', { status: 503 });
    const session = multipartSessions.get(uploadID);
    if (!session) return new Response('missing upload', { status: 404 });
    const bytes = await bodyBytes(opts.body);
    maxMultipartPartBytes = Math.max(maxMultipartPartBytes, bytes.byteLength);
    session.parts.set(partNumber, bytes.byteLength);
    return new Response('', { status: 200, headers: { etag: `etag-${partNumber}` } });
  }

  const completeMatch = parsedURL.pathname.match(/^\/v2\/uploads\/([^/]+)\/complete$/);
  if (method === 'POST' && completeMatch) {
    const uploadID = completeMatch[1];
    const session = multipartSessions.get(uploadID);
    if (!session) return new Response('missing upload', { status: 404 });
    const receivedBytes = [...session.parts.values()].reduce((sum, size) => sum + size, 0);
    if (receivedBytes !== session.totalSize) return new Response('incomplete upload', { status: 400 });
    multipartCompleteCount++;
    drive9Store.set(session.path, `multipart:${session.totalSize}`);
    multipartSessions.delete(uploadID);
    return new Response('', { status: 200 });
  }

  const abortMatch = parsedURL.pathname.match(/^\/v2\/uploads\/([^/]+)\/abort$/);
  if (method === 'POST' && abortMatch) {
    multipartAbortCount++;
    multipartSessions.delete(abortMatch[1]);
    return new Response(null, { status: 204 });
  }

  if (method === 'PUT' && fsPath) {
    if (failDrive9PutPath && (fsPath === failDrive9PutPath || (failDrive9PutPath.endsWith('/') && fsPath.startsWith(failDrive9PutPath)))) {
      return new Response('forced write failure', { status: 503 });
    }
    // Store whatever body is sent (gzipped index, JSON meta, raw file bytes)
    const body = opts.body;
    let stored;
    if (body instanceof ArrayBuffer) stored = new Uint8Array(body);
    else if (body instanceof Uint8Array) stored = body;
    else if (typeof body === 'string') stored = body;
    else if (body instanceof ReadableStream) stored = new Uint8Array(await new Response(body).arrayBuffer());
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
    if (fsPath.startsWith('/photovault/photos/')) {
      const headers = new Headers(opts.headers || {});
      imageSourceFetches.push({
        path: fsPath,
        authorization: headers.get('authorization'),
        usedCfImage: Boolean(opts.cf?.image),
      });
    }

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

const imagesBinding = {
  input(stream) {
    return {
      transform(transform) {
        return {
          output(output) {
            imageTransformCalls.push({
              transform: structuredClone(transform),
              output: structuredClone(output),
            });
            return {
              async response() {
                const source = new Uint8Array(await new Response(stream).arrayBuffer());
                if (failImageTransform) return new Response('transform failed', { status: 415 });
                const body = imageRenditionBytes ?? (transform.metadata === 'none' ? SAFE_IMAGE_RENDITION : source);
                return new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg' } });
              },
            };
          },
        };
      },
    };
  },
};

function mediaResult(stream, output) {
  return {
    async response() {
      await new Response(stream).arrayBuffer();
      if (failMediaTransform || failMediaTransformMode === output.mode) return new Response('transform failed', { status: 415 });
      const body = output.mode === 'frame' ? videoPosterBytes : videoRenditionBytes;
      const type = output.mode === 'frame' ? 'image/jpeg' : 'video/mp4';
      return new Response(body, { status: 200, headers: { 'content-type': type } });
    },
  };
}

const mediaBinding = {
  input(stream) {
    return {
      transform(transform) {
        return {
          output(output) {
            mediaTransformCalls.push({ transform: structuredClone(transform), output: structuredClone(output) });
            return mediaResult(stream, output);
          },
        };
      },
      output(output) {
        mediaTransformCalls.push({ transform: null, output: structuredClone(output) });
        return mediaResult(stream, output);
      },
    };
  },
};

const env = { DRIVE9_API_KEY: 'test-key', DRIVE9_SERVER: 'http://localhost:9999', IMAGES: imagesBinding, MEDIA: mediaBinding };

function resetState() {
  drive9Store.clear();
  drive9SearchRows = [];
  drive9SearchStatus = 200;
  lastDrive9SearchURL = null;
  drive9StatOverride.clear();
  multipartSessions.clear();
  uploadSequence = 0;
  multipartAbortCount = 0;
  multipartCompleteCount = 0;
  maxMultipartPartBytes = 0;
  failMultipartPartNumber = null;
  failDrive9PutPath = null;
  failDrive9GetPath = null;
  failImageTransform = false;
  failMediaTransform = false;
  failMediaTransformMode = null;
  imageTransformCalls = [];
  imageSourceFetches = [];
  mediaTransformCalls = [];
  imageRenditionBytes = null;
  videoRenditionBytes = SAFE_VIDEO_RENDITION;
  videoPosterBytes = SAFE_VIDEO_POSTER;
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
  const probe = new Request('http://localhost/api/photos', { method: 'POST', body: form });
  const encoded = await probe.arrayBuffer();
  const req = new Request('http://localhost/api/photos', {
    method: 'POST',
    headers: { 'content-type': probe.headers.get('content-type'), 'content-length': String(encoded.byteLength) },
    body: encoded,
  });
  const res = await handler(req, env);
  return { status: res.status, body: await res.json() };
}

function repeatedByteStream(size, chunkSize = 256 * 1024, extraBytes = 0, counters = {}) {
  let remaining = size + extraBytes;
  return new ReadableStream({
    pull(controller) {
      counters.pulls = (counters.pulls || 0) + 1;
      if (remaining === 0) return controller.close();
      const length = Math.min(chunkSize, remaining);
      controller.enqueue(new Uint8Array(length));
      remaining -= length;
    },
  }, { highWaterMark: 0 });
}

async function uploadStream({ name, type, size, stream = repeatedByteStream(size), metadata = {}, contentLength = size, counters = null }) {
  const headers = {
    'content-type': type,
    'x-photovault-upload-metadata': encodeURIComponent(JSON.stringify({
      name,
      size,
      owner: 'stream-owner',
      title: name.replace(/\.[^.]+$/, ''),
      tags: 'streamed',
      note: '',
      album: 'Inbox',
      ...metadata,
    })),
  };
  if (contentLength !== null) headers['content-length'] = String(contentLength);
  const req = new Request('http://localhost/api/photos', { method: 'POST', headers, body: stream, duplex: 'half' });
  if (counters) counters.pullsBeforeHandler = counters.pulls || 0;
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

test('POST /api/photos rejects oversized legacy multipart before parsing its body', async () => {
  resetState();
  const counters = {};
  const stream = repeatedByteStream(1024, 1024, 0, counters);
  const req = new Request('http://localhost/api/photos', {
    method: 'POST',
    headers: {
      'content-type': 'multipart/form-data; boundary=test',
      'content-length': String(26 * 1024 * 1024 + 1),
    },
    body: stream,
    duplex: 'half',
  });
  const pullsBeforeHandler = counters.pulls || 0;
  const res = await handler(req, env);
  const body = await res.json();

  assert.equal(res.status, 413);
  assert.match(body.error, /legacy multipart upload limit/);
  assert.equal(counters.pulls || 0, pullsBeforeHandler);
  assert.equal(drive9Store.size, 0);
});

test('POST /api/photos streams an exact 40,000,000-byte video in bounded Drive9 parts', async () => {
  resetState();
  const size = 40_000_000;
  const { status, body } = await uploadStream({ name: 'large.mp4', type: 'video/mp4', size });

  assert.equal(status, 201);
  assert.equal(body.photo.size, size);
  assert.equal(body.photo.mediaKind, 'video');
  assert.equal(multipartCompleteCount, 1);
  assert.equal(multipartAbortCount, 0);
  assert.equal(multipartSessions.size, 0);
  assert.ok(maxMultipartPartBytes <= MULTIPART_PART_SIZE, `largest part was ${maxMultipartPartBytes}`);

  const expected = createHash('sha256');
  const zeroChunk = new Uint8Array(1024 * 1024);
  for (let remaining = size; remaining > 0; remaining -= zeroChunk.byteLength) {
    expected.update(zeroChunk.subarray(0, Math.min(zeroChunk.byteLength, remaining)));
  }
  assert.equal(body.photo.checksum, expected.digest('hex'));
  assert.equal(drive9Store.get(body.photo.objectKey), `multipart:${size}`);
});

test('POST /api/photos rejects 40,000,001 declared video bytes before reading or writing', async () => {
  resetState();
  const counters = {};
  const size = 40_000_001;
  const { status, body } = await uploadStream({
    name: 'too-large.mp4',
    type: 'video/mp4',
    size,
    stream: repeatedByteStream(size, 256 * 1024, 0, counters),
    counters,
  });

  assert.equal(status, 413);
  assert.match(body.error, /40MB/);
  assert.equal(counters.pulls || 0, counters.pullsBeforeHandler, 'handler must reject before consuming the body stream');
  assert.equal(multipartSessions.size, 0);
  assert.equal(drive9Store.size, 0);
});

test('POST /api/photos keeps the streaming image limit at 25MiB', async () => {
  resetState();
  const counters = {};
  const size = 25 * 1024 * 1024 + 1;
  const { status, body } = await uploadStream({
    name: 'too-large.jpg',
    type: 'image/jpeg',
    size,
    stream: repeatedByteStream(size, 64 * 1024, 0, counters),
    counters,
  });

  assert.equal(status, 413);
  assert.match(body.error, /25MiB/);
  assert.equal(counters.pulls || 0, counters.pullsBeforeHandler, 'handler must reject before consuming the body stream');
  assert.equal(drive9Store.size, 0);
});

test('POST /api/photos rejects a content-length mismatch before reading the raw body', async () => {
  resetState();
  const counters = {};
  const declaredSize = 10_000_000;
  const { status, body } = await uploadStream({
    name: 'mismatch.mp4',
    type: 'video/mp4',
    size: declaredSize,
    contentLength: declaredSize - 1,
    stream: repeatedByteStream(declaredSize, 64 * 1024, 0, counters),
    counters,
  });

  assert.equal(status, 400);
  assert.match(body.error, /content-length does not match/);
  assert.equal(counters.pulls || 0, counters.pullsBeforeHandler);
  assert.equal(drive9Store.size, 0);
});

test('POST /api/photos aborts multipart state after a part upload failure', async () => {
  resetState();
  failMultipartPartNumber = 2;
  const { status, body } = await uploadStream({ name: 'failed.mp4', type: 'video/mp4', size: 20_000_000 });

  assert.equal(status, 500);
  assert.match(body.error, /part 2 upload failed/);
  assert.equal(multipartAbortCount, 1);
  assert.equal(multipartCompleteCount, 0);
  assert.equal(multipartSessions.size, 0);
  assert.equal(drive9Store.size, 0);
});

test('POST /api/photos aborts when the raw body is shorter or longer than declared', async (t) => {
  for (const scenario of [
    { name: 'short', streamSize: 9_000_000, extraBytes: 0, pattern: /ended early/ },
    { name: 'extra', streamSize: 10_000_000, extraBytes: 1, pattern: /exceeds the declared/ },
  ]) {
    await t.test(scenario.name, async () => {
      resetState();
      const declaredSize = 10_000_000;
      const stream = repeatedByteStream(scenario.streamSize, 128 * 1024, scenario.extraBytes);
      const { status, body } = await uploadStream({ name: `${scenario.name}.mp4`, type: 'video/mp4', size: declaredSize, stream });
      assert.equal(status, 400);
      assert.match(body.error, scenario.pattern);
      assert.equal(multipartAbortCount, 1);
      assert.equal(multipartCompleteCount, 0);
      assert.equal(multipartSessions.size, 0);
      assert.equal(drive9Store.size, 0);
    });
  }
});

test('POST /api/photos removes a completed object and metadata when index persistence fails', async () => {
  resetState();
  failDrive9PutPath = '/photovault/index.json.gz';
  const { status, body } = await uploadStream({ name: 'rollback.mp4', type: 'video/mp4', size: 10_000_000 });

  assert.equal(status, 500);
  assert.match(body.error, /drive9 write \/photovault\/index.json.gz failed/);
  assert.equal(multipartCompleteCount, 1);
  assert.equal([...drive9Store.keys()].some((key) => key.startsWith('/photovault/photos/')), false);
  assert.equal([...drive9Store.keys()].some((key) => key.startsWith('/photovault/meta/')), false);
  assert.equal(drive9Store.has('/photovault/index.json.gz'), false);
});

test('POST /api/photos removes a completed object when metadata persistence fails', async () => {
  resetState();
  failDrive9PutPath = '/photovault/meta/';
  const { status, body } = await uploadStream({ name: 'rollback-meta.mp4', type: 'video/mp4', size: 10_000_000 });

  assert.equal(status, 500);
  assert.match(body.error, /drive9 write \/photovault\/meta\//);
  assert.equal(multipartCompleteCount, 1);
  assert.equal([...drive9Store.keys()].some((key) => key.startsWith('/photovault/photos/')), false);
  assert.equal([...drive9Store.keys()].some((key) => key.startsWith('/photovault/meta/')), false);
  assert.equal(drive9Store.has('/photovault/index.json.gz'), false);
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

// -- Public single-item share links --

test('POST /api/photos/:id/share creates an unguessable share without leaking internal fields', async () => {
  resetState();
  const bytes = new Uint8Array([
    0xff, 0xd8,
    ...new TextEncoder().encode('Exif\0\0GPSLatitude=31.2304;GPSLongitude=121.4737;http://ns.adobe.com/xap/1.0/'),
    0xff, 0xd9,
  ]);
  assert.equal(containsBytes(bytes, 'GPSLatitude'), true);
  assert.equal(containsBytes(bytes, 'http://ns.adobe.com/xap/1.0/'), true);
  const { body: { photo } } = await uploadFile('shared.jpg', 'image/jpeg', bytes);

  const create = await handler(new Request(`http://localhost/api/photos/${photo.id}/share`, { method: 'POST' }), env);
  assert.equal(create.status, 200);
  const created = await create.json();
  assert.match(created.share.token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(created.share.url, `http://localhost/api/shares/${created.share.token}`);

  const second = await handler(new Request(`http://localhost/api/photos/${photo.id}/share`, { method: 'POST' }), env);
  assert.equal((await second.json()).share.token, created.share.token, 'the current link should be reused');

  const list = await handler(new Request('http://localhost/api/photos'), env);
  const listed = (await list.json()).photos.find((candidate) => candidate.id === photo.id);
  assert.equal(listed.shared, true);
  assert.equal('shareToken' in listed, false, 'management responses must not expose the token');
  assert.equal('shareRenditionVersion' in listed, false, 'management responses must not expose internal rendition state');

  const metadata = await handler(new Request(created.share.url), env);
  assert.equal(metadata.status, 200);
  assert.equal(metadata.headers.get('cache-control'), 'no-store');
  const shared = (await metadata.json()).photo;
  assert.equal(shared.title, 'shared');
  assert.equal(shared.url, `http://localhost/api/shares/${created.share.token}/file`);
  for (const internalField of ['id', 'owner', 'objectKey', 'checksum', 'shareToken', 'shareRenditionVersion', 'favorite', 'archived', 'note', 'album', 'createdAt', 'analysisStatus']) {
    assert.equal(internalField in shared, false, `shared metadata must not expose ${internalField}`);
  }

  const file = await handler(new Request(shared.url), env);
  assert.equal(file.status, 200);
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), SAFE_IMAGE_RENDITION);
  assert.equal(file.headers.get('cache-control'), 'private, no-store');
  assert.equal(file.headers.get('content-type'), 'image/jpeg');

  const poster = await handler(new Request(`http://localhost/api/shares/${created.share.token}/poster`), env);
  assert.equal(poster.status, 200);
  assert.deepEqual(new Uint8Array(await poster.arrayBuffer()), SAFE_IMAGE_RENDITION);
  assert.equal(poster.headers.get('cache-control'), 'private, no-store');

  const range = await handler(new Request(shared.url, { headers: { range: 'bytes=1-3' } }), env);
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 1-3/${SAFE_IMAGE_RENDITION.byteLength}`);
  assert.equal(range.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(new Uint8Array(await range.arrayBuffer()), SAFE_IMAGE_RENDITION.slice(1, 4));

  assert.deepEqual(imageSourceFetches, [{
    path: photo.objectKey,
    authorization: 'Bearer test-key',
    usedCfImage: false,
  }], 'private Drive9 bytes must be fetched with auth before entering the Images binding');
  assert.deepEqual(imageTransformCalls, [{
    transform: { width: 2000, height: 2000, fit: 'scale-down', metadata: 'none' },
    output: { format: 'image/jpeg', quality: 86, anim: false },
  }]);
  assert.notDeepEqual(SAFE_IMAGE_RENDITION, bytes, 'the public endpoint must never return original upload bytes');
  assert.equal(containsBytes(SAFE_IMAGE_RENDITION, 'GPSLatitude'), false);
  assert.equal(containsBytes(SAFE_IMAGE_RENDITION, 'http://ns.adobe.com/xap/1.0/'), false);
});

test('image sharing explicitly strips non-location EXIF copyright metadata', async () => {
  resetState();
  const source = new Uint8Array([
    0xff, 0xd8,
    ...new TextEncoder().encode('Exif\0\0Copyright=Private Studio'),
    0xff, 0xd9,
  ]);
  const { body: { photo } } = await uploadFile('copyright.jpg', 'image/jpeg', source);

  const create = await handler(new Request(`http://localhost/api/photos/${photo.id}/share`, { method: 'POST' }), env);
  assert.equal(create.status, 200);

  const stored = drive9Store.get(`/photovault/share-renditions/${photo.id}.jpg`);
  assert.deepEqual(stored, SAFE_IMAGE_RENDITION);
  assert.equal(containsBytes(stored, 'Exif\0\0'), false);
  assert.equal(containsBytes(stored, 'Copyright'), false);
  assert.equal(imageTransformCalls[0].transform.metadata, 'none');
});

test('image sharing reports the Images binding 20 MB input limit before fetching source bytes', async () => {
  resetState();
  const { body: { photo } } = await uploadFile('large.jpg', 'image/jpeg', new Uint8Array([9, 8, 7]));
  updatePhotoMeta(photo, { size: 20_000_001 });

  const create = await handler(new Request(`http://localhost/api/photos/${photo.id}/share`, { method: 'POST' }), env);
  assert.equal(create.status, 422);
  assert.deepEqual(await create.json(), {
    error: 'This image is too large to share safely. Maximum shareable image size is 20 MB.',
    storage: 'drive9',
  });
  assert.deepEqual(imageSourceFetches, []);
  assert.deepEqual(imageTransformCalls, []);
});

test('POST /api/photos/:id/share creates metadata-stripped video and poster renditions', async () => {
  resetState();
  const source = new Uint8Array([
    ...new TextEncoder().encode('ftypqt  com.apple.quicktime.location.ISO6709=+31.2304+121.4737/'),
    0xa9, 0x78, 0x79, 0x7a,
  ]);
  assert.equal(containsBytes(source, 'com.apple.quicktime.location.ISO6709'), true);
  assert.equal(containsBytes(source, new Uint8Array([0xa9, 0x78, 0x79, 0x7a])), true);
  const { body: { photo } } = await uploadFile('clip.mp4', 'video/mp4', source);

  const create = await handler(new Request(`http://localhost/api/photos/${photo.id}/share`, { method: 'POST' }), env);
  assert.equal(create.status, 200);
  const { share } = await create.json();

  const file = await handler(new Request(`http://localhost/api/shares/${share.token}/file`), env);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), SAFE_VIDEO_RENDITION);

  const poster = await handler(new Request(`http://localhost/api/shares/${share.token}/poster`), env);
  assert.equal(poster.status, 200);
  assert.equal(poster.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(new Uint8Array(await poster.arrayBuffer()), SAFE_VIDEO_POSTER);
  assert.equal(containsBytes(SAFE_VIDEO_RENDITION, 'com.apple.quicktime.location.ISO6709'), false);
  assert.equal(containsBytes(SAFE_VIDEO_POSTER, 'com.apple.quicktime.location.ISO6709'), false);
  assert.deepEqual(mediaTransformCalls, [
    {
      transform: { width: 1920, height: 1080, fit: 'scale-down' },
      output: { mode: 'video', audio: true },
    },
    {
      transform: { width: 1600, height: 1200, fit: 'scale-down' },
      output: { mode: 'frame', time: '0s', format: 'jpg' },
    },
  ]);
});

test('share creation fails closed when a privacy-safe rendition cannot be produced', async () => {
  resetState();
  const { body: { photo } } = await uploadFile('private.jpg', 'image/jpeg', new Uint8Array([9, 8, 7]));
  failImageTransform = true;

  const create = await handler(new Request(`http://localhost/api/photos/${photo.id}/share`, { method: 'POST' }), env);
  assert.equal(create.status, 502);
  assert.deepEqual(await create.json(), {
    error: 'could not prepare a privacy-safe share rendition',
    storage: 'drive9',
  });

  const stored = JSON.parse(drive9Store.get(`/photovault/meta/${photo.id}.json`));
  assert.equal(stored.shareToken, undefined);
  assert.equal(stored.shareRenditionVersion, undefined);
  assert.equal([...drive9Store.keys()].some((path) => path.includes('/share-renditions/')), false);
});

test('share creation fails closed if transformed image bytes still contain EXIF or XMP', async () => {
  resetState();
  const { body: { photo } } = await uploadFile('private.jpg', 'image/jpeg', new Uint8Array([9, 8, 7]));
  imageRenditionBytes = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('safe-prefix http://ns.adobe.com/xap/'));
      controller.enqueue(new TextEncoder().encode('1.0/ private-tail'));
      controller.close();
    },
  });

  const create = await handler(new Request(`http://localhost/api/photos/${photo.id}/share`, { method: 'POST' }), env);
  assert.equal(create.status, 502);
  assert.equal([...drive9Store.keys()].some((path) => path.includes('/share-renditions/')), false);
  const stored = JSON.parse(drive9Store.get(`/photovault/meta/${photo.id}.json`));
  assert.equal(stored.shareToken, undefined);
});

test('share creation fails closed if transformed video retains QuickTime location metadata', async () => {
  resetState();
  const { body: { photo } } = await uploadFile('private.mp4', 'video/mp4', new Uint8Array([9, 8, 7]));
  videoRenditionBytes = new Uint8Array([
    ...new TextEncoder().encode('safe-prefix'),
    0xa9, 0x78, 0x79, 0x7a,
    ...new TextEncoder().encode('+31.2304+121.4737/'),
  ]);

  const create = await handler(new Request(`http://localhost/api/photos/${photo.id}/share`, { method: 'POST' }), env);
  assert.equal(create.status, 502);
  assert.equal([...drive9Store.keys()].some((path) => path.includes('/share-renditions/')), false);
  const stored = JSON.parse(drive9Store.get(`/photovault/meta/${photo.id}.json`));
  assert.equal(stored.shareToken, undefined);
});

test('video share creation removes the completed video when poster transformation fails', async () => {
  resetState();
  const { body: { photo } } = await uploadFile('private.mp4', 'video/mp4', new Uint8Array([9, 8, 7]));
  failMediaTransformMode = 'frame';

  const create = await handler(new Request(`http://localhost/api/photos/${photo.id}/share`, { method: 'POST' }), env);
  assert.equal(create.status, 502);
  assert.equal([...drive9Store.keys()].some((path) => path.includes(photo.id) && path.includes('/share-renditions/')), false);
  const stored = JSON.parse(drive9Store.get(`/photovault/meta/${photo.id}.json`));
  assert.equal(stored.shareToken, undefined);
  assert.equal(stored.shareRenditionVersion, undefined);
});

test('an existing share lazily migrates to the privacy-safe rendition', async () => {
  resetState();
  const { body: { photo } } = await uploadFile('legacy.jpg', 'image/jpeg', new Uint8Array([7, 6, 5]));
  const token = 'L'.repeat(32);
  updatePhotoMeta(photo, { shareToken: token, sharedAt: new Date().toISOString() });

  const metadata = await handler(new Request(`http://localhost/api/shares/${token}`), env);
  assert.equal(metadata.status, 200);
  const stored = JSON.parse(drive9Store.get(`/photovault/meta/${photo.id}.json`));
  assert.equal(stored.shareRenditionVersion, 1);
  const file = await handler(new Request(`http://localhost/api/shares/${token}/file`), env);
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), SAFE_IMAGE_RENDITION);
});

test('public share failures never expose upstream storage details', async () => {
  resetState();
  failDrive9GetPath = '/photovault/index.json.gz';
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    const response = await handler(new Request(`http://localhost/api/shares/${'S'.repeat(32)}`), env);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: 'share temporarily unavailable',
      storage: 'drive9',
    });
  } finally {
    console.warn = originalWarn;
  }
});

test('GET /api/shares/:token returns the same 404 for invalid, unshared, and revoked links', async () => {
  resetState();
  const { body: { photo } } = await uploadFile('private.jpg', 'image/jpeg', new Uint8Array(8));
  const validLookingToken = 'A'.repeat(32);

  for (const path of [`/api/shares/${photo.id}`, `/api/shares/${validLookingToken}`]) {
    const response = await handler(new Request(`http://localhost${path}`), env);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'share not found' });
  }

  const create = await handler(new Request(`http://localhost/api/photos/${photo.id}/share`, { method: 'POST' }), env);
  const token = (await create.json()).share.token;
  const revoke = await handler(new Request(`http://localhost/api/photos/${photo.id}/share`, { method: 'DELETE' }), env);
  assert.equal(revoke.status, 204);

  for (const suffix of ['', '/file', '/poster']) {
    const response = await handler(new Request(`http://localhost/api/shares/${token}${suffix}`), env);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'share not found' });
  }
});

test('archiving or deleting a photo invalidates its share link', async () => {
  resetState();
  const first = await uploadFile('archived.jpg', 'image/jpeg', new Uint8Array(8));
  const firstShare = await handler(new Request(`http://localhost/api/photos/${first.body.photo.id}/share`, { method: 'POST' }), env);
  const firstToken = (await firstShare.json()).share.token;
  const archive = await handler(new Request(`http://localhost/api/photos/${first.body.photo.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ archived: true }),
  }), env);
  assert.equal(archive.status, 200);
  for (const suffix of ['', '/file', '/poster']) {
    const response = await handler(new Request(`http://localhost/api/shares/${firstToken}${suffix}`), env);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal([...drive9Store.keys()].some((path) => path.includes(first.body.photo.id) && path.includes('/share-renditions/')), false);
  await handler(new Request(`http://localhost/api/photos/${first.body.photo.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ archived: false }),
  }), env);
  assert.equal((await handler(new Request(`http://localhost/api/shares/${firstToken}`), env)).status, 404, 'unarchiving must not reactivate the old link');

  const second = await uploadFile('deleted.jpg', 'image/jpeg', new Uint8Array(8));
  const secondShare = await handler(new Request(`http://localhost/api/photos/${second.body.photo.id}/share`, { method: 'POST' }), env);
  const secondToken = (await secondShare.json()).share.token;
  const remove = await handler(new Request(`http://localhost/api/photos/${second.body.photo.id}`, { method: 'DELETE' }), env);
  assert.equal(remove.status, 204);
  for (const suffix of ['', '/file', '/poster']) {
    const response = await handler(new Request(`http://localhost/api/shares/${secondToken}${suffix}`), env);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal([...drive9Store.keys()].some((path) => path.includes(second.body.photo.id) && path.includes('/share-renditions/')), false);
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
