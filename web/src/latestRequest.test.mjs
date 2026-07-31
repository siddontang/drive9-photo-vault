import test from 'node:test';
import assert from 'node:assert/strict';

import { createLatestRequestGate } from './latestRequest.js';

test('the latest request remains current', () => {
  const gate = createLatestRequestGate();
  const request = gate.begin();

  assert.equal(request.isCurrent(), true);
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

test('cleanup invalidates an in-flight request without starting another one', () => {
  const gate = createLatestRequestGate();
  const request = gate.begin();

  gate.invalidate();

  assert.equal(request.isCurrent(), false);
});
