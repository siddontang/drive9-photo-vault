import test from 'node:test';
import assert from 'node:assert/strict';

import { facebookShareUrl, openSharePopup, xShareUrl } from './shareTargets.js';

const share = 'https://photos.example/s/AbCdEf0123456789_-AbCdEf01234567';

test('xShareUrl encodes the title and the complete share URL', () => {
  const url = new URL(xShareUrl(share, 'Beach & friends'));
  assert.equal(url.origin + url.pathname, 'https://twitter.com/intent/tweet');
  assert.equal(url.searchParams.get('url'), share);
  assert.equal(url.searchParams.get('text'), 'Beach & friends');
});

test('facebookShareUrl encodes only the canonical share URL', () => {
  const url = new URL(facebookShareUrl(share));
  assert.equal(url.origin + url.pathname, 'https://www.facebook.com/sharer/sharer.php');
  assert.equal(url.searchParams.get('u'), share);
  assert.equal([...url.searchParams.keys()].length, 1);
});

test('openSharePopup isolates the opener and uses a bounded popup', () => {
  const popup = { opener: 'caller' };
  const calls = [];
  const result = openSharePopup('https://example.com/share', (...args) => {
    calls.push(args);
    return popup;
  });

  assert.equal(result, popup);
  assert.equal(popup.opener, null);
  assert.deepEqual(calls, [[
    'https://example.com/share',
    '_blank',
    'noopener,noreferrer,width=720,height=640',
  ]]);
});
