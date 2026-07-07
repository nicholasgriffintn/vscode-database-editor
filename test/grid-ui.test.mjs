import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getCellInteraction,
  getObjectItemInteraction,
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
  assert.deepEqual(getPagerState({ page: 2, pageSize: 100, filteredRows: 250, totalRows: 1000 }), {
    label: 'Rows 101-200 of 250 filtered · 1000 total',
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

test('tables and views are browsable sidebar objects', () => {
  assert.deepEqual(getObjectItemInteraction({ objectType: 'table', objectName: 'people', tableName: null }), {
    browsable: true,
    title: undefined,
  });
  assert.deepEqual(getObjectItemInteraction({ objectType: 'view', objectName: 'active_people', tableName: null }), {
    browsable: true,
    title: undefined,
  });
});

test('indexes and triggers are not browsable and explain why', () => {
  assert.deepEqual(getObjectItemInteraction({ objectType: 'index', objectName: 'people_name', tableName: 'people' }), {
    browsable: false,
    title: 'people_name is not directly browsable · defined on people',
  });
  assert.deepEqual(getObjectItemInteraction({ objectType: 'trigger', objectName: 'people_name_required', tableName: 'people' }), {
    browsable: false,
    title: 'people_name_required is not directly browsable · defined on people',
  });
});
