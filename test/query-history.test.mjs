import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addQueryHistoryEntry,
  formatQueryHistoryLabel,
  normalizeQueryHistory,
} from '../media/sql/query-history.mjs';

test('query history stores trimmed newest-first entries and ignores blanks', () => {
  assert.deepEqual(addQueryHistoryEntry([], '  SELECT 1;  '), ['SELECT 1;']);
  assert.deepEqual(addQueryHistoryEntry(['SELECT 1;'], '   '), ['SELECT 1;']);
});

test('query history moves duplicate entries to the top without duplicating them', () => {
  assert.deepEqual(
    addQueryHistoryEntry(['SELECT 1;', 'SELECT 2;'], 'SELECT 2;'),
    ['SELECT 2;', 'SELECT 1;'],
  );
});

test('query history caps entries at the configured limit', () => {
  assert.deepEqual(
    addQueryHistoryEntry(['SELECT 1;', 'SELECT 2;'], 'SELECT 3;', { limit: 2 }),
    ['SELECT 3;', 'SELECT 1;'],
  );
});

test('query history normalizes persisted values defensively', () => {
  assert.deepEqual(
    normalizeQueryHistory([' SELECT 1 ', '', null, 'SELECT 2', 'SELECT 1'], { limit: 3 }),
    ['SELECT 1', 'SELECT 2'],
  );
});

test('query history labels collapse whitespace and truncate long SQL', () => {
  assert.equal(formatQueryHistoryLabel('SELECT *\nFROM people   WHERE active = 1'), 'SELECT * FROM people WHERE active = 1');
  assert.equal(formatQueryHistoryLabel('SELECT ' + 'x'.repeat(80), { maxLength: 20 }), 'SELECT xxxxxxxxxxxx…');
});
