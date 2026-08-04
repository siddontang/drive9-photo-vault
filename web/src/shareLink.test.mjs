import test from 'node:test';
import assert from 'node:assert/strict';
import { isSharePath, sharePageUrl, shareTokenFromPath } from './shareLink.js';

const token = 'AbCdEf0123456789_-AbCdEf01234567';

test('shareTokenFromPath accepts only one exact 32-character token segment', () => {
  assert.equal(shareTokenFromPath(`/share/${token}`), token);
  assert.equal(shareTokenFromPath(`/share/${token}/`), token);
  assert.equal(shareTokenFromPath(`/share/${token}/extra`), null);
  assert.equal(shareTokenFromPath('/share/not-a-token'), null);
  assert.equal(shareTokenFromPath(`/api/shares/${token}`), null);
});

test('sharePageUrl builds the public browser URL without duplicate slashes', () => {
  assert.equal(sharePageUrl('https://photos.example/', token), `https://photos.example/share/${token}`);
});

test('isSharePath keeps malformed share URLs on the isolated share page', () => {
  assert.equal(isSharePath(`/share/${token}`), true);
  assert.equal(isSharePath('/share/not-a-token'), true);
  assert.equal(isSharePath('/share'), true);
  assert.equal(isSharePath('/api/shares/not-a-token'), false);
  assert.equal(isSharePath('/'), false);
});
