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
    title: 'Open row details',
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

export function shouldKeepKeyboardShortcutInField({ key, metaKey, ctrlKey, targetTagName }) {
  if (!metaKey && !ctrlKey) {
    return false;
  }

  const tag = String(targetTagName ?? '').toLowerCase();
  if (tag !== 'input' && tag !== 'textarea') {
    return false;
  }

  return new Set(['z', 'y', 'a', 'x', 'c', 'v']).has(String(key).toLowerCase());
}

export function getPinnedColumnLayout({
  columns,
  pinnedColumns,
  columnWidths = {},
  rowNumberWidth = 52,
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
