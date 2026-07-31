import test from 'node:test';
import assert from 'node:assert/strict';

import { createLatestRequestGate } from './latestRequest.js';

test('the latest request remains current', () => {
  const gate = createLatestRequestGate('cat', 'favorite');
  const request = gate.begin();

  assert.equal(request.isCurrent(), true);
  assert.deepEqual(request.search, { q: 'cat', tag: 'favorite' });
});

test('a newer request invalidates every older request', () => {
  const gate = createLatestRequestGate();
  const first = gate.begin();
  const second = gate.begin();

  assert.equal(first.isCurrent(), false);
  assert.equal(second.isCurrent(), true);
});

test('an older response cannot commit after the latest response', () => {
  const gate = createLatestRequestGate();
  const applied = [];
  const older = gate.begin();
  const latest = gate.begin();

  if (latest.isCurrent()) applied.push('latest');
  if (older.isCurrent()) applied.push('older');

  assert.deepEqual(applied, ['latest']);
});

test('a scheduled refresh starts with the latest search values', () => {
  const gate = createLatestRequestGate('old query', 'old-tag');
  const scheduledRefresh = () => gate.begin();

  gate.setSearch('new query', 'new-tag');
  const request = scheduledRefresh();

  assert.deepEqual(request.search, { q: 'new query', tag: 'new-tag' });
  assert.equal(request.isCurrent(), true);
});

test('a pending refresh cannot restore an old query while the new query is slow', () => {
  const gate = createLatestRequestGate('old query', 'old-tag');
  const pendingRefresh = () => gate.begin();

  gate.setSearch('new query', 'new-tag');
  const activeSearch = gate.begin();
  const pendingSearch = pendingRefresh();

  assert.equal(activeSearch.isCurrent(), false);
  assert.deepEqual(pendingSearch.search, { q: 'new query', tag: 'new-tag' });
  assert.equal(pendingSearch.isCurrent(), true);
});

test('changing search values invalidates an in-flight request', () => {
  const gate = createLatestRequestGate('old query', '');
  const request = gate.begin();

  gate.setSearch('new query', '');

  assert.equal(request.isCurrent(), false);
});

test('setting identical search values keeps an in-flight request current', () => {
  const gate = createLatestRequestGate('cat', 'favorite');
  const request = gate.begin();

  gate.setSearch('cat', 'favorite');

  assert.equal(request.isCurrent(), true);
});

test('cleanup invalidates an in-flight request without starting another one', () => {
  const gate = createLatestRequestGate();
  const request = gate.begin();

  gate.invalidate();

  assert.equal(request.isCurrent(), false);
});
