export interface Env {
  DRIVE9_API_KEY: string;
  DRIVE9_SERVER?: string;
}

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
  width?: number;
  height?: number;
};

const INDEX_PATH = '/photovault/index.json';
const ROOT = '/photovault';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...cors, ...(init.headers || {}) },
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
async function getIndex(env: Env): Promise<Photo[]> {
  return d9ReadJson<Photo[]>(env, INDEX_PATH, []);
}
async function setIndex(env: Env, photos: Photo[]) {
  await d9WriteJson(env, INDEX_PATH, photos);
}
function scorePhoto(photo: Photo, q: string) {
  if (!q) return 1;
  const hay = [photo.title, photo.note, photo.album, photo.tags.join(' '), photo.owner].join(' ').toLowerCase();
  const words = tokenize(q);
  if (!words.length) return 1;
  return words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0) / words.length;
}
function openapi(origin: string) {
  return {
    openapi: '3.1.0',
    info: { title: 'PhotoVault OpenAPI', version: '0.2.0', description: 'Drive9-native advanced picture storage, management, and search API.' },
    servers: [{ url: origin }],
    paths: {
      '/api/health': { get: { summary: 'Health check', responses: { '200': { description: 'OK' } } } },
      '/api/photos': {
        get: { summary: 'List and search photos stored in drive9', parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' } }, { name: 'tag', in: 'query', schema: { type: 'string' } },
          { name: 'owner', in: 'query', schema: { type: 'string' } }, { name: 'favorite', in: 'query', schema: { type: 'boolean' } }
        ], responses: { '200': { description: 'Photo list' } } },
        post: { summary: 'Upload a photo into drive9 with metadata', requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, title: { type: 'string' }, tags: { type: 'string' }, note: { type: 'string' }, album: { type: 'string' }, owner: { type: 'string' } }, required: ['file'] } } } }, responses: { '201': { description: 'Created photo' } } }
      },
      '/api/photos/{id}': { patch: { summary: 'Update metadata/state' }, delete: { summary: 'Delete photo from drive9' } },
      '/api/photos/{id}/file': { get: { summary: 'Stream original photo bytes from drive9' } },
      '/api/collections': { get: { summary: 'Smart collections from drive9 metadata' } }
    }
  };
}
function extFor(mime: string) {
  return (mime.split('/')[1] || 'img').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'img';
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
      const photos = await getIndex(env);
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
      if (!file.type.startsWith('image/')) return json({ error: 'only image uploads are supported' }, { status: 400 });
      if (file.size > 25 * 1024 * 1024) return json({ error: 'demo limit: 25MB per image' }, { status: 413 });
      const buf = await file.arrayBuffer();
      const checksum = await sha256(buf);
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const objectKey = `${ROOT}/photos/${id}.${extFor(file.type)}`;
      const tags = String(form.get('tags') || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20);
      const photo: Photo = {
        id,
        owner: String(form.get('owner') || 'guest'),
        title: String(form.get('title') || file.name.replace(/\.[^.]+$/, '') || 'Untitled photo'),
        note: String(form.get('note') || ''),
        tags,
        album: String(form.get('album') || 'Inbox'),
        mime: file.type,
        size: file.size,
        objectKey,
        checksum,
        favorite: false,
        archived: false,
        createdAt: now,
        updatedAt: now,
      };
      const upload = await d9(env, 'PUT', objectKey, buf, {
        'content-type': file.type,
        'x-dat9-description': [photo.title, photo.note, photo.album, tags.join(' ')].filter(Boolean).join(' — '),
        'x-dat9-tag-app': 'photovault',
        'x-dat9-tag-album': photo.album,
      });
      if (!upload.ok) return json({ error: 'drive9 upload failed', status: upload.status, detail: await upload.text() }, { status: 502 });
      const photos = await getIndex(env);
      const dupes = photos.filter((p) => p.checksum === checksum).map((p) => p.id);
      photos.unshift(photo);
      await setIndex(env, photos);
      return json({ photo: { ...photo, url: `${url.origin}/api/photos/${id}/file`, duplicateOf: dupes }, duplicateOf: dupes, storage: 'drive9' }, { status: 201 });
    }
    const fileMatch = path.match(/^\/api\/photos\/([^/]+)\/file$/);
    if (fileMatch && req.method === 'GET') {
      const id = fileMatch[1];
      const photo = (await getIndex(env)).find((p) => p.id === id && !p.archived);
      if (!photo) return json({ error: 'photo not found' }, { status: 404 });
      const obj = await d9(env, 'GET', photo.objectKey);
      if (!obj.ok) return json({ error: 'drive9 read failed', status: obj.status, detail: await obj.text() }, { status: 502 });
      return new Response(obj.body, { headers: { ...cors, 'content-type': photo.mime, 'cache-control': 'public, max-age=3600' } });
    }
    const photoMatch = path.match(/^\/api\/photos\/([^/]+)$/);
    if (photoMatch && req.method === 'PATCH') {
      const id = photoMatch[1];
      const patch = await req.json<any>().catch(() => ({}));
      const photos = await getIndex(env);
      const i = photos.findIndex((p) => p.id === id);
      if (i < 0) return json({ error: 'photo not found' }, { status: 404 });
      const prev = photos[i];
      const next: Photo = { ...prev,
        title: typeof patch.title === 'string' ? patch.title : prev.title,
        note: typeof patch.note === 'string' ? patch.note : prev.note,
        album: typeof patch.album === 'string' ? patch.album : prev.album,
        tags: Array.isArray(patch.tags) ? patch.tags.map(String).slice(0, 20) : prev.tags,
        favorite: typeof patch.favorite === 'boolean' ? patch.favorite : prev.favorite,
        archived: typeof patch.archived === 'boolean' ? patch.archived : prev.archived,
        updatedAt: new Date().toISOString(),
      };
      photos[i] = next;
      await setIndex(env, photos);
      return json({ photo: { ...next, url: `${url.origin}/api/photos/${id}/file` }, storage: 'drive9' });
    }
    if (photoMatch && req.method === 'DELETE') {
      const id = photoMatch[1];
      const photos = await getIndex(env);
      const found = photos.find((p) => p.id === id);
      if (found) await d9(env, 'DELETE', found.objectKey);
      await setIndex(env, photos.filter((p) => p.id !== id));
      return new Response(null, { status: 204, headers: cors });
    }
    if (path === '/api/collections' && req.method === 'GET') {
      const photos = (await getIndex(env)).filter((p) => !p.archived);
      const tags: Record<string, number> = {}, albums: Record<string, number> = {}, dupes: Record<string, string[]> = {};
      for (const p of photos) {
        albums[p.album] = (albums[p.album] || 0) + 1;
        for (const t of p.tags) tags[t] = (tags[t] || 0) + 1;
        (dupes[p.checksum] ||= []).push(p.id);
      }
      return json({ storage: 'drive9', totals: { photos: photos.length, favorites: photos.filter((p) => p.favorite).length, bytes: photos.reduce((s, p) => s + p.size, 0) }, albums: Object.entries(albums).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count), tags: Object.entries(tags).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count), duplicates: Object.values(dupes).filter((ids) => ids.length > 1), smart: [{ id: 'favorites', name: 'Favorites', count: photos.filter((p) => p.favorite).length }, { id: 'recent', name: 'Recently added', count: Math.min(photos.length, 24) }, { id: 'duplicates', name: 'Possible duplicates', count: Object.values(dupes).filter((ids) => ids.length > 1).length }] });
    }
    return json({ error: 'not found' }, { status: 404 });
  } catch (e: any) {
    return json({ error: e?.message || String(e), storage: 'drive9' }, { status: 500 });
  }
}
function safeJson(s: string) { try { return JSON.parse(s); } catch { return s.slice(0, 500); } }
export default { fetch: handle };
