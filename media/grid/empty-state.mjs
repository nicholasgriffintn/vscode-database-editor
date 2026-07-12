export function getGridEmptyStateKind({ tableType, columnCount, rowCount }) {
  if (rowCount > 0) {
    return 'none';
  }

  if (tableType !== 'table') {
    return columnCount === 0 ? 'view-no-columns' : 'view-no-rows';
  }

  return columnCount === 0 ? 'table-no-columns' : 'table-no-rows';
}

export function getGridColumnCount({ columnCount, tableType }) {
  const actionsColumn = tableType === 'table' ? 1 : 0;
  const rowNumberColumn = 1;
  return Math.max(columnCount + actionsColumn + rowNumberColumn, 2);
}
