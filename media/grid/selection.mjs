import {
  getCopilotSelectionContext,
  getRowSelectionKey,
  getSelectedVisibleRows,
  getSelectAllRowsState,
} from './ui.mjs';

export function createGridSelection({ elements, vscode, getState }) {
  let selectedRow = null;
  let selectedCell = null;
  let lastSelectedRowIndex = null;
  const selectedRowKeys = new Set();

  function postContext() {
    const state = getState();
    const selectedRowNumbers = [];
    for (let index = 0; index < state.visibleRows.length; index += 1) {
      if (selectedRowKeys.has(getRowSelectionKey(state.visibleRows[index].identity))) {
        selectedRowNumbers.push(state.visibleRowOffset + index + 1);
      }
    }
    vscode.postMessage({
      type: 'copilotSelectionChanged',
      context: getCopilotSelectionContext({
        table: state.table,
        filter: state.filter,
        columnFilters: state.columnFilters,
        sortColumn: state.sortColumn,
        sortDirection: state.sortDirection,
        selectedColumns: selectedCell?.columnName ? [selectedCell.columnName] : [],
        selectedRowCount: selectedRowNumbers.length,
        selectedRowNumbers,
      }),
    });
  }

  function updateUi() {
    const count = getSelectedVisibleRows({
      visibleRows: getState().visibleRows,
      selectedRowKeys,
    }).length;
    if (!elements.deleteSelectedRows) return;
    elements.deleteSelectedRows.disabled = getState().table?.type !== 'table' || count === 0;
    elements.deleteSelectedRows.textContent = count > 0
      ? `Delete selected (${count.toLocaleString()})`
      : 'Delete selected';
  }

  function toggle(rowIndex, { range = false, additive = true } = {}) {
    const { visibleRows } = getState();
    if (!Number.isInteger(rowIndex) || !visibleRows[rowIndex]) return;
    if (range && Number.isInteger(lastSelectedRowIndex) && visibleRows[lastSelectedRowIndex]) {
      const start = Math.min(lastSelectedRowIndex, rowIndex);
      const end = Math.max(lastSelectedRowIndex, rowIndex);
      if (!additive) selectedRowKeys.clear();
      for (let index = start; index <= end; index += 1) {
        selectedRowKeys.add(getRowSelectionKey(visibleRows[index].identity));
      }
    } else {
      const key = getRowSelectionKey(visibleRows[rowIndex].identity);
      if (selectedRowKeys.has(key)) selectedRowKeys.delete(key);
      else {
        if (!additive) selectedRowKeys.clear();
        selectedRowKeys.add(key);
      }
    }
    lastSelectedRowIndex = rowIndex;
    postContext();
  }

  function selectRow(rowIndex) {
    selectedRow = rowIndex;
    selectedCell = null;
    const grid = elements.grid.querySelector('.data-grid');
    grid?.querySelectorAll('.selected-row').forEach((row) => row.classList.remove('selected-row'));
    grid?.querySelectorAll('.selected-cell').forEach((cell) => cell.classList.remove('selected-cell'));
    grid?.querySelector(`tr[data-row="${CSS.escape(String(rowIndex))}"]`)?.classList.add('selected-row');
    postContext();
  }

  function selectCell(rowIndex, columnName) {
    selectedRow = rowIndex;
    selectedCell = { rowIndex, columnName };
    const grid = elements.grid.querySelector('.data-grid');
    grid?.querySelectorAll('.selected-row').forEach((row) => row.classList.remove('selected-row'));
    grid?.querySelectorAll('.selected-cell').forEach((cell) => cell.classList.remove('selected-cell'));
    const row = grid?.querySelector(`tr[data-row="${CSS.escape(String(rowIndex))}"]`);
    row?.classList.add('selected-row');
    row?.querySelector(`[data-grid-cell-column="${CSS.escape(columnName)}"]`)?.classList.add('selected-cell');
    postContext();
  }

  function toggleAll() {
    const { visibleRows } = getState();
    const state = getSelectAllRowsState({ visibleRows, selectedRowKeys });
    for (const row of visibleRows) {
      const key = getRowSelectionKey(row.identity);
      if (state.checked || state.indeterminate) selectedRowKeys.delete(key);
      else selectedRowKeys.add(key);
    }
    syncRendered();
    postContext();
  }

  function clearSelectedRows() {
    selectedRowKeys.clear();
    updateUi();
  }

  function reset({ updateRendered = false } = {}) {
    selectedRow = null;
    selectedCell = null;
    selectedRowKeys.clear();
    lastSelectedRowIndex = null;
    if (updateRendered) {
      elements.grid.querySelector('.data-grid')
        ?.querySelectorAll('.selected-row, .selected-cell, .multi-selected-row')
        .forEach((element) => element.classList.remove('selected-row', 'selected-cell', 'multi-selected-row'));
      syncRendered();
    } else {
      updateUi();
    }
    postContext();
  }

  function syncRendered() {
    const { visibleRows } = getState();
    const grid = elements.grid.querySelector('.data-grid');
    if (!grid) return;
    for (const renderedRow of grid.querySelectorAll('tr[data-row]')) {
      const row = visibleRows[Number(renderedRow.dataset.row)];
      const selected = Boolean(row && selectedRowKeys.has(getRowSelectionKey(row.identity)));
      renderedRow.classList.toggle('multi-selected-row', selected);
      const checkbox = renderedRow.querySelector('[data-select-row]');
      if (checkbox) {
        checkbox.checked = selected;
        checkbox.title = selected ? 'Deselect row' : 'Select row';
      }
    }
    const all = getSelectAllRowsState({ visibleRows, selectedRowKeys });
    const checkbox = grid.querySelector('[data-select-all-rows]');
    if (checkbox) {
      checkbox.checked = all.checked;
      checkbox.indeterminate = all.indeterminate;
      checkbox.title = all.checked ? 'Deselect visible rows' : 'Select visible rows';
    }
    updateUi();
  }

  return {
    clearSelectedRows,
    postContext,
    reset,
    selectCell,
    selectRow,
    syncRendered,
    toggle,
    toggleAll,
    updateUi,
    get selectedCell() { return selectedCell; },
    get selectedRow() { return selectedRow; },
    get selectedRowKeys() { return selectedRowKeys; },
    get selectedRows() { return getSelectedVisibleRows({ visibleRows: getState().visibleRows, selectedRowKeys }); },
  };
}
