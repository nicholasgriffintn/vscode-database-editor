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
