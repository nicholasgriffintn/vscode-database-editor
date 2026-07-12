import assert from 'node:assert/strict';
import test from 'node:test';

import { createGridSelection } from '../media/grid/selection.mjs';

test('grid selection owns row ranges and publishes host context', () => {
  const messages = [];
  const state = {
    table: { type: 'table', name: 'people' },
    visibleRows: [
      { identity: { kind: 'rowid', value: 1 } },
      { identity: { kind: 'rowid', value: 2 } },
      { identity: { kind: 'rowid', value: 3 } },
    ],
    visibleRowOffset: 20,
    filter: '',
    columnFilters: {},
    sortColumn: null,
    sortDirection: 'asc',
  };
  const deleteButton = { disabled: true, textContent: '' };
  const selection = createGridSelection({
    elements: { grid: { querySelector: () => null }, deleteSelectedRows: deleteButton },
    vscode: { postMessage: (message) => messages.push(message) },
    getState: () => state,
  });

  selection.toggle(0);
  selection.toggle(2, { range: true });
  selection.updateUi();

  assert.equal(selection.selectedRows.length, 3);
  assert.equal(deleteButton.disabled, false);
  assert.equal(deleteButton.textContent, 'Delete selected (3)');
  assert.deepEqual(messages.at(-1).context.selectedRowNumbers, [21, 22, 23]);

  selection.clearSelectedRows();
  assert.equal(selection.selectedRows.length, 0);
  assert.equal(deleteButton.disabled, true);
});
