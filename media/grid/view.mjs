import { blobToObjectURL, describeBlob, isImageBlob } from '../data/blob.mjs';
import { createElement } from '../utilities/dom.mjs';
import { describeValue } from '../sql/statements.mjs';
import { getGridColumnCount, getGridEmptyStateKind } from './empty-state.mjs';
import { getEvictedGridResources, getGridRenderPlan } from './window.mjs';
import { createGridWindowSpacer } from './window-view.mjs';
import {
  getCellInteraction,
  getGridColumnStyle,
  getPinnedCellStyle,
  getPinnedColumnLayout,
  getPinnedRowOffset,
  getRowActions,
  getRowNumberColumnStyle,
  getRowSelectionKey,
  getSelectAllRowsState,
  ROW_NUMBER_COLUMN_WIDTH,
} from './ui.mjs';

export function createGridView({ elements, getState, updateSelectionUi }) {
  const blobUrls = new Map();
  let renderFrame = 0;

  function render({ bodyOnly = false } = {}) {
    const state = getState();
    const { table, visibleRows, pinnedColumns, columnWidths, selectedRowKeys } = state;
    if (!table) return;
    elements.copyRowsFormat.disabled = visibleRows.length === 0;
    const retainedBlobKeys = new Set();
    const pinnedLayouts = getPinnedColumnLayout({
      columns: table.columns, pinnedColumns, columnWidths,
      rowNumberWidth: columnWidths.__rowNumber || ROW_NUMBER_COLUMN_WIDTH,
    });
    const rowNumberStyle = getRowNumberColumnStyle({ columnWidth: columnWidths.__rowNumber });
    const selectAll = getSelectAllRowsState({ visibleRows, selectedRowKeys });
    let tableElement = bodyOnly ? elements.grid.querySelector('.data-grid') : null;
    if (!tableElement) tableElement = buildTableHeader(state, pinnedLayouts, rowNumberStyle, selectAll);

    const columnCount = getGridColumnCount({ columnCount: table.columns.length, tableType: table.type });
    const body = createElement('tbody');
    const plan = getGridRenderPlan({
      rowCount: visibleRows.length,
      rowOffset: state.visibleRowOffset,
      scrollTop: elements.grid.scrollTop,
      viewportHeight: elements.grid.clientHeight,
      pinnedRows: state.pinnedRows,
    });
    if (visibleRows.length === 0) body.append(createEmptyRow(table, columnCount));
    for (let index = 0; index < plan.rows.length; index += 1) {
      if (index === plan.pinnedRowIndexes.length && plan.topSpacerHeight > 0) {
        body.append(createGridWindowSpacer({ columnCount, height: plan.topSpacerHeight }));
      }
      body.append(buildRow(state, plan.rows[index], pinnedLayouts, rowNumberStyle, retainedBlobKeys));
    }
    if (plan.bottomSpacerHeight > 0) body.append(createGridWindowSpacer({ columnCount, height: plan.bottomSpacerHeight }));
    if (bodyOnly && tableElement.querySelector('tbody')) tableElement.querySelector('tbody').replaceWith(body);
    else { tableElement.append(body); elements.grid.replaceChildren(tableElement); }
    evictBlobUrls(retainedBlobKeys);
    syncSelectAll(selectAll, visibleRows.length);
    updateSelectionUi();
  }

  function schedule() {
    if (renderFrame) return;
    renderFrame = window.requestAnimationFrame(() => {
      renderFrame = 0;
      render({ bodyOnly: true });
    });
  }

  function rememberWidths() {
    const { columnWidths } = getState();
    const grid = elements.grid?.querySelector?.('.data-grid');
    if (!grid) return;
    const rowNumberWidth = Math.round(grid.querySelector('.column-heading-row .row-number-header')?.offsetWidth ?? 0);
    if (rowNumberWidth > 0) columnWidths.__rowNumber = rowNumberWidth;
    for (const handle of grid.querySelectorAll('[data-resize-column]')) {
      const width = Math.round(handle.closest('th')?.offsetWidth ?? 0);
      if (handle.dataset.resizeColumn && width > 0) columnWidths[handle.dataset.resizeColumn] = width;
    }
  }

  function clearResources() {
    for (const url of blobUrls.values()) URL.revokeObjectURL(url);
    blobUrls.clear();
  }

  function buildTableHeader(state, pinnedLayouts, rowNumberStyle, selectAll) {
    const tableElement = createElement('table', { className: 'data-grid' });
    const head = createElement('thead');
    const headings = createElement('tr', { className: 'column-heading-row' });
    const filters = createElement('tr', { className: 'column-filter-row' });
    headings.append(createElement('th', { className: 'row-number-header', style: rowNumberStyle, children: [
      createElement('div', { className: 'column-header', children: [
        createElement('input', { className: 'row-select-checkbox', title: selectAll.checked ? 'Deselect visible rows' : 'Select visible rows', attributes: {
          type: 'checkbox', 'data-select-all-rows': 'true', checked: selectAll.checked ? 'true' : undefined,
          disabled: state.visibleRows.length === 0 ? 'true' : undefined, 'aria-label': 'Select all visible rows',
        } }),
        createElement('span', { className: 'column-name row-number-heading-label', text: '#' }),
      ] }),
      createElement('div', { className: 'col-resize-handle', attributes: { 'data-resize-column': '__rowNumber' } }),
    ] }));
    filters.append(createElement('th', { className: 'row-number-header', style: rowNumberStyle, text: '' }));
    for (const column of state.table.columns) appendColumnHeaders(headings, filters, state, column, pinnedLayouts);
    if (state.table.type === 'table') {
      headings.append(createElement('th', { children: [createElement('div', { className: 'column-header row-actions-heading', children: [createElement('span', { className: 'column-name', text: 'actions' })] })] }));
      filters.append(createElement('th', { className: 'row-actions-filter-heading', text: '' }));
    }
    head.append(headings, filters);
    tableElement.append(head);
    return tableElement;
  }

  function appendColumnHeaders(headings, filters, state, column, pinnedLayouts) {
    const pinned = state.pinnedColumns.has(column.name);
    const width = state.columnWidths[column.name];
    const marker = state.sortColumn === column.name ? (state.sortDirection === 'asc' ? ' ▲' : ' ▼') : '';
    const headingStyle = pinned ? getPinnedCellStyle({ columnLayout: pinnedLayouts[column.name], zIndex: 45 }) : getGridColumnStyle({ columnWidth: width });
    headings.append(createElement('th', { className: pinned ? 'pinned' : '', style: headingStyle, children: [
      createElement('div', { className: 'column-header', title: columnTitle(column), children: [
        createElement('button', { className: 'column-sort-button', attributes: { type: 'button', 'data-sort-column': column.name }, children: [createElement('span', { className: 'column-name', text: `${column.name}${marker}` })] }),
        createElement('span', { className: 'column-badges', children: [
          ...columnBadges(column),
          createElement('button', { className: `pin-button${pinned ? ' pinned' : ''}`, text: '📌', title: pinned ? 'Unpin column' : 'Pin column to left', attributes: { type: 'button', 'data-pin-column': column.name } }),
        ] }),
      ] }),
      createElement('div', { className: 'col-resize-handle', attributes: { 'data-resize-column': column.name } }),
    ] }));
    const filterStyle = pinned ? getPinnedCellStyle({ columnLayout: pinnedLayouts[column.name], zIndex: 42 }) : getGridColumnStyle({ columnWidth: width });
    filters.append(createElement('th', { className: pinned ? 'pinned' : '', style: filterStyle, children: [
      createElement('input', { className: 'column-filter-input', attributes: { type: 'search', placeholder: 'Filter', value: state.columnFilters[column.name] ?? '', 'data-column-filter': column.name } }),
    ] }));
  }

  function buildRow(state, rowPlan, pinnedLayouts, rowNumberStyle, retainedBlobKeys) {
    const { rowIndex, realRowIndex, isPinned } = rowPlan;
    const row = state.visibleRows[rowIndex];
    const selectedForBatch = state.selectedRowKeys.has(getRowSelectionKey(row.identity));
    const pinnedOffset = isPinned ? getPinnedRowOffset({ pinnedIndex: rowPlan.pinnedIndex }) : undefined;
    const element = createElement('tr', { className: [
      state.selectedRow === rowIndex ? 'selected-row' : '', selectedForBatch ? 'multi-selected-row' : '', isPinned ? 'pinned-row' : '',
    ].filter(Boolean).join(' '), attributes: { 'data-row': String(rowIndex) } });
    element.append(buildRowNumber(rowIndex, realRowIndex, isPinned, selectedForBatch, pinnedOffset, rowNumberStyle));
    for (const column of state.table.columns) element.append(buildCell(state, row, rowIndex, column, isPinned, pinnedOffset, pinnedLayouts, retainedBlobKeys));
    const actions = getRowActions({ tableType: state.table.type, rowIndex });
    if (actions.length > 0) element.append(buildRowActions(actions, isPinned, pinnedOffset));
    return element;
  }

  function buildRowNumber(rowIndex, realRowIndex, pinned, selected, offset, style) {
    return createElement('td', { className: ['row-number-cell', pinned ? 'pinned-row-cell' : ''].filter(Boolean).join(' '),
      style: getPinnedCellStyle({ columnLayout: { style }, rowOffset: pinned ? offset : undefined, zIndex: pinned ? 20 : undefined }), children: [
        createElement('div', { className: 'row-number-content', children: [
          createElement('input', { className: 'row-select-checkbox', title: selected ? 'Deselect row' : 'Select row', attributes: { type: 'checkbox', 'data-select-row': String(rowIndex), checked: selected ? 'true' : undefined, 'aria-label': `Select row ${realRowIndex + 1}` } }),
          createElement('span', { className: 'row-number-text', text: String(realRowIndex + 1) }),
          createElement('button', { className: `row-pin-button${pinned ? ' pinned' : ''}`, title: pinned ? 'Unpin row' : 'Pin row to top', attributes: { type: 'button', 'data-pin-row': String(rowIndex), 'aria-label': `${pinned ? 'Unpin' : 'Pin'} row ${realRowIndex + 1}` }, children: [createElement('span', { className: `row-pin-icon${pinned ? ' pinned' : ''}`, text: '📌' })] }),
        ] }),
      ] });
  }

  function buildCell(state, row, rowIndex, column, rowPinned, rowOffset, pinnedLayouts, retainedBlobKeys) {
    const value = row.values[column.name];
    const interaction = getCellInteraction({ tableType: state.table.type, column, value });
    const pinned = state.pinnedColumns.has(column.name);
    const image = isImageBlob(value);
    let content;
    if (image) {
      const url = blobUrls.get(value) ?? blobToObjectURL(value);
      blobUrls.set(value, url); retainedBlobKeys.add(value);
      content = createElement('img', { className: 'blob-image-inline', attributes: { src: url, alt: describeBlob(value), title: describeBlob(value) } });
    }
    const button = createElement('button', { className: 'cell-button', text: image ? undefined : value instanceof Uint8Array ? describeBlob(value) : describeValue(value), title: interaction.title,
      attributes: { type: 'button', 'data-cell-row': String(rowIndex), 'data-cell-column': column.name, disabled: interaction.disabled ? 'true' : undefined }, children: content ? [content] : undefined });
    const layout = pinned ? pinnedLayouts[column.name] : { style: getGridColumnStyle({ columnWidth: state.columnWidths[column.name] }) };
    return createElement('td', { className: [
      value == null ? 'null-cell' : '', interaction.disabled ? '' : 'editable-cell', pinned ? 'pinned' : '', rowPinned ? 'pinned-row-cell' : '', image ? 'blob-image-cell' : '',
      state.selectedCell?.rowIndex === rowIndex && state.selectedCell?.columnName === column.name ? 'selected-cell' : '',
    ].filter(Boolean).join(' '), style: getPinnedCellStyle({ columnLayout: layout, rowOffset: rowPinned ? rowOffset : undefined, zIndex: rowPinned && pinned ? 20 : rowPinned ? 8 : pinned ? 5 : undefined }),
    attributes: { 'data-grid-cell-row': String(rowIndex), 'data-grid-cell-column': column.name }, children: [button] });
  }

  function buildRowActions(actions, pinned, offset) {
    return createElement('td', { className: ['row-actions-cell', pinned ? 'pinned-row-cell' : ''].filter(Boolean).join(' '),
      style: getPinnedCellStyle({ rowOffset: pinned ? offset : undefined, zIndex: pinned ? 8 : undefined }), children: [
        createElement('div', { className: 'row-action-group', children: actions.map((action) => createElement('button', {
          className: action.action === 'delete-row' ? 'row-action-button danger' : 'row-action-button', text: action.action === 'delete-row' ? 'Delete' : 'Edit', title: action.label,
          attributes: { type: 'button', 'data-action': action.action, 'data-action-row': String(action.rowIndex), disabled: action.disabled ? 'true' : undefined },
        })) }),
      ] });
  }

  function createEmptyRow(table, columnCount) {
    const kind = getGridEmptyStateKind({ tableType: table.type, columnCount: table.columns.length, rowCount: 0 });
    let content;
    if (kind === 'view-no-columns') content = createElement('div', { className: 'empty-state', text: 'This view has no columns.' });
    else if (kind === 'view-no-rows') content = createElement('div', { className: 'empty-state', text: 'No rows to show.' });
    else {
      const noColumns = kind === 'table-no-columns';
      content = createElement('div', { className: 'empty-state grid-empty-state', children: [
        createElement('div', { className: 'empty-state-title', text: noColumns ? 'This table has no columns yet.' : 'No rows yet.' }),
        createElement('div', { className: 'empty-state-description', text: noColumns ? 'Add a column to start entering data.' : 'Insert a row or add another column to this table.' }),
        createElement('div', { className: 'empty-state-actions', children: [
          ...(noColumns ? [] : [createElement('button', { className: 'toolbar-button primary', text: 'New row', attributes: { type: 'button', 'data-action': 'add-row' } })]),
          createElement('button', { className: noColumns ? 'toolbar-button primary' : 'toolbar-button', text: 'Add column', attributes: { type: 'button', 'data-action': 'add-column' } }),
        ] }),
      ] });
    }
    return createElement('tr', { children: [createElement('td', { className: 'grid-empty-cell', attributes: { colspan: String(columnCount) }, children: [content] })] });
  }

  function evictBlobUrls(retained) {
    for (const key of getEvictedGridResources(blobUrls.keys(), retained)) {
      URL.revokeObjectURL(blobUrls.get(key)); blobUrls.delete(key);
    }
  }

  function syncSelectAll(state, count) {
    const checkbox = elements.grid.querySelector('[data-select-all-rows]');
    if (!checkbox) return;
    checkbox.checked = state.checked; checkbox.indeterminate = state.indeterminate; checkbox.disabled = count === 0;
    checkbox.title = state.checked ? 'Deselect visible rows' : 'Select visible rows';
  }

  return { clearResources, rememberWidths, render, schedule };
}

function columnBadges(column) {
  return getBadgeItems(column).map((badge) => createElement('span', {
    className: badge.className,
    title: badge.title,
    children: [
      ...(badge.icon ? [createElement('span', { className: 'column-badge-icon', text: badge.icon })] : []),
      createElement('span', { text: badge.label }),
    ],
  }));
}

function getBadgeItems(column) {
  const badges = [];
  if (column.keyKind) {
    const primary = column.keyKind.startsWith('PK');
    badges.push({
      label: primary ? 'PK' : 'FK',
      className: primary ? 'column-badge column-badge-pk' : 'column-badge column-badge-fk',
      icon: primary ? '🔑' : '🔗',
      title: column.primaryKeyOrder ? `Primary key (${column.primaryKeyOrder})` : column.foreignKeyTarget ? `Foreign key → ${column.foreignKeyTarget}` : column.keyKind,
    });
  } else if (column.indexed) {
    badges.push({ label: 'IDX', className: 'column-badge column-badge-idx', icon: '⚡', title: 'Indexed' });
  }
  if (column.generated) badges.push({ label: 'GEN', className: 'column-badge column-badge-generated', icon: null, title: `${column.generated === 'stored' ? 'Stored' : 'Virtual'} generated column · read-only` });
  badges.push({ label: getTypeIcon(column.affinity || column.type?.[0] || '?'), className: 'column-badge column-badge-type', icon: null, title: column.type || column.affinity || 'ANY' });
  return badges;
}

function getTypeIcon(affinity) {
  switch (String(affinity).toUpperCase()) {
    case 'INTEGER': case 'I': return '#';
    case 'REAL': case 'R': return '±';
    case 'TEXT': case 'T': return 'Aa';
    case 'BLOB': case 'B': return '●';
    default: return '?';
  }
}

function columnTitle(column) {
  return [column.type || 'ANY', column.primaryKeyOrder ? `Primary key (order ${column.primaryKeyOrder})` : null,
    column.generated ? `${column.generated === 'stored' ? 'Stored' : 'Virtual'} generated column · read-only` : null,
    column.foreignKeyTarget ? `Foreign key → ${column.foreignKeyTarget}` : null, column.indexed ? 'Indexed' : null,
    column.nullable ? 'Nullable' : 'Not null', column.defaultValue !== undefined ? `Default: ${column.defaultValue}` : null,
  ].filter(Boolean).join(' · ');
}
