import test from 'node:test';
import assert from 'node:assert/strict';

import {
  nextIndex,
  prevIndex,
  canGoNext,
  canGoPrev,
  reanchorIndex,
  gestureAction,
} from './lightboxNav.js';

test('nextIndex stops at the last photo and never wraps around', () => {
  assert.equal(nextIndex(0, 5), 1);
  assert.equal(nextIndex(3, 5), 4);
  assert.equal(nextIndex(4, 5), 4);
  assert.equal(nextIndex(99, 5), 4);
});

test('nextIndex on empty list returns -1', () => {
  assert.equal(nextIndex(0, 0), -1);
});

test('prevIndex stops at zero and never wraps', () => {
  assert.equal(prevIndex(3), 2);
  assert.equal(prevIndex(1), 0);
  assert.equal(prevIndex(0), 0);
  assert.equal(prevIndex(-5), 0);
});

test('canGoNext / canGoPrev encode boundary navigation rules', () => {
  assert.equal(canGoPrev(0), false);
  assert.equal(canGoPrev(1), true);
  assert.equal(canGoNext(0, 1), false);
  assert.equal(canGoNext(0, 2), true);
  assert.equal(canGoNext(1, 2), false);
  assert.equal(canGoNext(0, 0), false);
});

test('reanchorIndex follows the open photo by id across list updates', () => {
  const before = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const after = [{ id: 'c' }, { id: 'b' }, { id: 'a' }];
  assert.equal(reanchorIndex(after, 'b'), 1);
  assert.equal(reanchorIndex(after, 'a'), 2);
});

test('reanchorIndex returns null when the open photo was deleted', () => {
  const after = [{ id: 'a' }, { id: 'c' }];
  assert.equal(reanchorIndex(after, 'b'), null);
});

test('reanchorIndex returns null with no open id', () => {
  assert.equal(reanchorIndex([{ id: 'a' }], null), null);
  assert.equal(reanchorIndex([{ id: 'a' }], ''), null);
});

test('gestureAction prefers horizontal axis when both exceed thresholds', () => {
  // Horizontal swipe with a slight vertical drift: must be a swipe, not a close
  assert.equal(gestureAction(-200, 80), 'next');
  assert.equal(gestureAction(200, 80), 'prev');
});

test('gestureAction returns close only on dominant downward drag', () => {
  assert.equal(gestureAction(0, 150), 'close');
  assert.equal(gestureAction(40, 150), 'close');
  // Upward drag is not "close"; we treat it as nothing here.
  assert.equal(gestureAction(0, -150), null);
});

test('gestureAction returns null below thresholds', () => {
  assert.equal(gestureAction(0, 0), null);
  assert.equal(gestureAction(30, 30), null);
  assert.equal(gestureAction(59, 99), null);
});

test('gestureAction respects custom thresholds', () => {
  assert.equal(gestureAction(70, 0, { horizontalThreshold: 100 }), null);
  assert.equal(gestureAction(110, 0, { horizontalThreshold: 100 }), 'prev');
});

test('gestureAction picks horizontal on a tie', () => {
  assert.equal(gestureAction(-100, 100), 'next');
  assert.equal(gestureAction(100, 100), 'prev');
});

test('gestureAction does not close when neither axis meets its own threshold', () => {
  // dx 70 clears horizontal threshold (60) but dy 80 is bigger and below
  // its own vertical threshold (100). Old code would close; new code returns null.
  assert.equal(gestureAction(70, 80), null);
  assert.equal(gestureAction(-70, 80), null);
  assert.equal(gestureAction(70, -80), null);
});

test('gestureAction requires absX to clear horizontal threshold even when X dominates', () => {
  // absX 50 < 60 horizontal threshold, even though X > Y. With low Y too, no action.
  assert.equal(gestureAction(50, 30), null);
  assert.equal(gestureAction(-50, 30), null);
});

test('gestureAction requires vertical-dominant drag to actually be vertical-dominant', () => {
  // absY 100 meets its threshold but absX 105 is bigger → horizontal candidate wins.
  assert.equal(gestureAction(105, 100), 'prev');
  assert.equal(gestureAction(-105, 100), 'next');
});
