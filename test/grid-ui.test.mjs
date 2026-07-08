import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getCellInteraction,
  getObjectItemInteraction,
  getPagerState,
  getPinnedCellStyle,
  getPinnedColumnLayout,
  getPinnedRowOffset,
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

test('pinned columns get sequential sticky offsets after the row-number column', () => {
  assert.deepEqual(getPinnedColumnLayout({
    columns: ['id', 'name', 'email', 'notes'],
    pinnedColumns: new Set(['id', 'email', 'notes']),
    columnWidths: { id: 80, email: 240 },
  }), {
    id: { left: 52, width: 80, style: 'width:80px;min-width:80px;max-width:80px;left:52px;z-index:5' },
    email: { left: 132, width: 240, style: 'width:240px;min-width:240px;max-width:240px;left:132px;z-index:5' },
    notes: { left: 372, width: 150, style: 'width:150px;min-width:150px;max-width:150px;left:372px;z-index:5' },
  });
  assert.equal(getPinnedColumnLayout({
    columns: ['created_at', 'category'],
    pinnedColumns: new Set(['created_at', 'category']),
    columnWidths: { created_at: 150, category: 170 },
    rowNumberWidth: 118,
  }).created_at.left, 118);
});

test('pinned rows stack below both sticky header rows', () => {
  assert.equal(getPinnedRowOffset({
    realRowIndex: 8,
    visiblePinnedRows: [3, 8, 12],
  }), 123);
  assert.equal(getPinnedRowOffset({
    realRowIndex: 9,
    visiblePinnedRows: [3, 8, 12],
  }), undefined);
});

test('pinned column cell style preserves horizontal offsets and sticky row top', () => {
  assert.equal(getPinnedCellStyle({
    columnLayout: { style: 'width:240px;min-width:240px;max-width:240px;left:132px;z-index:5' },
    rowOffset: 123,
    zIndex: 8,
  }), 'width:240px;min-width:240px;max-width:240px;left:132px;top:123px;z-index:8');
  assert.equal(getPinnedCellStyle({
    rowOffset: 94,
    zIndex: 7,
  }), 'top:94px;z-index:7');
});
