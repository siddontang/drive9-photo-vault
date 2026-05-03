// Pure navigation helpers for the lightbox. Kept free of React so they can be
// unit-tested without a DOM.

export function nextIndex(index, total) {
  if (total <= 0) return -1;
  return Math.min(total - 1, index + 1);
}

export function prevIndex(index) {
  return Math.max(0, index - 1);
}

export function canGoNext(index, total) {
  return total > 0 && index < total - 1;
}

export function canGoPrev(index) {
  return index > 0;
}

// Given the photos list, the currently-open photo id, and a new photos list
// (after a refetch / delete / sort change), return the index of the same id in
// the new list, or null if the photo no longer exists.
export function reanchorIndex(photos, openId) {
  if (!openId) return null;
  const i = photos.findIndex((p) => p && p.id === openId);
  return i >= 0 ? i : null;
}

// Decide whether a touch gesture should trigger an action. Returns one of:
//   'next' | 'prev' | 'close' | null
// Each axis must independently clear its own threshold before being a
// candidate; if both qualify, the dominant axis wins. dy>0 means finger
// moved down on screen.
export function gestureAction(dx, dy, opts = {}) {
  const horizontal = opts.horizontalThreshold ?? 60;
  const vertical = opts.verticalThreshold ?? 100;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);

  const horizCandidate = absX >= horizontal && absX >= absY;
  const verticalCandidate = absY >= vertical && absY > absX;

  if (horizCandidate) return dx < 0 ? 'next' : 'prev';
  if (verticalCandidate) return dy > 0 ? 'close' : null;
  return null;
}
