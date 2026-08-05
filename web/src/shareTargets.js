export function xShareUrl(url, title = '') {
  const params = new URLSearchParams({ url: String(url), text: String(title) });
  return `https://twitter.com/intent/tweet?${params}`;
}

export function facebookShareUrl(url) {
  const params = new URLSearchParams({ u: String(url) });
  return `https://www.facebook.com/sharer/sharer.php?${params}`;
}

export function openSharePopup(url, open = window.open) {
  const popup = open(url, '_blank', 'noopener,noreferrer,width=720,height=640');
  if (popup) popup.opener = null;
  return popup;
}
