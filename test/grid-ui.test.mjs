import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getCellInteraction,
  getCellClipboardText,
  getCopilotSelectionContext,
  getDeleteRowsConfirmationMessage,
  getGridColumnStyle,
  getObjectItemInteraction,
  getPagerState,
  getPinnedCellStyle,
  getPinnedColumnLayout,
  getPinnedRowOffset,
  getRefreshButtonState,
  getRowActions,
  getRowSelectionKey,
  getSelectedVisibleRows,
  getSelectAllRowsState,
  getTextEditingShortcutAction,
  shouldKeepKeyboardShortcutInField,
} from '../media/grid-ui.mjs';

test('Copilot selection context includes grid state without row values', () => {
  assert.deepEqual(getCopilotSelectionContext({
    table: { name: 'people', type: 'table' },
    filter: 'Ada',
    columnFilters: { team: 'Computing', empty: '' },
    sortColumn: 'name',
    sortDirection: 'desc',
    selectedColumns: ['name'],
    selectedRowCount: 2,
    selectedRowNumbers: [3, 5],
  }), {
    objectName: 'people',
    objectType: 'table',
    filter: 'Ada',
    columnFilters: { team: 'Computing' },
    sortColumn: 'name',
    sortDirection: 'desc',
    selectedColumns: ['name'],
    selectedRowCount: 2,
    selectedRowNumbers: [3, 5],
    selectedRowScope: 'visibleRows',
  });
});

test('database object refresh is available whenever a database is open', () => {
  assert.deepEqual(getRefreshButtonState({
    target: 'objects',
    hasDatabase: false,
    hasActiveTable: false,
  }), { disabled: true });
  assert.deepEqual(getRefreshButtonState({
    target: 'objects',
    hasDatabase: true,
    hasActiveTable: false,
  }), { disabled: false });
});

test('table data refresh is available only when a table or view is selected', () => {
  assert.deepEqual(getRefreshButtonState({
    target: 'table-data',
    hasDatabase: true,
    hasActiveTable: false,
  }), { disabled: true });
  assert.deepEqual(getRefreshButtonState({
    target: 'table-data',
    hasDatabase: true,
    hasActiveTable: true,
  }), { disabled: false });
});

test('editable table cells select first, then expose double-click edit and copy guidance', () => {
  assert.deepEqual(getCellInteraction({ tableType: 'table', value: 'Ada' }), {
    disabled: false,
    title: 'Click to select · double-click to edit · Ctrl/Cmd+C to copy',
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

test('cell clipboard text preserves editable values and describes non-text values', () => {
  assert.equal(getCellClipboardText('Ada'), 'Ada');
  assert.equal(getCellClipboardText(42), '42');
  assert.equal(getCellClipboardText(null), '');
  assert.equal(getCellClipboardText(new Uint8Array([1, 2, 3])), '[BLOB 3 bytes]');
});

test('row selection keys prefer rowid and fall back to sorted primary keys', () => {
  assert.equal(getRowSelectionKey({ rowid: 42, primaryKey: { id: 1 } }), 'rowid:42');
  assert.equal(
    getRowSelectionKey({ rowid: null, primaryKey: { b: 'two', a: 1 } }),
    'pk:[["a",1],["b","two"]]',
  );
  assert.equal(
    getRowSelectionKey({ rowid: null, primaryKey: { id: new Uint8Array([1, 2]) } }),
    'pk:[["id",{"type":"blob","bytes":[1,2]}]]',
  );
});

test('selected visible rows are returned in current visible order', () => {
  const visibleRows = [
    { identity: { rowid: 3, primaryKey: {} }, values: { id: 3 } },
    { identity: { rowid: 1, primaryKey: {} }, values: { id: 1 } },
    { identity: { rowid: 2, primaryKey: {} }, values: { id: 2 } },
  ];

  assert.deepEqual(
    getSelectedVisibleRows({ visibleRows, selectedRowKeys: new Set(['rowid:2', 'rowid:3']) })
      .map((row) => row.values.id),
    [3, 2],
  );
});

test('select-all state reports checked and indeterminate states for visible rows', () => {
  const visibleRows = [
    { identity: { rowid: 1, primaryKey: {} } },
    { identity: { rowid: 2, primaryKey: {} } },
  ];

  assert.deepEqual(getSelectAllRowsState({ visibleRows, selectedRowKeys: new Set() }), {
    checked: false,
    indeterminate: false,
    selectedVisibleCount: 0,
    visibleCount: 2,
  });
  assert.deepEqual(getSelectAllRowsState({ visibleRows, selectedRowKeys: new Set(['rowid:1']) }), {
    checked: false,
    indeterminate: true,
    selectedVisibleCount: 1,
    visibleCount: 2,
  });
  assert.deepEqual(getSelectAllRowsState({ visibleRows, selectedRowKeys: new Set(['rowid:1', 'rowid:2']) }), {
    checked: true,
    indeterminate: false,
    selectedVisibleCount: 2,
    visibleCount: 2,
  });
});

test('delete selected rows confirmation message names the selected row count', () => {
  assert.equal(
    getDeleteRowsConfirmationMessage(1),
    'Delete 1 selected row? This cannot be undone until you use VS Code Undo.',
  );
  assert.equal(
    getDeleteRowsConfirmationMessage(1200),
    'Delete 1,200 selected rows? This cannot be undone until you use VS Code Undo.',
  );
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

test('text editing shortcuts map to explicit input actions across webview fields', () => {
  assert.equal(getTextEditingShortcutAction({ key: 'a', metaKey: true, targetTagName: 'input' }), 'selectAll');
  assert.equal(getTextEditingShortcutAction({ key: 'c', ctrlKey: true, targetTagName: 'textarea' }), 'copy');
  assert.equal(getTextEditingShortcutAction({ key: 'x', metaKey: true, targetTagName: 'input' }), 'cut');
  assert.equal(getTextEditingShortcutAction({ key: 'v', metaKey: true, targetTagName: 'textarea' }), 'paste');
  assert.equal(getTextEditingShortcutAction({ key: 'z', metaKey: true, shiftKey: false, targetTagName: 'textarea' }), 'nativeUndo');
  assert.equal(getTextEditingShortcutAction({ key: 'z', metaKey: true, shiftKey: true, targetTagName: 'textarea' }), 'nativeRedo');
  assert.equal(getTextEditingShortcutAction({ key: 'y', ctrlKey: true, targetTagName: 'input' }), 'nativeRedo');
  assert.equal(getTextEditingShortcutAction({ key: 's', metaKey: true, targetTagName: 'input' }), null);
  assert.equal(getTextEditingShortcutAction({ key: 'v', metaKey: true, targetTagName: 'button' }), null);
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

test('unresized grid columns carry a max-width cap and resized columns override it', () => {
  assert.equal(getGridColumnStyle(), 'max-width:min(360px, 30vw)');
  assert.equal(getGridColumnStyle({ columnWidth: 420 }), 'width:420px;min-width:420px;max-width:420px');
  assert.equal(getGridColumnStyle({ columnWidth: 0 }), 'max-width:min(360px, 30vw)');
});

test('pinned columns get sequential sticky offsets after the row-number column', () => {
  assert.deepEqual(getPinnedColumnLayout({
    columns: ['id', 'name', 'email', 'notes'],
    pinnedColumns: new Set(['id', 'email', 'notes']),
    columnWidths: { id: 80, email: 240 },
  }), {
    id: { left: 64, width: 80, style: 'width:80px;min-width:80px;max-width:80px;left:64px;z-index:5' },
    email: { left: 144, width: 240, style: 'width:240px;min-width:240px;max-width:240px;left:144px;z-index:5' },
    notes: { left: 384, width: 150, style: 'width:150px;min-width:150px;max-width:150px;left:384px;z-index:5' },
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

test('pinned column cell style preserves horizontal offsets and overrides z-index', () => {
  assert.equal(getPinnedCellStyle({
    columnLayout: { style: 'width:240px;min-width:240px;max-width:240px;left:132px;z-index:5' },
    zIndex: 8,
  }), 'width:240px;min-width:240px;max-width:240px;left:132px;z-index:8');
  assert.equal(getPinnedCellStyle({
    columnLayout: { style: 'width:240px;min-width:240px;max-width:240px;left:132px;z-index:5' },
    rowOffset: 123,
    zIndex: 20,
  }), 'width:240px;min-width:240px;max-width:240px;left:132px;top:123px;z-index:20');
  assert.equal(getPinnedCellStyle({
    rowOffset: 123,
    zIndex: 8,
  }), 'top:123px;z-index:8');
  assert.equal(getPinnedCellStyle({
    zIndex: 7,
  }), 'z-index:7');
});
