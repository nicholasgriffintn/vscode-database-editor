import assert from 'node:assert/strict';
import test from 'node:test';

import { getGridColumnCount, getGridEmptyStateKind } from '../media/grid/empty-state.mjs';

test('grid empty state is none when rows are present', () => {
  assert.equal(getGridEmptyStateKind({ tableType: 'table', columnCount: 5, rowCount: 3 }), 'none');
});

test('grid empty state prompts adding a column when a table has none', () => {
  assert.equal(getGridEmptyStateKind({ tableType: 'table', columnCount: 0, rowCount: 0 }), 'table-no-columns');
});

test('grid empty state prompts adding a row when a table has columns but no rows', () => {
  assert.equal(getGridEmptyStateKind({ tableType: 'table', columnCount: 4, rowCount: 0 }), 'table-no-rows');
});

test('grid empty state for views never offers row/column mutation actions', () => {
  assert.equal(getGridEmptyStateKind({ tableType: 'view', columnCount: 0, rowCount: 0 }), 'view-no-columns');
  assert.equal(getGridEmptyStateKind({ tableType: 'view', columnCount: 3, rowCount: 0 }), 'view-no-rows');
});

test('grid column count includes the row number column and actions column for tables only', () => {
  assert.equal(getGridColumnCount({ columnCount: 4, tableType: 'table' }), 6);
  assert.equal(getGridColumnCount({ columnCount: 4, tableType: 'view' }), 5);
  assert.equal(getGridColumnCount({ columnCount: 0, tableType: 'view' }), 2);
});
