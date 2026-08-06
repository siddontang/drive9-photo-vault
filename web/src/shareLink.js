const SHARE_PATH = /^\/(?:s|share)\/([A-Za-z0-9_-]{32})\/?$/;

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
