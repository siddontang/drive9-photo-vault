import { buildDrive9SemanticResult } from './semantic';

export interface Env {
  DRIVE9_API_KEY: string;
  DRIVE9_SERVER?: string;
}

type MediaKind = 'image' | 'video';

type Photo = {
  id: string;
  owner: string;
  title: string;
  note: string;
  tags: string[];
  album: string;
  mime: string;
  size: number;
  objectKey: string;
  checksum: string;
  favorite: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  mediaKind: MediaKind;
  width?: number;
  height?: number;
  aiCaptionEn?: string;
  aiCaptionZh?: string;
  aiTextEn?: string;
  aiTextZh?: string;
  aiTagsEn?: string[];
  aiTagsZh?: string[];
  analysisStatus?: string;
};

type PhotoIndexItem = {
  id: string;
  owner: string;
  title: string;
  album: string;
  mime: string;
  size: number;
  objectKey: string;
  checksum: string;
  favorite: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  mediaKind: MediaKind;
  tags: string[];
  aiCaptionEn?: string;
  aiCaptionZh?: string;
  analysisStatus?: string;
};

const ALLOWED_VIDEO_MIME = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-msvideo',
  'video/x-matroska',
]);
const VIDEO_SIZE_LIMIT = 25 * 1024 * 1024;
const IMAGE_SIZE_LIMIT = 25 * 1024 * 1024;

const VIDEO_EXT_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
};

function effectiveVideoMime(rawMime: string, filename: string): string | null {
  if (ALLOWED_VIDEO_MIME.has(rawMime)) return rawMime;
  if (rawMime === '' || rawMime === 'application/octet-stream') {
    const name = filename.toLowerCase();
    for (const [ext, mime] of Object.entries(VIDEO_EXT_MIME)) {
      if (name.endsWith(ext)) return mime;
    }
  }
  return null;
}

function mediaKindFromMime(mime: string, filename = ''): MediaKind | null {
  if (mime.startsWith('image/')) return 'image';
  if (effectiveVideoMime(mime, filename)) return 'video';
  return null;
}

const INDEX_PATH = '/photovault/index.json.gz';
const LEGACY_INDEX_PATH = '/photovault/index.json';
const ROOT = '/photovault';
const META_ROOT = `${ROOT}/meta`;
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors, ...(init.headers || {}) },
  });
}
function text(data: string, init: ResponseInit = {}) {
  return new Response(data, { ...init, headers: { 'content-type': 'text/plain; charset=utf-8', ...cors, ...(init.headers || {}) } });
}
async function sha256(buf: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function tokenize(input: string) {
  return input.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(Boolean);
}
function drive9Base(env: Env) {
  return (env.DRIVE9_SERVER || 'https://api.drive9.ai').replace(/\/$/, '');
}
function fsUrl(env: Env, path: string, query = '') {
  if (!path.startsWith('/')) path = '/' + path;
  return `${drive9Base(env)}/v1/fs${path}${query}`;
}
async function d9(env: Env, method: string, path: string, body?: BodyInit | null, headers: HeadersInit = {}, query = '') {
  if (!env.DRIVE9_API_KEY) return new Response('missing DRIVE9_API_KEY', { status: 500 });
  return fetch(fsUrl(env, path, query), {
    method,
    body,
    headers: { authorization: `Bearer ${env.DRIVE9_API_KEY}`, ...headers },
  });
}
async function d9ReadJson<T>(env: Env, path: string, fallback: T): Promise<T> {
  const res = await d9(env, 'GET', path);
  if (res.status === 404) return fallback;
  if (!res.ok) throw new Error(`drive9 read ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}
async function d9WriteJson(env: Env, path: string, data: unknown) {
  const res = await d9(env, 'PUT', path, JSON.stringify(data), { 'content-type': 'application/json', 'x-dat9-description': 'PhotoVault metadata index' });
  if (!res.ok) throw new Error(`drive9 write ${path} failed: ${res.status} ${await res.text()}`);
}
async function gzipText(textValue: string): Promise<ArrayBuffer> {
  const stream = new Blob([textValue]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}
async function gunzipText(buf: ArrayBuffer): Promise<string> {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}
function metaPath(id: string) {
  return `${META_ROOT}/${id}.json`;
}
function inferMediaKind(x: { mediaKind?: MediaKind; mime?: string }): MediaKind {
  if (x.mediaKind === 'video' || x.mediaKind === 'image') return x.mediaKind;
  if (x.mime && ALLOWED_VIDEO_MIME.has(x.mime)) return 'video';
  return 'image';
}

function photoFromIndexItem(x: PhotoIndexItem | Photo): Photo {
  return {
    id: x.id,
    owner: x.owner,
    title: x.title,
    note: (x as Photo).note || '',
    tags: x.tags || [],
    album: x.album,
    mime: x.mime,
    size: x.size,
    objectKey: x.objectKey,
    checksum: x.checksum,
    favorite: !!x.favorite,
    archived: !!x.archived,
    createdAt: x.createdAt,
    updatedAt: x.updatedAt,
    mediaKind: inferMediaKind(x),
    aiCaptionEn: x.aiCaptionEn || '',
    aiCaptionZh: x.aiCaptionZh || '',
    aiTextEn: (x as Photo).aiTextEn || '',
    aiTextZh: (x as Photo).aiTextZh || '',
    aiTagsEn: (x as Photo).aiTagsEn || [],
    aiTagsZh: (x as Photo).aiTagsZh || [],
    analysisStatus: x.analysisStatus || (x as Photo).analysisStatus,
  };
}
async function getIndexItems(env: Env): Promise<PhotoIndexItem[]> {
  const res = await d9(env, 'GET', INDEX_PATH);
  let raw: any[] | null = null;
  if (res.ok) {
    const buf = await res.arrayBuffer();
    raw = JSON.parse(await gunzipText(buf));
  } else if (res.status === 404) {
    raw = await d9ReadJson<any[]>(env, LEGACY_INDEX_PATH, []);
  } else {
    throw new Error(`drive9 read ${INDEX_PATH} failed: ${res.status} ${await res.text()}`);
  }
  return (raw || []).map((x) => compactPhotoForIndex(photoFromIndexItem(x)));
}
async function getPhotoMeta(env: Env, item: PhotoIndexItem): Promise<Photo> {
  const res = await d9(env, 'GET', metaPath(item.id));
  if (res.ok) return compactPhotoMeta(await res.json<Photo>());
  return photoFromIndexItem(item);
}
async function getAllPhotos(env: Env): Promise<Photo[]> {
  const items = await getIndexItems(env);
  return Promise.all(items.map((item) => getPhotoMeta(env, item)));
}
function compactPhotoForIndex(p: Photo): PhotoIndexItem {
  return {
    id: p.id,
    owner: p.owner,
    title: (p.title || '').slice(0, 120),
    album: (p.album || 'Inbox').slice(0, 80),
    mime: p.mime,
    size: p.size,
    objectKey: p.objectKey,
    checksum: p.checksum,
    favorite: !!p.favorite,
    archived: !!p.archived,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    mediaKind: inferMediaKind(p),
    tags: [...new Set((p.tags || []).map(String).filter(Boolean))].slice(0, 6),
    aiCaptionEn: (p.aiCaptionEn || '').slice(0, 140),
    aiCaptionZh: (p.aiCaptionZh || '').slice(0, 140),
    analysisStatus: p.analysisStatus,
  };
}
function compactPhotoMeta(p: Photo): Photo {
  const captionEn = (p.aiCaptionEn || '').slice(0, 500);
  const captionZh = (p.aiCaptionZh || '').slice(0, 500);
  const textEn = (p.aiTextEn || '').slice(0, 1100);
  const textZh = (p.aiTextZh || '').slice(0, 1100);
  const tags = [...new Set((p.tags || []).map(String).filter(Boolean))].slice(0, 24);
  const tagsEn = [...new Set((p.aiTagsEn || []).map(String).filter(Boolean))].slice(0, 24);
  const tagsZh = [...new Set((p.aiTagsZh || []).map(String).filter(Boolean))].slice(0, 24);
  return {
    ...p,
    title: (p.title || '').slice(0, 160),
    note: (p.note || '').slice(0, 500),
    album: (p.album || 'Inbox').slice(0, 80),
    tags,
    aiCaptionEn: captionEn,
    aiCaptionZh: captionZh,
    aiTextEn: textEn,
    aiTextZh: textZh,
    aiTagsEn: tagsEn,
    aiTagsZh: tagsZh,
  };
}
async function setIndex(env: Env, photos: (Photo | PhotoIndexItem)[]) {
  const payload = JSON.stringify(photos.map((p) => compactPhotoForIndex(photoFromIndexItem(p as any))));
  const gz = await gzipText(payload);
  const res = await d9(env, 'PUT', INDEX_PATH, gz, { 'content-type': 'application/gzip', 'x-dat9-description': 'PhotoVault tiny listing index (gzip)' });
  if (!res.ok) throw new Error(`drive9 write ${INDEX_PATH} failed: ${res.status} ${await res.text()}`);
}
async function setPhotoMeta(env: Env, photo: Photo) {
  const compact = compactPhotoMeta(photo);
  const res = await d9(env, 'PUT', metaPath(photo.id), JSON.stringify(compact), { 'content-type': 'application/json', 'x-dat9-description': `PhotoVault metadata for ${photo.title}` });
  if (!res.ok) throw new Error(`drive9 write ${metaPath(photo.id)} failed: ${res.status} ${await res.text()}`);
}
async function deletePhotoMeta(env: Env, id: string) {
  const res = await d9(env, 'DELETE', metaPath(id));
  if (!res.ok && res.status !== 404) throw new Error(`drive9 delete ${metaPath(id)} failed: ${res.status} ${await res.text()}`);
}


async function refreshDrive9Semantics(env: Env, photos: Photo[], limit = 20) {
  let changed = false;
  let checked = 0;
  for (const p of photos) {
    if (checked >= limit) break;
    const needs = (!p.aiTextEn && !p.aiTextZh) || p.analysisStatus === 'pending';
    if (!needs || p.archived) continue;
    checked++;
    const analysis = await getDrive9Semantic(env, p.objectKey, p.tags);
    if (analysis.text.en || analysis.text.zh) {
      p.aiCaptionEn = analysis.caption.en;
      p.aiCaptionZh = analysis.caption.zh;
      p.aiTextEn = analysis.text.en.slice(0, 1100);
      p.aiTextZh = analysis.text.zh.slice(0, 1100);
      p.aiTagsEn = analysis.tags.en;
      p.aiTagsZh = analysis.tags.zh;
      p.tags = analysis.tags.en.length ? analysis.tags.en : p.tags;
      p.analysisStatus = analysis.status;
      p.updatedAt = new Date().toISOString();
      changed = true;
    } else if (analysis.status === 'pending' && !p.analysisStatus) {
      p.aiCaptionEn = analysis.caption.en;
      p.analysisStatus = 'pending';
      changed = true;
    }
  }
  if (changed) {
    try {
      for (const p of photos) await setPhotoMeta(env, p);
      await setIndex(env, photos);
    } catch (e) { console.warn('semantic refresh metadata write failed', e); }
  }
  return photos.map(compactPhotoMeta);
}

function scorePhoto(photo: Photo, q: string) {
  if (!q) return 1;
  const hay = [
    photo.title, photo.note, photo.album, photo.tags.join(' '), photo.owner,
    photo.aiCaptionEn || '', photo.aiCaptionZh || '',
    photo.aiTextEn || '', photo.aiTextZh || '',
    (photo.aiTagsEn || []).join(' '), (photo.aiTagsZh || []).join(' '),
  ].join(' ').toLowerCase();
  const words = tokenize(q);
  if (!words.length) return 1;
  return words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0) / words.length;
}


async function getDrive9Semantic(env: Env, path: string, existingTags: string[]) {
  const res = await d9(env, 'GET', path, null, {}, '?stat=1');
  if (res.ok) {
    const meta = await res.json<any>();
    const analysis = buildDrive9SemanticResult(meta, existingTags);
    if (analysis) return analysis;
  }
  return {
    caption: { zh: '', en: 'Uploaded file. drive9 is still analyzing it; search metadata may appear shortly.' },
    text: { zh: '', en: '' },
    tags: { zh: [] as string[], en: [] as string[] },
    status: 'pending',
  };
}
type Drive9UploadPlan = { upload_id: string; part_size: number; total_parts: number };
type Drive9PresignedPart = { number: number; url: string; size: number; headers?: Record<string, string> };
type Drive9CompletePart = { number: number; etag: string };
const DIRECT_PUT_LIMIT = 50_000;

async function drive9Upload(env: Env, path: string, buf: ArrayBuffer, mime: string, description: string, tags: Record<string, string> = {}) {
  if (buf.byteLength < DIRECT_PUT_LIMIT) {
    const res = await d9(env, 'PUT', path, buf, {
      'content-type': mime,
      'x-dat9-description': description,
      ...Object.fromEntries(Object.entries(tags).map(([k, v]) => [`x-dat9-tag-${k}`, v])),
    });
    if (!res.ok) throw new Error(`drive9 direct upload failed: ${res.status} ${await res.text()}`);
    return;
  }

  const init = await fetch(`${drive9Base(env)}/v2/uploads/initiate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.DRIVE9_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path, total_size: buf.byteLength, description }),
  });
  if (!init.ok) throw new Error(`drive9 multipart initiate failed: ${init.status} ${await init.text()}`);
  const plan = await init.json<Drive9UploadPlan>();

  const batchSize = 8;
  const completed: Drive9CompletePart[] = [];
  for (let start = 1; start <= plan.total_parts; start += batchSize) {
    const end = Math.min(plan.total_parts, start + batchSize - 1);
    const presign = await fetch(`${drive9Base(env)}/v2/uploads/${plan.upload_id}/presign-batch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.DRIVE9_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ parts: Array.from({ length: end - start + 1 }, (_, i) => ({ part_number: start + i })) }),
    });
    if (!presign.ok) throw new Error(`drive9 multipart presign failed: ${presign.status} ${await presign.text()}`);
    const presigned = await presign.json<{ parts: Drive9PresignedPart[] }>();
    const uploaded = await Promise.all(presigned.parts.map(async (part) => {
      const offset = (part.number - 1) * plan.part_size;
      const chunk = buf.slice(offset, offset + part.size);
      const headers = new Headers(part.headers || {});
      headers.delete('host');
      const up = await fetch(part.url, { method: 'PUT', headers, body: chunk });
      if (!up.ok) throw new Error(`drive9 part ${part.number} upload failed: ${up.status} ${await up.text()}`);
      return { number: part.number, etag: up.headers.get('etag') || '' };
    }));
    completed.push(...uploaded);
  }

  completed.sort((a, b) => a.number - b.number);
  const complete = await fetch(`${drive9Base(env)}/v2/uploads/${plan.upload_id}/complete`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.DRIVE9_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ parts: completed, tags }),
  });
  if (!complete.ok) throw new Error(`drive9 multipart complete failed: ${complete.status} ${await complete.text()}`);
}

function openapi(origin: string) {
  return {
    openapi: '3.1.0',
    info: { title: 'PhotoVault OpenAPI', version: '0.3.0', description: 'Drive9-native media (photo + video) storage, management, and search API.' },
    servers: [{ url: origin }],
    paths: {
      '/api/health': { get: { summary: 'Health check', responses: { '200': { description: 'OK' } } } },
      '/api/photos': {
        get: { summary: 'List and search photos stored in drive9', parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' } }, { name: 'tag', in: 'query', schema: { type: 'string' } },
          { name: 'owner', in: 'query', schema: { type: 'string' } }, { name: 'favorite', in: 'query', schema: { type: 'boolean' } }
        ], responses: { '200': { description: 'Photo list' } } },
        post: { summary: 'Upload a photo or video into drive9 with metadata', requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, title: { type: 'string' }, tags: { type: 'string' }, note: { type: 'string' }, album: { type: 'string' }, owner: { type: 'string' } }, required: ['file'] } } } }, responses: { '201': { description: 'Created media item' } } }
      },
      '/api/photos/{id}': { patch: { summary: 'Update metadata/state' }, delete: { summary: 'Delete photo from drive9' } },
      '/api/photos/{id}/file': { get: { summary: 'Stream original media bytes from drive9 (supports Range for video)' } },
      '/api/collections': { get: { summary: 'Smart collections from drive9 metadata' } }
    }
  };
}
const mimeExtMap: Record<string, string> = {
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'video/x-matroska': 'mkv',
  'image/jpeg': 'jpg',
};
function extFor(mime: string) {
  if (mimeExtMap[mime]) return mimeExtMap[mime];
  return (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
}
async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  try {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (path === '/' || path === '/docs') return text('PhotoVault API on drive9. Try /openapi.json, /api/health, /api/photos');
    if (path === '/openapi.json') return json(openapi(url.origin));
    if (path === '/api/health') {
      const status = await fetch(`${drive9Base(env)}/v1/status`, { headers: { authorization: `Bearer ${env.DRIVE9_API_KEY || ''}` } });
      const body = await status.text().catch(() => '');
      return json({ ok: status.ok, service: 'drive9-photo-api', storage: 'drive9', drive9Status: status.status, drive9: body ? safeJson(body) : null, time: new Date().toISOString() }, { status: status.ok ? 200 : 503 });
    }
    if (path === '/api/photos' && req.method === 'GET') {
      const q = url.searchParams.get('q') || '';
      const tag = (url.searchParams.get('tag') || '').toLowerCase();
      const owner = url.searchParams.get('owner') || '';
      const favorite = url.searchParams.get('favorite');
      const photos = await refreshDrive9Semantics(env, await getAllPhotos(env));
      const filtered = photos
        .filter((p) => !p.archived)
        .map((p) => ({ photo: p, score: scorePhoto(p, q) }))
        .filter(({ photo, score }) => score > 0 && (!tag || photo.tags.map((t) => t.toLowerCase()).includes(tag)) && (!owner || photo.owner === owner) && (favorite === null || String(photo.favorite) === favorite))
        .sort((a, b) => b.score - a.score || +new Date(b.photo.createdAt) - +new Date(a.photo.createdAt))
        .map(({ photo, score }) => ({ ...photo, score, url: `${url.origin}/api/photos/${photo.id}/file` }));
      return json({ photos: filtered, count: filtered.length, storage: 'drive9' });
    }
    if (path === '/api/photos' && req.method === 'POST') {
      const form = await req.formData();
      const file = form.get('file');
      if (!(file instanceof File)) return json({ error: 'file field is required' }, { status: 400 });
      const kind = mediaKindFromMime(file.type, file.name);
      if (!kind) return json({ error: `unsupported file type: ${file.type || '(empty)'}. Accepted: image/*, video/mp4, video/quicktime, video/webm, video/x-msvideo, video/x-matroska` }, { status: 400 });
      const resolvedMime = kind === 'video' ? (effectiveVideoMime(file.type, file.name) || file.type) : file.type;
      const sizeLimit = kind === 'video' ? VIDEO_SIZE_LIMIT : IMAGE_SIZE_LIMIT;
      if (file.size > sizeLimit) return json({ error: `demo limit: ${sizeLimit / 1024 / 1024}MB per ${kind}` }, { status: 413 });
      const buf = await file.arrayBuffer();
      const checksum = await sha256(buf);
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const objectKey = `${ROOT}/photos/${id}.${extFor(resolvedMime)}`;
      const tags = String(form.get('tags') || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20);
      const defaultTitle = file.name.replace(/\.[^.]+$/, '') || (kind === 'video' ? 'Untitled video' : 'Untitled photo');
      const pendingCaption = kind === 'video'
        ? 'Uploaded video. drive9 is analyzing it; this may take a while.'
        : 'Uploaded image. drive9 is still analyzing it; search metadata may appear shortly.';
      await drive9Upload(env, objectKey, buf, resolvedMime, [String(form.get('title') || file.name), String(form.get('note') || ''), String(form.get('album') || 'Inbox'), tags.join(' ')].filter(Boolean).join(' — '), { app: 'photovault', album: String(form.get('album') || 'Inbox') });
      const photo: Photo = {
        id,
        owner: String(form.get('owner') || 'guest'),
        title: String(form.get('title') || defaultTitle),
        note: String(form.get('note') || ''),
        tags,
        album: String(form.get('album') || 'Inbox'),
        mime: resolvedMime,
        size: file.size,
        objectKey,
        checksum,
        favorite: false,
        archived: false,
        createdAt: now,
        updatedAt: now,
        mediaKind: kind,
        aiCaptionEn: pendingCaption,
        aiCaptionZh: '',
        aiTextEn: '',
        aiTextZh: '',
        aiTagsEn: [],
        aiTagsZh: [],
        analysisStatus: 'pending',
      };
      const photos = await getAllPhotos(env);
      const dupes = photos.filter((p) => p.checksum === checksum).map((p) => p.id);
      photos.unshift(photo);
      await setPhotoMeta(env, photo);
      await setIndex(env, photos);
      return json({ photo: { ...photo, url: `${url.origin}/api/photos/${id}/file`, duplicateOf: dupes }, duplicateOf: dupes, storage: 'drive9' }, { status: 201 });
    }
    const fileMatch = path.match(/^\/api\/photos\/([^/]+)\/file$/);
    if (fileMatch && req.method === 'GET') {
      const id = fileMatch[1];
      const photo = (await getAllPhotos(env)).find((p) => p.id === id && !p.archived);
      if (!photo) return json({ error: 'photo not found' }, { status: 404 });
      const rangeHeader = req.headers.get('range');
      const headers: HeadersInit = { authorization: `Bearer ${env.DRIVE9_API_KEY}` };
      if (rangeHeader) headers['range'] = rangeHeader;
      const obj = await fetch(fsUrl(env, photo.objectKey), { method: 'GET', headers });
      if (!obj.ok && obj.status !== 206) return json({ error: 'drive9 read failed', status: obj.status, detail: await obj.text() }, { status: 502 });
      const respHeaders: Record<string, string> = { ...cors, 'content-type': photo.mime, 'cache-control': 'public, max-age=31536000, immutable' };
      if (obj.status === 206) {
        const cr = obj.headers.get('content-range');
        if (cr) respHeaders['content-range'] = cr;
        const cl = obj.headers.get('content-length');
        if (cl) respHeaders['content-length'] = cl;
        respHeaders['accept-ranges'] = 'bytes';
        return new Response(obj.body, { status: 206, headers: respHeaders });
      }
      const cl = obj.headers.get('content-length');
      if (cl) respHeaders['content-length'] = cl;
      respHeaders['accept-ranges'] = 'bytes';
      return new Response(obj.body, { headers: respHeaders });
    }
    const photoMatch = path.match(/^\/api\/photos\/([^/]+)$/);
    if (photoMatch && req.method === 'PATCH') {
      const id = photoMatch[1];
      const patch = await req.json<any>().catch(() => ({}));
      const photos = await getAllPhotos(env);
      const i = photos.findIndex((p) => p.id === id);
      if (i < 0) return json({ error: 'photo not found' }, { status: 404 });
      const prev = photos[i];
      const next: Photo = { ...prev,
        title: typeof patch.title === 'string' ? patch.title : prev.title,
        note: typeof patch.note === 'string' ? patch.note : prev.note,
        album: typeof patch.album === 'string' ? patch.album : prev.album,
        tags: Array.isArray(patch.tags) ? [...new Set(patch.tags.map(String).map((x: string) => x.trim()).filter(Boolean))].slice(0, 24) : prev.tags,
        aiTagsEn: Array.isArray(patch.tags) ? [...new Set(patch.tags.map(String).map((x: string) => x.trim()).filter(Boolean))].slice(0, 24) : prev.aiTagsEn,
        aiTagsZh: Array.isArray(patch.tags) ? [] : prev.aiTagsZh,
        favorite: typeof patch.favorite === 'boolean' ? patch.favorite : prev.favorite,
        archived: typeof patch.archived === 'boolean' ? patch.archived : prev.archived,
        updatedAt: new Date().toISOString(),
      };
      photos[i] = next;
      await setPhotoMeta(env, next);
      await setIndex(env, photos);
      return json({ photo: { ...next, url: `${url.origin}/api/photos/${id}/file` }, storage: 'drive9' });
    }
    if (photoMatch && req.method === 'DELETE') {
      const id = photoMatch[1];
      const photos = await getAllPhotos(env);
      const found = photos.find((p) => p.id === id);
      if (found) await d9(env, 'DELETE', found.objectKey);
      await deletePhotoMeta(env, id);
      await setIndex(env, photos.filter((p) => p.id !== id));
      return new Response(null, { status: 204, headers: cors });
    }
    if (path === '/api/collections' && req.method === 'GET') {
      const photos = (await refreshDrive9Semantics(env, await getAllPhotos(env))).filter((p) => !p.archived);
      const tags: Record<string, number> = {}, albums: Record<string, number> = {}, dupes: Record<string, string[]> = {};
      for (const p of photos) {
        albums[p.album] = (albums[p.album] || 0) + 1;
        for (const t of p.tags) tags[t] = (tags[t] || 0) + 1;
        (dupes[p.checksum] ||= []).push(p.id);
      }
      const imageCount = photos.filter((p) => inferMediaKind(p) === 'image').length;
      const videoCount = photos.filter((p) => inferMediaKind(p) === 'video').length;
      return json({ storage: 'drive9', totals: { photos: photos.length, images: imageCount, videos: videoCount, favorites: photos.filter((p) => p.favorite).length, bytes: photos.reduce((s, p) => s + p.size, 0) }, albums: Object.entries(albums).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count), tags: Object.entries(tags).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count), duplicates: Object.values(dupes).filter((ids) => ids.length > 1), smart: [{ id: 'favorites', name: 'Favorites', count: photos.filter((p) => p.favorite).length }, { id: 'recent', name: 'Recently added', count: Math.min(photos.length, 24) }, { id: 'duplicates', name: 'Possible duplicates', count: Object.values(dupes).filter((ids) => ids.length > 1).length }] });
    }
    return json({ error: 'not found' }, { status: 404 });
  } catch (e: any) {
    return json({ error: e?.message || String(e), storage: 'drive9' }, { status: 500 });
  }
}
function safeJson(s: string) { try { return JSON.parse(s); } catch { return s.slice(0, 500); } }
export default { fetch: handle };
