export function getCellInteraction({ tableType, value }) {
  if (tableType === 'view') {
    return {
      disabled: true,
      title: 'Views are read-only',
    };
  }

  if (value instanceof Uint8Array) {
    return {
      disabled: true,
      title: 'BLOB values cannot be edited inline',
    };
  }

  return {
    disabled: false,
    title: 'Click to select · double-click to edit · Ctrl/Cmd+C to copy',
  };
}

export function getRowActions({ tableType, rowIndex }) {
  if (tableType !== 'table') {
    return [];
  }

  return [
    {
      action: 'edit-row',
      label: 'Edit row',
      rowIndex,
      disabled: false,
    },
    {
      action: 'delete-row',
      label: 'Delete row',
      rowIndex,
      disabled: false,
    },
  ];
}

export function getPagerState({ page, pageSize, filteredRows, totalRows }) {
  const visibleRows = filteredRows ?? totalRows;
  const pageCount = Math.max(1, Math.ceil(visibleRows / pageSize));
  const firstVisible = visibleRows === 0 ? 0 : ((page - 1) * pageSize) + 1;
  const lastVisible = Math.min(page * pageSize, visibleRows);
  return {
    label: totalRows === visibleRows
      ? `Rows ${firstVisible}-${lastVisible} of ${visibleRows}`
      : `Rows ${firstVisible}-${lastVisible} of ${visibleRows} filtered · ${totalRows} total`,
    canGoPrevious: page > 1,
    canGoNext: page < pageCount,
  };
}

export function getRefreshButtonState({ target, hasDatabase, hasActiveTable }) {
  if (target === 'objects') {
    return { disabled: !hasDatabase };
  }

  if (target === 'table-data') {
    return { disabled: !hasDatabase || !hasActiveTable };
  }

  return { disabled: true };
}

export function shouldKeepKeyboardShortcutInField({ key, metaKey, ctrlKey, shiftKey, targetTagName }) {
  return getTextEditingShortcutAction({ key, metaKey, ctrlKey, shiftKey, targetTagName }) !== null;
}

export function getCopilotSelectionContext({
  table,
  filter,
  columnFilters,
  sortColumn,
  sortDirection,
  selectedColumns,
  selectedRowCount = 0,
  selectedRowNumbers = [],
}) {
  const activeColumnFilters = Object.fromEntries(
    Object.entries(columnFilters ?? {}).filter(([, value]) => value !== ''),
  );
  const rowCount = Number(selectedRowCount);
  const rowNumbers = Array.isArray(selectedRowNumbers)
    ? selectedRowNumbers.filter((value) => Number.isInteger(value) && value > 0)
    : [];
  return {
    ...(table ? { objectName: table.name, objectType: table.type } : {}),
    ...(filter ? { filter } : {}),
    ...(Object.keys(activeColumnFilters).length > 0 ? { columnFilters: activeColumnFilters } : {}),
    ...(sortColumn ? { sortColumn, sortDirection } : {}),
    ...(selectedColumns?.length ? { selectedColumns: [...new Set(selectedColumns)] } : {}),
    ...(rowCount > 0 ? {
      selectedRowCount: rowCount,
      selectedRowNumbers: rowNumbers,
      selectedRowScope: 'visibleRows',
    } : {}),
  };
}

export function getTextEditingShortcutAction({ key, metaKey = false, ctrlKey = false, shiftKey = false, targetTagName }) {
  if (!metaKey && !ctrlKey) {
    return null;
  }

  const tag = String(targetTagName ?? '').toLowerCase();
  if (tag !== 'input' && tag !== 'textarea') {
    return null;
  }

  switch (String(key).toLowerCase()) {
    case 'a':
      return 'selectAll';
    case 'c':
      return 'copy';
    case 'x':
      return 'cut';
    case 'v':
      return 'paste';
    case 'z':
      return shiftKey ? 'nativeRedo' : 'nativeUndo';
    case 'y':
      return 'nativeRedo';
    default:
      return null;
  }
}

export function getCellClipboardText(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (value instanceof Uint8Array) {
    return `[BLOB ${value.length} bytes]`;
  }
  return String(value);
}

export function getRowSelectionKey(identity) {
  if (identity?.rowid !== null && identity?.rowid !== undefined) {
    return `rowid:${String(identity.rowid)}`;
  }

  const entries = Object.entries(identity?.primaryKey ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, normalizeSelectionKeyValue(value)]);
  return `pk:${JSON.stringify(entries)}`;
}

export function getSelectedVisibleRows({ visibleRows, selectedRowKeys }) {
  return visibleRows.filter((row) => selectedRowKeys.has(getRowSelectionKey(row.identity)));
}

export function getSelectAllRowsState({ visibleRows, selectedRowKeys }) {
  const visibleCount = visibleRows.length;
  const selectedVisibleCount = getSelectedVisibleRows({ visibleRows, selectedRowKeys }).length;
  return {
    checked: visibleCount > 0 && selectedVisibleCount === visibleCount,
    indeterminate: selectedVisibleCount > 0 && selectedVisibleCount < visibleCount,
    selectedVisibleCount,
    visibleCount,
  };
}

export function getDeleteRowsConfirmationMessage(count) {
  const rowCount = Math.max(0, Number(count) || 0);
  return `Delete ${rowCount.toLocaleString()} selected ${rowCount === 1 ? 'row' : 'rows'}? This cannot be undone until you use VS Code Undo.`;
}

function normalizeSelectionKeyValue(value) {
  if (value instanceof Uint8Array) {
    return { type: 'blob', bytes: Array.from(value) };
  }
  if (typeof value === 'bigint') {
    return { type: 'bigint', value: String(value) };
  }
  return value;
}

export const ROW_NUMBER_COLUMN_WIDTH = 64;

export function getPinnedColumnLayout({
  columns,
  pinnedColumns,
  columnWidths = {},
  rowNumberWidth = ROW_NUMBER_COLUMN_WIDTH,
  fallbackWidth = 150,
}) {
  let left = rowNumberWidth;
  const layout = {};

  for (const column of columns) {
    const columnName = typeof column === 'string' ? column : column.name;
    if (!pinnedColumns.has(columnName)) {
      continue;
    }

    const configuredWidth = Number(columnWidths[columnName]);
    const width = Number.isFinite(configuredWidth) && configuredWidth > 0
      ? configuredWidth
      : fallbackWidth;
    layout[columnName] = {
      left,
      width,
      style: `width:${width}px;min-width:${width}px;max-width:${width}px;left:${left}px;z-index:5`,
    };
    left += width;
  }

  return layout;
}

export const DEFAULT_GRID_COLUMN_MAX_WIDTH = 'min(360px, 30vw)';

export function getGridColumnStyle({ columnWidth, maxWidth = DEFAULT_GRID_COLUMN_MAX_WIDTH } = {}) {
  const configuredWidth = Number(columnWidth);
  if (Number.isFinite(configuredWidth) && configuredWidth > 0) {
    return `width:${configuredWidth}px;min-width:${configuredWidth}px;max-width:${configuredWidth}px`;
  }

  return `max-width:${maxWidth}`;
}

export function getPinnedRowOffset({
  realRowIndex,
  visiblePinnedRows,
  headerHeight = 56,
  filterHeight = 38,
  rowHeight = 29,
}) {
  const pinnedIndex = visiblePinnedRows.indexOf(realRowIndex);
  if (pinnedIndex === -1) {
    return undefined;
  }

  return headerHeight + filterHeight + (pinnedIndex * rowHeight);
}

export function getPinnedCellStyle({ columnLayout, rowOffset, zIndex }) {
  const declarations = [];
  if (columnLayout?.style) {
    declarations.push(...columnLayout.style
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part && !part.startsWith('z-index:')));
  }
  if (rowOffset !== undefined) {
    declarations.push(`top:${rowOffset}px`);
  }
  if (zIndex !== undefined) {
    declarations.push(`z-index:${zIndex}`);
  }
  return declarations.length > 0 ? declarations.join(';') : undefined;
}

export function getObjectItemInteraction({ objectType, objectName, tableName }) {
  const isBrowsable = objectType === 'table' || objectType === 'view';
  if (isBrowsable) {
    return { browsable: true, title: undefined };
  }

  return {
    browsable: false,
    title: `${objectName} is not directly browsable · defined on ${tableName}`,
  };
}
