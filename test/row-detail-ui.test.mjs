import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getRowFieldState,
  getRowValidationErrors,
  normalizeRowFieldValue,
  rowValuesEqual,
} from '../media/row-detail-ui.mjs';

const textColumn = { name: 'name', type: 'TEXT', nullable: false };
const nullableColumn = { name: 'notes', type: 'TEXT', nullable: true };

test('row detail field state marks dirty values and reset availability', () => {
  assert.deepEqual(getRowFieldState({ previousValue: 'Ada', nextValue: 'Ada', readOnly: false }), {
    dirty: false,
    resetDisabled: true,
  });
  assert.deepEqual(getRowFieldState({ previousValue: 'Ada', nextValue: 'Grace', readOnly: false }), {
    dirty: true,
    resetDisabled: false,
  });
  assert.deepEqual(getRowFieldState({ previousValue: 'Ada', nextValue: 'Grace', readOnly: true }), {
    dirty: false,
    resetDisabled: true,
  });
});

test('row detail value comparison treats null and empty string as distinct', () => {
  assert.equal(rowValuesEqual(null, null), true);
  assert.equal(rowValuesEqual(null, ''), false);
  assert.equal(rowValuesEqual('', null), false);
  assert.equal(rowValuesEqual(42, '42'), true);
});

test('row detail normalizes NULL toggle separately from text input', () => {
  assert.equal(normalizeRowFieldValue({ inputValue: 'Ada', nullChecked: false }), 'Ada');
  assert.equal(normalizeRowFieldValue({ inputValue: 'Ada', nullChecked: true }), null);
});

test('row detail validation rejects NULL for not-null fields before saving', () => {
  assert.deepEqual(getRowValidationErrors([
    { column: textColumn, value: null, readOnly: false },
    { column: nullableColumn, value: null, readOnly: false },
  ]), ['name cannot be NULL.']);
  assert.deepEqual(getRowValidationErrors([
    { column: textColumn, value: null, readOnly: true },
  ]), []);
});
