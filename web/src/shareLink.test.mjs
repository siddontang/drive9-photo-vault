import test from 'node:test';
import assert from 'node:assert/strict';
import { isSharePath, readShareResponse, sharePageUrl, shareTokenFromPath } from './shareLink.js';

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
