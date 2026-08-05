import test from 'node:test';
import assert from 'node:assert/strict';

import { injectShareMeta, shareMetaTags, shareToken } from '../netlify/lib/share-meta-core.mjs';
import shareMeta from '../netlify/edge-functions/share-meta.mjs';

const token = 'AbCdEf0123456789_-AbCdEf01234567';

test('shareToken accepts only one exact public token segment', () => {
  assert.equal(shareToken(`/s/${token}`), token);
  assert.equal(shareToken(`/share/${token}/`), token);
  assert.equal(shareToken(`/s/${token}/extra`), null);
  assert.equal(shareToken('/s/not-a-token'), null);
});

test('shareMetaTags emits escaped social metadata with only the safe poster URL', () => {
  const tags = shareMetaTags({
    photo: {
      title: 'Beach <sunset> & "friends"',
      aiCaptionEn: 'A calm evening by the sea.',
      owner: 'must-not-leak',
      objectKey: '/private/original.jpg',
      checksum: 'secret-checksum',
    },
    pageUrl: `https://photos.example/s/${token}`,
    posterUrl: `https://photos.example/api/shares/${token}/poster`,
  });

  assert.match(tags, /twitter:card" content="summary_large_image/);
  assert.match(tags, /og:image" content="https:\/\/photos\.example\/api\/shares\/.+\/poster/);
  assert.match(tags, /Beach &lt;sunset&gt; &amp; &quot;friends&quot;/);
  assert.doesNotMatch(tags, /must-not-leak|private\/original|secret-checksum/);
});

test('injectShareMeta adds tags inside the document head', () => {
  assert.equal(
    injectShareMeta('<html><head><meta charset="utf-8"></head><body></body></html>', '<meta property="og:title" content="Photo">'),
    '<html><head><meta charset="utf-8"><meta property="og:title" content="Photo">\n</head><body></body></html>',
  );
});

test('shareMeta injects a safe social card and privacy headers', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (request) => {
    assert.equal(String(request), `https://photos.example/api/shares/${token}`);
    return new Response(JSON.stringify({ photo: {
      title: 'Shared sunset',
      aiCaptionEn: 'A quiet evening.',
      objectKey: '/private/original.heic',
    } }), { headers: { 'content-type': 'application/json' } });
  };

  try {
    const response = await shareMeta(
      new Request(`https://photos.example/s/${token}?source=message`),
      { next: async () => new Response('<html><head></head><body>app</body></html>', { headers: { 'content-type': 'text/html' } }) },
    );
    const html = await response.text();
    assert.match(html, new RegExp(`/api/shares/${token}/poster`));
    assert.match(html, new RegExp(`og:url" content="https://photos.example/s/${token}`));
    assert.doesNotMatch(html, /source=message|private\/original/);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, noarchive');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
