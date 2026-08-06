const SHARE_PATH = /^\/(?:s|share)\/([A-Za-z0-9_-]{32})\/?$/;

export const PUBLIC_SHARE_POLL_INTERVAL_MS = 3000;
export const PUBLIC_SHARE_MAX_WAIT_MS = 20 * 60 * 1000;

function publicShareRetryAfterMs(response) {
  const retryAfterSeconds = Number(response.headers.get('retry-after'));
  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) return PUBLIC_SHARE_POLL_INTERVAL_MS;
  return Math.min(retryAfterSeconds * 1000, 30_000);
}

export function shareTokenFromPath(pathname) {
  return SHARE_PATH.exec(pathname || '')?.[1] || null;
}

export function isSharePath(pathname) {
  return /^\/(?:s|share)(?:\/|$)/.test(pathname || '');
}

export function sharePageUrl(origin, token) {
  return `${String(origin).replace(/\/$/, '')}/s/${token}`;
}

export async function readShareResponse(response) {
  const raw = await response.text();
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(payload?.error || `Share is unavailable (HTTP ${response.status}).`);
  }
  if (!payload?.share?.token) {
    throw new Error(`Share response was not valid (HTTP ${response.status}).`);
  }
  return payload;
}

export async function readPublicShareResponse(response) {
  const raw = await response.text();
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }
  if (response.status === 425) {
    return { status: 'preparing', photo: null, retryAfterMs: publicShareRetryAfterMs(response) };
  }
  if (!response.ok) {
    const error = new Error(payload?.error || `Share is unavailable (HTTP ${response.status}).`);
    error.status = response.status;
    error.code = payload?.code;
    throw error;
  }
  if (!payload?.photo) {
    throw new Error(`Share response was not valid (HTTP ${response.status}).`);
  }
  return { status: 'ready', photo: payload.photo, retryAfterMs: 0 };
}
