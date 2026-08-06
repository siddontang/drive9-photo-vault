import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSharePath,
  PUBLIC_SHARE_MAX_WAIT_MS,
  PUBLIC_SHARE_POLL_INTERVAL_MS,
  readPublicShareResponse,
  readShareResponse,
  sharePageUrl,
  shareTokenFromPath,
} from './shareLink.js';

const token = 'AbCdEf0123456789_-AbCdEf01234567';

test('shareTokenFromPath accepts short and legacy paths with one exact 32-character token segment', () => {
  assert.equal(shareTokenFromPath(`/s/${token}`), token);
  assert.equal(shareTokenFromPath(`/s/${token}/`), token);
  assert.equal(shareTokenFromPath(`/share/${token}`), token);
  assert.equal(shareTokenFromPath(`/share/${token}/`), token);
  assert.equal(shareTokenFromPath(`/s/${token}/extra`), null);
  assert.equal(shareTokenFromPath(`/share/${token}/extra`), null);
  assert.equal(shareTokenFromPath('/s/not-a-token'), null);
  assert.equal(shareTokenFromPath('/share/not-a-token'), null);
  assert.equal(shareTokenFromPath(`/api/shares/${token}`), null);
});

test('sharePageUrl builds the compact public browser URL without duplicate slashes', () => {
  assert.equal(sharePageUrl('https://photos.example/', token), `https://photos.example/s/${token}`);
});

test('isSharePath keeps malformed share URLs on the isolated share page', () => {
  assert.equal(isSharePath(`/s/${token}`), true);
  assert.equal(isSharePath('/s/not-a-token'), true);
  assert.equal(isSharePath('/s'), true);
  assert.equal(isSharePath(`/share/${token}`), true);
  assert.equal(isSharePath('/share/not-a-token'), true);
  assert.equal(isSharePath('/share'), true);
  assert.equal(isSharePath('/api/shares/not-a-token'), false);
  assert.equal(isSharePath('/'), false);
});

test('readShareResponse exposes the API share-size error without JSON wrapper noise', async () => {
  const response = new Response(JSON.stringify({
    error: 'This image is too large to share safely. Maximum shareable image size is 20 MB.',
    storage: 'drive9',
  }), { status: 422, headers: { 'content-type': 'application/json' } });

  await assert.rejects(
    readShareResponse(response),
    { message: 'This image is too large to share safely. Maximum shareable image size is 20 MB.' },
  );
});

test('readShareResponse returns a successful share payload', async () => {
  const payload = { share: { token } };
  const response = new Response(JSON.stringify(payload), { status: 200 });
  assert.deepEqual(await readShareResponse(response), payload);
});

test('readShareResponse reports the HTTP status for an empty error response', async () => {
  const response = new Response(null, { status: 500 });

  await assert.rejects(
    readShareResponse(response),
    { message: 'Share is unavailable (HTTP 500).' },
  );
});

test('readShareResponse rejects an empty successful response as invalid', async () => {
  const response = new Response(null, { status: 200 });

  await assert.rejects(
    readShareResponse(response),
    { message: 'Share response was not valid (HTTP 200).' },
  );
});

test('readShareResponse reports the HTTP status for a non-JSON gateway response', async () => {
  const response = new Response('<html>bad gateway</html>', { status: 502 });

  await assert.rejects(
    readShareResponse(response),
    { message: 'Share is unavailable (HTTP 502).' },
  );
});

test('readPublicShareResponse classifies 425 as a retryable preparation state', async () => {
  const response = new Response(JSON.stringify({
    error: 'Share rendition is still preparing.',
    code: 'share_rendition_preparing',
  }), { status: 425, headers: { 'retry-after': '3' } });

  assert.deepEqual(await readPublicShareResponse(response), { status: 'preparing', photo: null, retryAfterMs: 3000 });
});

test('public share preparation polling has a finite twenty-minute ceiling and bounded retry hint', async () => {
  assert.equal(PUBLIC_SHARE_POLL_INTERVAL_MS, 3000);
  assert.equal(PUBLIC_SHARE_MAX_WAIT_MS, 20 * 60 * 1000);
  const response = new Response('', { status: 425, headers: { 'retry-after': '999999' } });
  assert.equal((await readPublicShareResponse(response)).retryAfterMs, 30_000);
});

test('readPublicShareResponse returns ready metadata and rejects terminal failures', async () => {
  const photo = { title: 'Ready clip', mediaKind: 'video' };
  assert.deepEqual(
    await readPublicShareResponse(new Response(JSON.stringify({ photo }), { status: 200 })),
    { status: 'ready', photo, retryAfterMs: 0 },
  );
  await assert.rejects(
    readPublicShareResponse(new Response(JSON.stringify({ error: 'Share rendition is unavailable.' }), { status: 503 })),
    { message: 'Share rendition is unavailable.', status: 503 },
  );
});
