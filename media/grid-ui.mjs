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

export function getPagerState({ page, pageSize, totalRows }) {
  const pageCount = Math.max(1, Math.ceil(totalRows / pageSize));
  return {
    label: `Page ${page} of ${pageCount} · ${totalRows} rows`,
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
