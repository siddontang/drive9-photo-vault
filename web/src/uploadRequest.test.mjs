import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStreamUploadRequest, UPLOAD_METADATA_HEADER } from './uploadRequest.js';

test('buildStreamUploadRequest sends the File directly with encoded metadata', async () => {
  const file = new File([new Uint8Array([1, 2, 3])], '旅行 片段.mp4', { type: 'video/mp4' });
  const request = buildStreamUploadRequest(file, {
    owner: 'guest-1',
    title: '旅行片段',
    tags: 'travel, 海边',
    note: '原始视频',
    album: 'Inbox',
  });

  assert.equal(request.method, 'POST');
  assert.equal(request.body, file);
  assert.equal(request.body instanceof FormData, false);
  assert.equal(request.headers['content-type'], 'video/mp4');
  assert.deepEqual(JSON.parse(decodeURIComponent(request.headers[UPLOAD_METADATA_HEADER])), {
    name: '旅行 片段.mp4',
    size: 3,
    owner: 'guest-1',
    title: '旅行片段',
    tags: 'travel, 海边',
    note: '原始视频',
    album: 'Inbox',
  });
});

test('buildStreamUploadRequest uses an octet-stream fallback without buffering', () => {
  const file = new File([new Uint8Array(0)], 'clip.mov');
  const request = buildStreamUploadRequest(file);

  assert.equal(request.body, file);
  assert.equal(request.headers['content-type'], 'application/octet-stream');
});
