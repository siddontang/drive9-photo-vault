const SHARE_PATH = /^\/share\/([A-Za-z0-9_-]{32})\/?$/;

export function shareTokenFromPath(pathname) {
  return SHARE_PATH.exec(pathname || '')?.[1] || null;
}

export function isSharePath(pathname) {
  return /^\/share(?:\/|$)/.test(pathname || '');
}

export function sharePageUrl(origin, token) {
  return `${String(origin).replace(/\/$/, '')}/share/${token}`;
}
