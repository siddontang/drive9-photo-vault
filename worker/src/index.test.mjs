import test from 'node:test';
import assert from 'node:assert/strict';

import {
  effectiveVideoMime,
  mediaKindFromMime,
  inferMediaKind,
  VIDEO_SIZE_LIMIT,
  IMAGE_SIZE_LIMIT,
  drive9SemanticContentPresent,
} from '../dist/index.js';

// task #6 REVISE (adversary-1, blocker 1): drive9 stat ALWAYS serializes a
// semantic_text field — empty string for objects that have not been analyzed
// yet. Marking "analysis finished" on mere presence flips freshly-uploaded,
// still-pending images to a terminal 'unavailable' and stops re-polling. Only a
// NON-EMPTY semantic_text means drive9 actually produced output.
test('empty/absent semantic_text is NOT treated as produced content (stays pending)', () => {
  assert.equal(drive9SemanticContentPresent({ semantic_text: '' }), false);
  assert.equal(drive9SemanticContentPresent({ semantic_text: '   ' }), false);
  assert.equal(drive9SemanticContentPresent({}), false);
  assert.equal(drive9SemanticContentPresent({ semantic_text: [] }), false);
  assert.equal(drive9SemanticContentPresent({ semantic_text: ['', '  '] }), false);
  assert.equal(drive9SemanticContentPresent(null), false);
});

test('non-empty semantic_text counts as produced content (eligible for unavailable)', () => {
  // A truncated tail that yields nothing usable is still "produced" — drive9 ran,
  // so the terminal state is 'unavailable', not perpetual pending.
  assert.equal(drive9SemanticContentPresent({ semantic_text: '{"caption_en":"Half a capti' }), true);
  assert.equal(drive9SemanticContentPresent({ semantic_text: ['英文摘要：Sunset'] }), true);
  assert.equal(drive9SemanticContentPresent({ semantic_text: { caption_en: 'x' } }), true);
});

// -- effectiveVideoMime --

test('effectiveVideoMime accepts known video MIME types', () => {
  assert.equal(effectiveVideoMime('video/mp4', 'clip.mp4'), 'video/mp4');
  assert.equal(effectiveVideoMime('video/quicktime', 'clip.mov'), 'video/quicktime');
  assert.equal(effectiveVideoMime('video/webm', 'clip.webm'), 'video/webm');
  assert.equal(effectiveVideoMime('video/x-msvideo', 'clip.avi'), 'video/x-msvideo');
  assert.equal(effectiveVideoMime('video/x-matroska', 'clip.mkv'), 'video/x-matroska');
});

test('effectiveVideoMime strips MIME parameters before matching', () => {
  assert.equal(effectiveVideoMime('video/mp4; codecs=avc1', 'clip.mp4'), 'video/mp4');
  assert.equal(effectiveVideoMime('video/webm; codecs=vp9', 'clip.webm'), 'video/webm');
});

test('effectiveVideoMime falls back to extension for empty MIME', () => {
  assert.equal(effectiveVideoMime('', 'clip.mp4'), 'video/mp4');
  assert.equal(effectiveVideoMime('', 'clip.mov'), 'video/quicktime');
  assert.equal(effectiveVideoMime('', 'clip.mkv'), 'video/x-matroska');
});

test('effectiveVideoMime falls back to extension for application/octet-stream', () => {
  assert.equal(effectiveVideoMime('application/octet-stream', 'video.mp4'), 'video/mp4');
  assert.equal(effectiveVideoMime('application/octet-stream', 'video.avi'), 'video/x-msvideo');
});

test('effectiveVideoMime falls back to extension for text/plain (Drive9 #751 parity)', () => {
  assert.equal(effectiveVideoMime('text/plain', 'clip.mp4'), 'video/mp4');
  assert.equal(effectiveVideoMime('text/plain', 'clip.webm'), 'video/webm');
});

test('effectiveVideoMime returns null for non-video MIME without video extension', () => {
  assert.equal(effectiveVideoMime('image/jpeg', 'photo.jpg'), null);
  assert.equal(effectiveVideoMime('text/plain', 'readme.txt'), null);
  assert.equal(effectiveVideoMime('application/pdf', 'doc.pdf'), null);
});

test('effectiveVideoMime returns null for unknown video-like MIME', () => {
  assert.equal(effectiveVideoMime('video/x-flv', 'clip.flv'), null);
});

test('effectiveVideoMime is case-insensitive on filename extension', () => {
  assert.equal(effectiveVideoMime('', 'CLIP.MP4'), 'video/mp4');
  assert.equal(effectiveVideoMime('', 'Video.MOV'), 'video/quicktime');
});

// -- mediaKindFromMime --

test('mediaKindFromMime returns image for image/* MIME types', () => {
  assert.equal(mediaKindFromMime('image/jpeg'), 'image');
  assert.equal(mediaKindFromMime('image/png'), 'image');
  assert.equal(mediaKindFromMime('image/webp'), 'image');
});

test('mediaKindFromMime returns video for allowed video MIME types', () => {
  assert.equal(mediaKindFromMime('video/mp4'), 'video');
  assert.equal(mediaKindFromMime('video/quicktime'), 'video');
});

test('mediaKindFromMime returns video via extension fallback', () => {
  assert.equal(mediaKindFromMime('application/octet-stream', 'clip.mp4'), 'video');
  assert.equal(mediaKindFromMime('text/plain', 'clip.mov'), 'video');
});

test('mediaKindFromMime returns null for unsupported types', () => {
  assert.equal(mediaKindFromMime('application/pdf'), null);
  assert.equal(mediaKindFromMime('text/plain', 'readme.txt'), null);
});

// -- inferMediaKind --

test('inferMediaKind respects explicit mediaKind field', () => {
  assert.equal(inferMediaKind({ mediaKind: 'video', mime: 'image/jpeg' }), 'video');
  assert.equal(inferMediaKind({ mediaKind: 'image', mime: 'video/mp4' }), 'image');
});

test('inferMediaKind infers video from MIME when mediaKind is absent', () => {
  assert.equal(inferMediaKind({ mime: 'video/mp4' }), 'video');
  assert.equal(inferMediaKind({ mime: 'video/quicktime' }), 'video');
});

test('inferMediaKind defaults to image when mediaKind is absent and MIME is not video', () => {
  assert.equal(inferMediaKind({ mime: 'image/jpeg' }), 'image');
  assert.equal(inferMediaKind({}), 'image');
  assert.equal(inferMediaKind({ mime: 'application/pdf' }), 'image');
});

// -- size limits --

test('size limits are 25MB', () => {
  assert.equal(VIDEO_SIZE_LIMIT, 25 * 1024 * 1024);
  assert.equal(IMAGE_SIZE_LIMIT, 25 * 1024 * 1024);
});
