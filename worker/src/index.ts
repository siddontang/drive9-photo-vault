import { buildDrive9SemanticResult } from './semantic.js';
import { rerankPhotoCandidates } from './search.js';
import { drive9UploadStream, UploadBodySizeError } from './upload.js';

export interface Env {
  DRIVE9_API_KEY: string;
  DRIVE9_SERVER?: string;
  IMAGES?: ImagesBinding;
  MEDIA?: MediaBinding;
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
  shareToken?: string;
  sharedAt?: string;
  shareRenditionVersion?: number;
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
  shareToken?: string;
  sharedAt?: string;
  shareRenditionVersion?: number;
};

type Drive9SearchResult = {
  path: string;
  score?: number;
};

const ALLOWED_VIDEO_MIME = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-msvideo',
  'video/x-matroska',
]);
const VIDEO_SIZE_LIMIT = 40_000_000;
const IMAGE_SIZE_LIMIT = 25 * 1024 * 1024;
const IMAGE_SHARE_SIZE_LIMIT = 20_000_000;
const LEGACY_MULTIPART_FILE_LIMIT = 25 * 1024 * 1024;
const LEGACY_MULTIPART_REQUEST_LIMIT = LEGACY_MULTIPART_FILE_LIMIT + 1024 * 1024;
const UPLOAD_METADATA_HEADER = 'x-photovault-upload-metadata';
const MAX_UPLOAD_METADATA_HEADER_LENGTH = 16 * 1024;

const VIDEO_EXT_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
};

function effectiveVideoMime(rawMime: string, filename: string): string | null {
  // Strip MIME parameters (e.g. "video/mp4; codecs=avc1" → "video/mp4")
  const base = rawMime.split(';')[0].trim().toLowerCase();
  if (ALLOWED_VIDEO_MIME.has(base)) return base;
  // Fall back to extension for generic/empty types (aligned with Drive9 #751)
  if (base === '' || base === 'application/octet-stream' || base === 'text/plain') {
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
const SHARE_TOKEN_BYTES = 24;
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const SHARE_RENDITION_ROOT = `${ROOT}/share-renditions`;
const SHARE_RENDITION_VERSION = 1;
const SHARE_PRIVATE_METADATA_MARKERS = [
  new TextEncoder().encode('Exif\0\0'),
  new TextEncoder().encode('http://ns.adobe.com/xap/1.0/'),
  new TextEncoder().encode('GPSLatitude'),
  new TextEncoder().encode('GPSLongitude'),
  new TextEncoder().encode('com.apple.quicktime.location.ISO6709'),
  new Uint8Array([0xa9, 0x78, 0x79, 0x7a]),
];
const SHARE_PRIVATE_METADATA_TAIL = Math.max(...SHARE_PRIVATE_METADATA_MARKERS.map((marker) => marker.length)) - 1;
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': `Content-Type, Authorization, ${UPLOAD_METADATA_HEADER}`,
  'Access-Control-Max-Age': '86400',
};

type UploadFields = {
  name: string;
  size: number;
  owner: string;
  title: string;
  tags: string;
  note: string;
  album: string;
};

type IncomingUpload = {
  fields: UploadFields;
  mime: string;
  stream: ReadableStream<Uint8Array>;
};

class HttpError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type ShareRenditionStage =
  | 'source_fetch'
  | 'images_binding'
  | 'image_transform'
  | 'media_binding'
  | 'video_transform'
  | 'video_poster_transform'
  | 'privacy_scan'
  | 'rendition_write';

class ShareRenditionError extends Error {
  constructor(readonly stage: ShareRenditionStage, message: string) {
    super(message);
  }
}

function uploadString(value: unknown, fallback: string, maxLength: number) {
  return (typeof value === 'string' ? value : fallback).slice(0, maxLength);
}

function emptyUploadStream() {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
}

function streamUpload(req: Request): IncomingUpload | null {
  const encoded = req.headers.get(UPLOAD_METADATA_HEADER);
  if (encoded === null) return null;
  if (encoded.length > MAX_UPLOAD_METADATA_HEADER_LENGTH) {
    throw new HttpError(400, 'upload metadata is too large');
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(decodeURIComponent(encoded)) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'invalid upload metadata');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'invalid upload metadata');
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) {
    throw new HttpError(400, 'upload filename is required');
  }
  if (!Number.isSafeInteger(raw.size) || (raw.size as number) < 0) {
    throw new HttpError(400, 'invalid upload size');
  }
  const size = raw.size as number;
  const contentLength = req.headers.get('content-length');
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength !== size) {
      throw new HttpError(400, 'content-length does not match the declared upload size');
    }
  }

  return {
    fields: {
      name: uploadString(raw.name, '', 500),
      size,
      owner: uploadString(raw.owner, 'guest', 120),
      title: uploadString(raw.title, '', 160),
      tags: uploadString(raw.tags, '', 2000),
      note: uploadString(raw.note, '', 500),
      album: uploadString(raw.album, 'Inbox', 80),
    },
    mime: (req.headers.get('content-type') || '').slice(0, 200),
    stream: req.body || emptyUploadStream(),
  };
}

async function incomingUpload(req: Request): Promise<IncomingUpload> {
  const streamed = streamUpload(req);
  if (streamed) return streamed;
  if (!(req.headers.get('content-type') || '').toLowerCase().startsWith('multipart/form-data')) {
    throw new HttpError(415, `expected a raw file body with ${UPLOAD_METADATA_HEADER} or multipart/form-data`);
  }

  const contentLength = Number(req.headers.get('content-length'));
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    throw new HttpError(411, 'content-length is required for legacy multipart uploads');
  }
  if (contentLength > LEGACY_MULTIPART_REQUEST_LIMIT) {
    throw new HttpError(413, 'legacy multipart upload limit is 25MiB; use the streaming upload API for larger videos');
  }

  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(400, 'file field is required');
  if (file.size > LEGACY_MULTIPART_FILE_LIMIT) {
    throw new HttpError(413, 'legacy multipart file limit is 25MiB; use the streaming upload API for larger videos');
  }
  return {
    fields: {
      name: file.name,
      size: file.size,
      owner: uploadString(form.get('owner'), 'guest', 120),
      title: uploadString(form.get('title'), '', 160),
      tags: uploadString(form.get('tags'), '', 2000),
      note: uploadString(form.get('note'), '', 500),
      album: uploadString(form.get('album'), 'Inbox', 80),
    },
    mime: file.type,
    stream: file.stream(),
  };
}

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors, ...(init.headers || {}) },
  });
}
function text(data: string, init: ResponseInit = {}) {
  return new Response(data, { ...init, headers: { 'content-type': 'text/plain; charset=utf-8', ...cors, ...(init.headers || {}) } });
}
function generateShareToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(SHARE_TOKEN_BYTES));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
    shareToken: x.shareToken,
    sharedAt: x.sharedAt,
    shareRenditionVersion: x.shareRenditionVersion,
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
  if (res.ok) return compactPhotoMeta(await res.json() as Photo);
  return photoFromIndexItem(item);
}
async function getAuthoritativePhotoMeta(env: Env, item: PhotoIndexItem): Promise<Photo | null> {
  const res = await d9(env, 'GET', metaPath(item.id));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`drive9 read ${metaPath(item.id)} failed: ${res.status} ${await res.text()}`);
  return compactPhotoMeta(await res.json() as Photo);
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
    shareToken: p.shareToken,
    sharedAt: p.sharedAt,
    shareRenditionVersion: p.shareRenditionVersion,
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
function photoForManagement(p: Photo, origin: string) {
  const { shareToken: _shareToken, sharedAt: _sharedAt, shareRenditionVersion: _shareRenditionVersion, ...photo } = p;
  return {
    ...photo,
    shared: !!p.shareToken,
    url: `${origin}/api/photos/${p.id}/file`,
  };
}
function photoForShare(p: Photo, origin: string, token: string) {
  return {
    title: p.title,
    tags: p.tags,
    mime: p.mime,
    size: p.size,
    mediaKind: inferMediaKind(p),
    aiCaptionEn: p.aiCaptionEn || '',
    aiCaptionZh: p.aiCaptionZh || '',
    aiTagsEn: p.aiTagsEn || [],
    aiTagsZh: p.aiTagsZh || [],
    url: `${origin}/api/shares/${token}/file`,
  };
}
async function findSharedPhoto(env: Env, token: string) {
  if (!SHARE_TOKEN_PATTERN.test(token)) return null;
  const items = await getIndexItems(env);
  const indexed = items.find((item) => item.shareToken === token && !item.archived);
  if (indexed) {
    const photo = await getAuthoritativePhotoMeta(env, indexed);
    return photo && photo.shareToken === token && !photo.archived ? photo : null;
  }
  return null;
}

function shareDisplayPath(photo: Photo) {
  return `${SHARE_RENDITION_ROOT}/${photo.id}.${inferMediaKind(photo) === 'video' ? 'mp4' : 'jpg'}`;
}

function sharePosterPath(photo: Photo) {
  return inferMediaKind(photo) === 'video'
    ? `${SHARE_RENDITION_ROOT}/${photo.id}.poster.jpg`
    : shareDisplayPath(photo);
}

async function drive9PhotoResponse(env: Env, photo: Photo) {
  let response: Response;
  try {
    response = await fetch(fsUrl(env, photo.objectKey), {
      headers: { authorization: `Bearer ${env.DRIVE9_API_KEY}` },
    });
  } catch {
    throw new ShareRenditionError('source_fetch', 'source media unavailable');
  }
  if (!response.ok || !response.body) {
    throw new ShareRenditionError('source_fetch', `source media unavailable (${response.status})`);
  }
  return response;
}

async function writeShareRendition(env: Env, path: string, mime: string, body: ReadableStream<Uint8Array> | null) {
  if (!body) throw new Error('transformation returned an empty body');
  let tail = new Uint8Array(0);
  const checkedBody = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const combined = new Uint8Array(tail.byteLength + chunk.byteLength);
      combined.set(tail);
      combined.set(chunk, tail.byteLength);
      for (const marker of SHARE_PRIVATE_METADATA_MARKERS) {
        let i = 0;
        while ((i = combined.indexOf(marker[0], i)) >= 0 && i <= combined.byteLength - marker.byteLength) {
          let matches = true;
          for (let j = 0; j < marker.byteLength; j++) {
            if (combined[i + j] !== marker[j]) {
              matches = false;
              break;
            }
          }
          if (matches) throw new ShareRenditionError('privacy_scan', 'transformation retained private metadata');
          i++;
        }
      }
      const tailLength = Math.min(SHARE_PRIVATE_METADATA_TAIL, combined.byteLength);
      tail = combined.slice(combined.byteLength - tailLength);
      controller.enqueue(chunk);
    },
  }));
  let response: Response;
  try {
    response = await d9(env, 'PUT', path, checkedBody, {
      'content-type': mime,
      'x-dat9-description': 'PhotoVault privacy-safe public share rendition',
    });
  } catch (error) {
    if (error instanceof ShareRenditionError) throw error;
    throw new ShareRenditionError('rendition_write', 'rendition write failed');
  }
  if (!response.ok) throw new ShareRenditionError('rendition_write', `rendition write failed (${response.status})`);
}

async function createImageShareRendition(env: Env, photo: Photo) {
  if (!env.IMAGES) throw new ShareRenditionError('images_binding', 'image transformation is unavailable');
  const source = await drive9PhotoResponse(env, photo);
  let response: Response;
  try {
    const metadataFreeResult = await env.IMAGES.input(source.body!)
      .transform({ width: 2000, height: 2000, fit: 'scale-down' })
      .output({ format: 'image/webp', quality: 86, anim: false });
    const metadataFreeResponse = metadataFreeResult.response();
    if (!metadataFreeResponse.ok || !metadataFreeResponse.body) {
      throw new Error(`metadata stripping failed (${metadataFreeResponse.status})`);
    }

    const jpegResult = await env.IMAGES.input(metadataFreeResponse.body)
      .output({ format: 'image/jpeg', quality: 86, anim: false });
    response = jpegResult.response();
  } catch {
    throw new ShareRenditionError('image_transform', 'image transformation failed');
  }
  if (!response.ok || !response.body) throw new ShareRenditionError('image_transform', `image transformation failed (${response.status})`);
  await writeShareRendition(env, shareDisplayPath(photo), 'image/jpeg', response.body);
}

async function createVideoShareRenditions(env: Env, photo: Photo) {
  if (!env.MEDIA) throw new ShareRenditionError('media_binding', 'media transformation is unavailable');

  const videoSource = await drive9PhotoResponse(env, photo);
  const video = await env.MEDIA.input(videoSource.body!)
    .transform({ width: 1920, height: 1080, fit: 'scale-down' })
    .output({ mode: 'video', audio: true })
    .response();
  if (!video.ok) throw new ShareRenditionError('video_transform', `video transformation failed (${video.status})`);
  await writeShareRendition(env, shareDisplayPath(photo), 'video/mp4', video.body);

  const posterSource = await drive9PhotoResponse(env, photo);
  const poster = await env.MEDIA.input(posterSource.body!)
    .transform({ width: 1600, height: 1200, fit: 'scale-down' })
    .output({ mode: 'frame', time: '0s', format: 'jpg' })
    .response();
  if (!poster.ok) throw new ShareRenditionError('video_poster_transform', `video poster transformation failed (${poster.status})`);
  await writeShareRendition(env, sharePosterPath(photo), 'image/jpeg', poster.body);
}

async function deleteShareRenditions(env: Env, photo: Photo) {
  const paths = [...new Set([shareDisplayPath(photo), sharePosterPath(photo)])];
  await Promise.allSettled(paths.map((path) => d9(env, 'DELETE', path)));
}

async function createShareRenditions(env: Env, photo: Photo) {
  if (inferMediaKind(photo) === 'image' && photo.size > IMAGE_SHARE_SIZE_LIMIT) {
    throw new HttpError(422, 'This image is too large to share safely. Maximum shareable image size is 20 MB.');
  }
  try {
    if (inferMediaKind(photo) === 'video') await createVideoShareRenditions(env, photo);
    else await createImageShareRendition(env, photo);
  } catch (error) {
    const stage = error instanceof ShareRenditionError ? error.stage : 'unknown';
    console.error('share rendition failed', {
      photoId: photo.id,
      mediaKind: inferMediaKind(photo),
      stage,
      reason: error instanceof Error ? error.message : 'unknown error',
    });
    await deleteShareRenditions(env, photo);
    const code = error instanceof ShareRenditionError
      ? `share_rendition_${error.stage}`
      : 'share_rendition_unavailable';
    throw new HttpError(502, 'could not prepare a privacy-safe share rendition', code);
  }
}

async function ensurePublicShareRendition(env: Env, photo: Photo) {
  if (photo.shareRenditionVersion === SHARE_RENDITION_VERSION) return;
  await createShareRenditions(env, photo);
  photo.shareRenditionVersion = SHARE_RENDITION_VERSION;
  try {
    await setPhotoMeta(env, photo);
  } catch (error) {
    await deleteShareRenditions(env, photo);
    throw error;
  }
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

async function proxyPhotoFile(req: Request, env: Env, photo: Photo, cacheControl: string, includeUpstreamDetail = false) {
  const rangeHeader = req.headers.get('range');
  const headers: HeadersInit = { authorization: `Bearer ${env.DRIVE9_API_KEY}` };
  if (rangeHeader) headers['range'] = rangeHeader;
  const obj = await fetch(fsUrl(env, photo.objectKey), { method: 'GET', headers });
  if (obj.status === 416) {
    const respHeaders: Record<string, string> = { ...cors, 'cache-control': cacheControl };
    const contentRange = obj.headers.get('content-range');
    if (contentRange) respHeaders['content-range'] = contentRange;
    return new Response(obj.body, { status: 416, headers: respHeaders });
  }
  if (!obj.ok && obj.status !== 206) {
    const error: Record<string, unknown> = { error: 'drive9 read failed', status: obj.status };
    if (includeUpstreamDetail) error.detail = await obj.text();
    return json(error, { status: 502 });
  }
  const respHeaders: Record<string, string> = { ...cors, 'content-type': photo.mime, 'cache-control': cacheControl };
  const contentLength = obj.headers.get('content-length');
  if (contentLength) respHeaders['content-length'] = contentLength;
  const acceptRanges = obj.headers.get('accept-ranges');
  if (acceptRanges) respHeaders['accept-ranges'] = acceptRanges;
  if (obj.status === 206) {
    const contentRange = obj.headers.get('content-range');
    if (contentRange) respHeaders['content-range'] = contentRange;
    respHeaders['accept-ranges'] = 'bytes';
    return new Response(obj.body, { status: 206, headers: respHeaders });
  }
  return new Response(obj.body, { headers: respHeaders });
}


async function refreshDrive9Semantics(env: Env, photos: Photo[], limit = 20) {
  let changed = false;
  let checked = 0;
  for (const p of photos) {
    if (checked >= limit) break;
    // 'unavailable' (drive9 finished, no usable content) and 'drive9' (drive9
    // finished and returned content) are both terminal — don't re-poll them
    // forever just because there is no caption text. A 'drive9' result may be
    // tags-only (aiTextEn/Zh empty), so gating solely on aiText would re-poll a
    // finished image endlessly.
    const needs =
      p.analysisStatus !== 'unavailable' &&
      p.analysisStatus !== 'drive9' &&
      ((!p.aiTextEn && !p.aiTextZh) || p.analysisStatus === 'pending');
    if (!needs || p.archived) continue;
    checked++;
    const analysis = await getDrive9Semantic(env, p.objectKey, p.tags);
    // Persist whenever Drive9 produced ANY usable content — a result may carry
    // real Drive9 tags (from drive9.image.tag.*) with no caption/description
    // text. Gating on caption text alone (analysis.text.*) would drop those
    // tags-only results on the floor and leave the image stuck 'pending' even
    // though Drive9 finished and returned tags. `buildDrive9SemanticResult`
    // already returns null unless some Drive9-derived field was recovered, so a
    // 'drive9' status means there is at least one field worth persisting.
    if (analysis.status === 'drive9') {
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
    } else if (analysis.status === 'unavailable') {
      // Drive9 finished but produced no usable semantic content. Record the
      // terminal 'unavailable' state so the image stops showing as pending and
      // isn't re-polled forever. Clear the placeholder "still analyzing…" caption
      // written at upload, otherwise the UI (which renders any caption once the
      // status is non-pending) would show both "analysis unavailable" AND the
      // stale analyzing summary.
      if (p.analysisStatus !== 'unavailable') {
        p.analysisStatus = 'unavailable';
        p.aiCaptionEn = '';
        p.aiCaptionZh = '';
        p.updatedAt = new Date().toISOString();
        changed = true;
      }
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

async function searchDrive9(env: Env, query: string, limit = 100) {
  const params = new URLSearchParams({ grep: query, limit: String(limit) });
  const res = await d9(env, 'GET', `${ROOT}/photos/`, null, {}, `?${params}`);
  if (!res.ok) throw new Error(`drive9 search failed: ${res.status}`);
  const body = await res.json() as unknown;
  if (body === null) return [];
  if (!Array.isArray(body)) throw new Error('drive9 search returned an invalid response');
  return body.filter((result): result is Drive9SearchResult => (
    typeof result === 'object' &&
    result !== null &&
    typeof (result as Drive9SearchResult).path === 'string'
  ));
}


async function getDrive9Semantic(env: Env, path: string, existingTags: string[]) {
  const res = await d9(env, 'GET', path, null, {}, '?stat=1');
  if (res.ok) {
    const meta = await res.json() as any;
    const analysis = buildDrive9SemanticResult(meta, existingTags);
    if (analysis) return analysis;
    // Drive9 responded, but no usable semantic content could be recovered. If
    // drive9 nonetheless produced NON-EMPTY semantic_text (i.e. it DID run and
    // emitted content that was truncated so badly not even one field survived),
    // the analysis is finished-but-unusable. Reporting 'pending' here would leave
    // the image "analyzing…" forever; report 'unavailable' so the UI shows a
    // clear terminal state. An EMPTY semantic_text means analysis has not run yet
    // (drive9 always serializes the field) — that stays 'pending'.
    if (drive9SemanticContentPresent(meta)) {
      return {
        caption: { zh: '', en: '' },
        text: { zh: '', en: '' },
        tags: { zh: [] as string[], en: [] as string[] },
        status: 'unavailable',
      };
    }
  }
  return {
    caption: { zh: '', en: 'Uploaded file. drive9 is still analyzing it; search metadata may appear shortly.' },
    text: { zh: '', en: '' },
    tags: { zh: [] as string[], en: [] as string[] },
    status: 'pending',
  };
}

// True when drive9's metadata carries NON-EMPTY semantic content — meaning
// analysis actually produced output (even if that output is truncated/unparseable
// so nothing usable survived). drive9's stat response always serializes a
// `semantic_text` field (empty string for objects that have not been analyzed
// yet), so the mere presence of the key does NOT mean analysis finished — only a
// non-empty value does. Using presence would wrongly flip freshly-uploaded,
// still-pending images to a terminal 'unavailable'.
export function drive9SemanticContentPresent(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object') return false;
  const value = (meta as Record<string, unknown>).semantic_text;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some((v) => typeof v === 'string' && v.trim().length > 0);
  // An object-shaped semantic_text with any keys also counts as produced content.
  return !!value && typeof value === 'object' && Object.keys(value as object).length > 0;
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
        post: {
          summary: 'Stream a photo or video into drive9 with metadata',
          description: `Send the file as the raw request body. ${UPLOAD_METADATA_HEADER} is encodeURIComponent(JSON) with name, size, title, tags, note, album, and owner. Videos support exactly 40,000,000 bytes; images support 25MiB. Legacy multipart/form-data remains compatible up to 25MiB.`,
          parameters: [{ name: UPLOAD_METADATA_HEADER, in: 'header', required: false, schema: { type: 'string' } }],
          requestBody: { content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } }, 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, title: { type: 'string' }, tags: { type: 'string' }, note: { type: 'string' }, album: { type: 'string' }, owner: { type: 'string' } }, required: ['file'] } } } },
          responses: { '201': { description: 'Created media item' }, '413': { description: 'Media exceeds its size limit' } },
        }
      },
      '/api/photos/{id}': { patch: { summary: 'Update metadata/state' }, delete: { summary: 'Delete photo from drive9' } },
      '/api/photos/{id}/share': {
        post: { summary: 'Create or return the current public read-only share link for one media item' },
        delete: { summary: 'Revoke the current share link for one media item' },
      },
      '/api/photos/{id}/file': { get: { summary: 'Stream original media bytes from drive9 (supports Range for video)' } },
      '/api/shares/{token}': { get: { summary: 'Read metadata for one publicly shared media item' } },
      '/api/shares/{token}/file': { get: { summary: 'Stream a metadata-stripped public display rendition using an unguessable token' } },
      '/api/shares/{token}/poster': { get: { summary: 'Read a metadata-stripped JPEG social preview using an unguessable token' } },
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
    const sharedFileMatch = path.match(/^\/api\/shares\/([^/]+)\/file$/);
    if (sharedFileMatch && req.method === 'GET') {
      const token = sharedFileMatch[1];
      const photo = await findSharedPhoto(env, token);
      if (!photo) return json({ error: 'share not found' }, { status: 404 });
      await ensurePublicShareRendition(env, photo);
      return proxyPhotoFile(req, env, {
        ...photo,
        objectKey: shareDisplayPath(photo),
        mime: inferMediaKind(photo) === 'video' ? 'video/mp4' : 'image/jpeg',
      }, 'private, no-store');
    }
    const sharedPosterMatch = path.match(/^\/api\/shares\/([^/]+)\/poster$/);
    if (sharedPosterMatch && req.method === 'GET') {
      const token = sharedPosterMatch[1];
      const photo = await findSharedPhoto(env, token);
      if (!photo) return json({ error: 'share not found' }, { status: 404 });
      await ensurePublicShareRendition(env, photo);
      return proxyPhotoFile(req, env, {
        ...photo,
        objectKey: sharePosterPath(photo),
        mime: 'image/jpeg',
      }, 'private, no-store');
    }
    const sharedMatch = path.match(/^\/api\/shares\/([^/]+)$/);
    if (sharedMatch && req.method === 'GET') {
      const token = sharedMatch[1];
      const photo = await findSharedPhoto(env, token);
      if (!photo) return json({ error: 'share not found' }, { status: 404 });
      await ensurePublicShareRendition(env, photo);
      return json({ photo: photoForShare(photo, url.origin, token), storage: 'drive9' });
    }
    if (path === '/api/photos' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      const tag = (url.searchParams.get('tag') || '').toLowerCase();
      const owner = url.searchParams.get('owner') || '';
      const favorite = url.searchParams.get('favorite');
      const photos = (await refreshDrive9Semantics(env, await getAllPhotos(env))).filter((p) => !p.archived);
      const photosByPath = new Map(photos.map((photo) => [photo.objectKey, photo]));
      const ranked = q
        ? (await searchDrive9(env, q)).flatMap((result, index) => {
            const photo = photosByPath.get(result.path);
            return photo ? [{
              photo,
              score: typeof result.score === 'number' ? result.score : 1 / (index + 1),
            }] : [];
          })
        : photos.map((photo) => ({ photo, score: 1 }));
      const matchingMetadata = ranked.filter(({ photo }) => (
        (!tag || photo.tags.map((t) => t.toLowerCase()).includes(tag)) &&
        (!owner || photo.owner === owner) &&
        (favorite === null || String(photo.favorite) === favorite)
      ));
      const ordered = q
        ? rerankPhotoCandidates(matchingMetadata, q)
        : matchingMetadata.sort((a, b) => b.score - a.score || +new Date(b.photo.createdAt) - +new Date(a.photo.createdAt));
      const filtered = ordered
        .map(({ photo, score }) => ({ ...photoForManagement(photo, url.origin), score }));
      return json({ photos: filtered, count: filtered.length, storage: 'drive9' });
    }
    if (path === '/api/photos' && req.method === 'POST') {
      const upload = await incomingUpload(req);
      const { fields } = upload;
      const kind = mediaKindFromMime(upload.mime, fields.name);
      if (!kind) return json({ error: `unsupported file type: ${upload.mime || '(empty)'}. Accepted: image/*, video/mp4, video/quicktime, video/webm, video/x-msvideo, video/x-matroska` }, { status: 400 });
      const resolvedMime = kind === 'video'
        ? (effectiveVideoMime(upload.mime, fields.name) || upload.mime)
        : upload.mime.split(';')[0].trim().toLowerCase();
      const sizeLimit = kind === 'video' ? VIDEO_SIZE_LIMIT : IMAGE_SIZE_LIMIT;
      if (fields.size > sizeLimit) {
        const limit = kind === 'video' ? '40MB' : '25MiB';
        return json({ error: `upload limit: ${limit} per ${kind}` }, { status: 413 });
      }
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const objectKey = `${ROOT}/photos/${id}.${extFor(resolvedMime)}`;
      const tags = fields.tags.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20);
      const defaultTitle = fields.name.replace(/\.[^.]+$/, '') || (kind === 'video' ? 'Untitled video' : 'Untitled photo');
      const pendingCaption = kind === 'video'
        ? 'Uploaded video. drive9 is analyzing it; this may take a while.'
        : 'Uploaded image. drive9 is still analyzing it; search metadata may appear shortly.';
      const description = [fields.title || fields.name, fields.note, fields.album, tags.join(' ')].filter(Boolean).join(' — ');
      let objectUploaded = false;
      try {
        const { checksum } = await drive9UploadStream(env, objectKey, upload.stream, fields.size, resolvedMime, description, { app: 'photovault', album: fields.album });
        objectUploaded = true;
        const photo: Photo = {
          id,
          owner: fields.owner,
          title: fields.title || defaultTitle,
          note: fields.note,
          tags,
          album: fields.album,
          mime: resolvedMime,
          size: fields.size,
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
        const photos = await getIndexItems(env);
        const dupes = photos.filter((candidate) => candidate.checksum === checksum).map((candidate) => candidate.id);
        await setPhotoMeta(env, photo);
        await setIndex(env, [photo, ...photos]);
        return json({ photo: { ...photoForManagement(photo, url.origin), duplicateOf: dupes }, duplicateOf: dupes, storage: 'drive9' }, { status: 201 });
      } catch (error) {
        if (objectUploaded) {
          await Promise.allSettled([
            d9(env, 'DELETE', objectKey),
            deletePhotoMeta(env, id),
          ]);
        }
        throw error;
      }
    }
    const fileMatch = path.match(/^\/api\/photos\/([^/]+)\/file$/);
    if (fileMatch && req.method === 'GET') {
      const id = fileMatch[1];
      const photo = (await getAllPhotos(env)).find((p) => p.id === id && !p.archived);
      if (!photo) return json({ error: 'photo not found' }, { status: 404 });
      return proxyPhotoFile(req, env, photo, 'public, max-age=31536000, immutable', true);
    }
    const shareActionMatch = path.match(/^\/api\/photos\/([^/]+)\/share$/);
    if (shareActionMatch && req.method === 'POST') {
      const id = shareActionMatch[1];
      const items = await getIndexItems(env);
      const item = items.find((candidate) => candidate.id === id && !candidate.archived);
      const photo = item ? await getPhotoMeta(env, item) : null;
      if (!photo) return json({ error: 'photo not found' }, { status: 404 });
      const needsRendition = photo.shareRenditionVersion !== SHARE_RENDITION_VERSION;
      if (needsRendition) await createShareRenditions(env, photo);
      if (!photo.shareToken) {
        const usedTokens = new Set(items.map((candidate) => candidate.shareToken).filter(Boolean));
        let token = generateShareToken();
        while (usedTokens.has(token)) token = generateShareToken();
        photo.shareToken = token;
        photo.sharedAt = new Date().toISOString();
        photo.updatedAt = photo.sharedAt;
      }
      photo.shareRenditionVersion = SHARE_RENDITION_VERSION;
      try {
        await setPhotoMeta(env, photo);
        await setIndex(env, items.map((candidate) => candidate.id === photo.id ? photo : candidate));
      } catch (error) {
        if (needsRendition) await deleteShareRenditions(env, photo);
        throw error;
      }
      return json({
        share: {
          token: photo.shareToken,
          url: `${url.origin}/api/shares/${photo.shareToken}`,
          sharedAt: photo.sharedAt,
        },
        storage: 'drive9',
      });
    }
    if (shareActionMatch && req.method === 'DELETE') {
      const id = shareActionMatch[1];
      const items = await getIndexItems(env);
      const item = items.find((candidate) => candidate.id === id);
      const photo = item ? await getPhotoMeta(env, item) : null;
      if (!photo) return json({ error: 'photo not found' }, { status: 404 });
      if (photo.shareToken) {
        photo.shareToken = undefined;
        photo.sharedAt = undefined;
        photo.shareRenditionVersion = undefined;
        photo.updatedAt = new Date().toISOString();
        await setPhotoMeta(env, photo);
        await setIndex(env, items.map((candidate) => candidate.id === photo.id ? photo : candidate));
        await deleteShareRenditions(env, photo);
      }
      return new Response(null, { status: 204, headers: cors });
    }
    const photoMatch = path.match(/^\/api\/photos\/([^/]+)$/);
    if (photoMatch && req.method === 'PATCH') {
      const id = photoMatch[1];
      const patch = await req.json().catch(() => ({})) as any;
      const photos = await getAllPhotos(env);
      const i = photos.findIndex((p) => p.id === id);
      if (i < 0) return json({ error: 'photo not found' }, { status: 404 });
      const prev = photos[i];
      const next: Photo = { ...prev,
        title: typeof patch.title === 'string' ? patch.title : prev.title,
        note: typeof patch.note === 'string' ? patch.note : prev.note,
        album: typeof patch.album === 'string' ? patch.album : prev.album,
        tags: Array.isArray(patch.tags) ? [...new Set<string>(patch.tags.map(String).map((x: string) => x.trim()).filter(Boolean))].slice(0, 24) : prev.tags,
        aiTagsEn: Array.isArray(patch.tags) ? [...new Set<string>(patch.tags.map(String).map((x: string) => x.trim()).filter(Boolean))].slice(0, 24) : prev.aiTagsEn,
        aiTagsZh: Array.isArray(patch.tags) ? [] : prev.aiTagsZh,
        favorite: typeof patch.favorite === 'boolean' ? patch.favorite : prev.favorite,
        archived: typeof patch.archived === 'boolean' ? patch.archived : prev.archived,
        updatedAt: new Date().toISOString(),
      };
      if (next.archived && !prev.archived) {
        next.shareToken = undefined;
        next.sharedAt = undefined;
        next.shareRenditionVersion = undefined;
      }
      photos[i] = next;
      await setPhotoMeta(env, next);
      await setIndex(env, photos);
      if (next.archived && !prev.archived) await deleteShareRenditions(env, prev);
      return json({ photo: photoForManagement(next, url.origin), storage: 'drive9' });
    }
    if (photoMatch && req.method === 'DELETE') {
      const id = photoMatch[1];
      const photos = await getAllPhotos(env);
      const found = photos.find((p) => p.id === id);
      if (found) await d9(env, 'DELETE', found.objectKey);
      await deletePhotoMeta(env, id);
      await setIndex(env, photos.filter((p) => p.id !== id));
      if (found) await deleteShareRenditions(env, found);
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
    if (path.startsWith('/api/shares/')) {
      if (!(e instanceof HttpError)) console.warn('public share request failed', e);
      return json({
        error: e instanceof HttpError ? e.message : 'share temporarily unavailable',
        ...(e instanceof HttpError && e.code ? { code: e.code } : {}),
        storage: 'drive9',
      }, { status: e instanceof HttpError ? e.status : 503 });
    }
    const status = e instanceof HttpError ? e.status : e instanceof UploadBodySizeError ? 400 : 500;
    return json({
      error: e?.message || String(e),
      ...(e instanceof HttpError && e.code ? { code: e.code } : {}),
      storage: 'drive9',
    }, { status });
  }
}
function safeJson(s: string) { try { return JSON.parse(s); } catch { return s.slice(0, 500); } }
export { effectiveVideoMime, mediaKindFromMime, inferMediaKind, VIDEO_SIZE_LIMIT, IMAGE_SIZE_LIMIT, IMAGE_SHARE_SIZE_LIMIT, UPLOAD_METADATA_HEADER };
export default { fetch: handle };
