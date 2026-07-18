import test from 'node:test';
import assert from 'node:assert/strict';

import { fmtBytes, fmtDate, pickLangField, pickLangTags } from './i18n.js';

test('fmtBytes formats bytes / KB / MB with sensible thresholds', () => {
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(512), '512 B');
  assert.equal(fmtBytes(2048), '2 KB');
  assert.equal(fmtBytes(2 * 1024 * 1024), '2.0 MB');
});

test('fmtBytes treats undefined as 0', () => {
  assert.equal(fmtBytes(undefined), '0 B');
});

test('fmtDate returns an empty string for missing or invalid input', () => {
  assert.equal(fmtDate(undefined, 'en'), '');
  assert.equal(fmtDate(null, 'en'), '');
  assert.equal(fmtDate('', 'en'), '');
  assert.equal(fmtDate('not-a-date', 'en'), '');
  assert.equal(fmtDate('not-a-date', 'zh'), '');
});

test('fmtDate produces a non-empty localized string for a valid timestamp', () => {
  const iso = '2026-05-03T10:00:00Z';
  // Locale-specific output varies with the host's ICU data, so we only
  // assert (a) the output is a non-empty string and (b) it contains the
  // year, which every locale's "short" date includes.
  const en = fmtDate(iso, 'en');
  const zh = fmtDate(iso, 'zh');
  assert.ok(en.length > 0);
  assert.ok(zh.length > 0);
  assert.match(en, /2026/);
  assert.match(zh, /2026/);
});

test('fmtDate uses en formatting when the lang argument is omitted', () => {
  const iso = '2026-05-03T10:00:00Z';
  const defaulted = fmtDate(iso);
  const explicitEn = fmtDate(iso, 'en');
  assert.equal(defaulted, explicitEn);
});

test('fmtDate accepts a Date instance as well as ISO strings', () => {
  const iso = '2026-05-03T10:00:00Z';
  const fromString = fmtDate(iso, 'en');
  const fromDate = fmtDate(new Date(iso), 'en');
  assert.equal(fromDate, fromString);
});

// Backward compatibility: old index items have no mediaKind field.
// pickLangField and pickLangTags must work correctly without it.
test('pickLangField and pickLangTags work on old index items without mediaKind', () => {
  const oldPhoto = {
    id: '1', title: 'old photo', mime: 'image/jpeg',
    aiCaptionEn: 'A cat', aiCaptionZh: '一只猫',
    aiTagsEn: ['cat', 'indoor'], aiTagsZh: ['猫', '室内'],
    tags: [],
    // no mediaKind field — simulates pre-video index
  };
  assert.equal(pickLangField(oldPhoto, 'en', 'aiCaption'), 'A cat');
  assert.equal(pickLangField(oldPhoto, 'zh', 'aiCaption'), '一只猫');
  assert.deepEqual(pickLangTags(oldPhoto, 'en'), ['cat', 'indoor']);
  assert.deepEqual(pickLangTags(oldPhoto, 'zh'), ['猫', '室内']);
});

test('pickLangTags handles video items with mediaKind', () => {
  const videoItem = {
    id: '2', title: 'clip', mime: 'video/mp4', mediaKind: 'video',
    aiCaptionEn: 'A dog running', aiCaptionZh: '一只狗在奔跑',
    aiTagsEn: ['dog', 'park'], aiTagsZh: ['狗', '公园'],
    tags: [],
  };
  assert.equal(pickLangField(videoItem, 'en', 'aiCaption'), 'A dog running');
  assert.deepEqual(pickLangTags(videoItem, 'en'), ['dog', 'park']);
});
