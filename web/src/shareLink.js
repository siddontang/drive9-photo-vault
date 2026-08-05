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
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error || 'Share is unavailable.');
  return payload;
}
