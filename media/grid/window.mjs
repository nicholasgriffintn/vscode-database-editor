export const DEFAULT_GRID_ROW_HEIGHT = 38;
export const DEFAULT_GRID_OVERSCAN = 8;

export function getGridWindow({
  rowCount,
  scrollTop,
  viewportHeight,
  rowHeight = DEFAULT_GRID_ROW_HEIGHT,
  overscan = DEFAULT_GRID_OVERSCAN,
  pinnedIndexes = new Set(),
}) {
  const normalizedRowCount = Math.max(0, Math.floor(Number(rowCount) || 0));
  const normalizedRowHeight = Math.max(1, Number(rowHeight) || DEFAULT_GRID_ROW_HEIGHT);
  const normalizedOverscan = Math.max(0, Math.floor(Number(overscan) || 0));
  const pinnedRowIndexes = [...pinnedIndexes]
    .filter((index) => Number.isInteger(index) && index >= 0 && index < normalizedRowCount)
    .sort((left, right) => left - right);
  const unpinnedCount = normalizedRowCount - pinnedRowIndexes.length;

  const normalizedViewportHeight = Math.max(0, Number(viewportHeight) || 0);
  const clampedScrollTop = Math.min(
    Math.max(0, Number(scrollTop) || 0),
    Math.max(0, unpinnedCount * normalizedRowHeight - normalizedViewportHeight) + pinnedRowIndexes.length * normalizedRowHeight,
  );

  const pinnedHeight = pinnedRowIndexes.length * normalizedRowHeight;
  const unpinnedScrollTop = Math.max(0, clampedScrollTop - pinnedHeight);
  const firstVisibleOrdinal = Math.floor(unpinnedScrollTop / normalizedRowHeight);
  const visibleCount = Math.max(1, Math.ceil((Number(viewportHeight) || 0) / normalizedRowHeight));
  const startOrdinal = Math.max(0, firstVisibleOrdinal - normalizedOverscan);
  const endOrdinal = Math.min(
    unpinnedCount,
    firstVisibleOrdinal + visibleCount + normalizedOverscan,
  );
  const rowIndexes = [];
  for (let ordinal = startOrdinal; ordinal < endOrdinal; ordinal += 1) {
    rowIndexes.push(getOriginalIndex(ordinal, pinnedRowIndexes));
  }

  return {
    rowIndexes,
    pinnedRowIndexes,
    topSpacerHeight: startOrdinal * normalizedRowHeight,
    bottomSpacerHeight: (unpinnedCount - endOrdinal) * normalizedRowHeight,
    rowHeight: normalizedRowHeight,
  };
}

export function getEvictedGridResources(currentResources, retainedResources) {
  return [...currentResources].filter((resource) => !retainedResources.has(resource));
}

export function getGridRenderPlan({
  rowCount,
  rowOffset = 0,
  scrollTop,
  viewportHeight,
  rowHeight,
  overscan,
  pinnedRows = new Set(),
}) {
  const normalizedRowCount = Math.max(0, Math.floor(Number(rowCount) || 0));
  const normalizedRowOffset = Math.max(0, Math.floor(Number(rowOffset) || 0));
  const rowEnd = normalizedRowOffset + normalizedRowCount;
  const visiblePinnedRows = [...pinnedRows]
    .filter((rowIndex) => rowIndex >= normalizedRowOffset && rowIndex < rowEnd)
    .sort((left, right) => left - right);
  const pinnedIndexes = new Set(visiblePinnedRows.map((rowIndex) => rowIndex - normalizedRowOffset));
  const window = getGridWindow({
    rowCount: normalizedRowCount,
    scrollTop,
    viewportHeight,
    rowHeight,
    overscan,
    pinnedIndexes,
  });
  const pinnedOrder = new Map(window.pinnedRowIndexes.map((rowIndex, index) => [rowIndex, index]));
  const renderedIndexes = [...window.pinnedRowIndexes, ...window.rowIndexes];

  return {
    ...window,
    visiblePinnedRows,
    rows: renderedIndexes.map((rowIndex) => ({
      rowIndex,
      realRowIndex: normalizedRowOffset + rowIndex,
      isPinned: pinnedIndexes.has(rowIndex),
      pinnedIndex: pinnedOrder.get(rowIndex),
    })),
  };
}

function getOriginalIndex(unpinnedOrdinal, pinnedIndexes) {
  let index = unpinnedOrdinal;
  for (const pinnedIndex of pinnedIndexes) {
    if (pinnedIndex > index) {
      break;
    }
    index += 1;
  }
  return index;
}
