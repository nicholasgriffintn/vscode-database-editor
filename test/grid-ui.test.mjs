import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getCellInteraction,
  getPagerState,
  getRowActions,
  shouldKeepKeyboardShortcutInField,
} from '../media/grid-ui.mjs';

test('editable table cells open the editor on single click', () => {
  assert.deepEqual(getCellInteraction({ tableType: 'table', value: 'Ada' }), {
    disabled: false,
    title: 'Open row details',
  });
});

test('views and blob cells do not expose inline editing', () => {
  assert.deepEqual(getCellInteraction({ tableType: 'view', value: 'Ada' }), {
    disabled: true,
    title: 'Views are read-only',
  });
  assert.deepEqual(getCellInteraction({ tableType: 'table', value: new Uint8Array([1, 2]) }), {
    disabled: true,
    title: 'BLOB values cannot be edited inline',
  });
});

test('row actions are per-row and table-only', () => {
  assert.deepEqual(getRowActions({ tableType: 'table', rowIndex: 2 }), [
    { action: 'edit-row', label: 'Edit row', rowIndex: 2, disabled: false },
    { action: 'delete-row', label: 'Delete row', rowIndex: 2, disabled: false },
  ]);
  assert.deepEqual(getRowActions({ tableType: 'view', rowIndex: 2 }), []);
});

test('pager state belongs to the bottom-right grid footer', () => {
  assert.deepEqual(getPagerState({ page: 2, pageSize: 100, totalRows: 250 }), {
    label: 'Page 2 of 3 · 250 rows',
    canGoPrevious: true,
    canGoNext: true,
  });
});

test('text editing shortcuts stay inside row detail fields', () => {
  assert.equal(shouldKeepKeyboardShortcutInField({ key: 'z', metaKey: true, ctrlKey: false, targetTagName: 'textarea' }), true);
  assert.equal(shouldKeepKeyboardShortcutInField({ key: 'a', metaKey: false, ctrlKey: true, targetTagName: 'input' }), true);
  assert.equal(shouldKeepKeyboardShortcutInField({ key: 's', metaKey: true, ctrlKey: false, targetTagName: 'textarea' }), false);
  assert.equal(shouldKeepKeyboardShortcutInField({ key: 'z', metaKey: true, ctrlKey: false, targetTagName: 'button' }), false);
});
