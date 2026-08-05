const TOKEN_PATH = /^\/(?:s|share)\/([A-Za-z0-9_-]{32})\/?$/;

export function shareToken(pathname) {
  return TOKEN_PATH.exec(pathname || '')?.[1] || null;
}

function escapeAttribute(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function descriptionFor(photo) {
  return (photo.aiCaptionEn || photo.aiCaptionZh || 'A private moment shared from PhotoVault.')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

export function shareMetaTags({ photo, pageUrl, posterUrl }) {
  const title = escapeAttribute(photo.title || 'PhotoVault');
  const description = escapeAttribute(descriptionFor(photo));
  const page = escapeAttribute(pageUrl);
  const poster = escapeAttribute(posterUrl);
  return [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="PhotoVault">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:url" content="${page}">`,
    `<meta property="og:image" content="${poster}">`,
    `<meta property="og:image:type" content="image/jpeg">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${description}">`,
    `<meta name="twitter:image" content="${poster}">`,
    `<title>${title} · PhotoVault</title>`,
  ].join('\n');
}

export function injectShareMeta(html, tags) {
  return html.includes('</head>') ? html.replace('</head>', `${tags}\n</head>`) : html;
}
