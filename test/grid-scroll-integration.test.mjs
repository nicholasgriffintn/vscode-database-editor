import assert from 'node:assert/strict';
import test from 'node:test';

import { getInfiniteRowWindow, getInfiniteScrollState, getPagerState } from '../media/grid/ui.mjs';
import { DEFAULT_GRID_ROW_HEIGHT, getGridWindow } from '../media/grid/window.mjs';

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attributes = new Map();
    this.children = [];
    this.className = '';
    this.style = {
      declarations: new Map(),
      setProperty: (property, value) => this.style.declarations.set(property, value),
    };
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  replaceChildren(...children) {
    this.children = children;
  }
}

globalThis.document = {
  createElement: (tagName) => new FakeElement(tagName),
};

const { createGridWindowSpacer } = await import('../media/grid/window-view.mjs');

test('virtual grid scroll loads one chunk at the bottom and reports retained rows', () => {
  const viewportHeight = 760;
  const totalRows = 3_000;
  const pageSize = 500;
  const initialLoadedRows = 500;
  const initialWindow = getGridWindow({
    rowCount: initialLoadedRows,
    scrollTop: 0,
    viewportHeight,
  });
  const initialScrollHeight = getRenderedWindowHeight(initialWindow);

  assert.equal(initialScrollHeight, initialLoadedRows * DEFAULT_GRID_ROW_HEIGHT);
  assert.equal(getInfiniteScrollState({
    autoPagination: true,
    loadedRows: initialLoadedRows,
    totalRows,
    scrollTop: 0,
    clientHeight: viewportHeight,
    scrollHeight: initialScrollHeight,
  }).shouldLoadMore, false, 'the initial render must not eagerly load every chunk');
  assert.equal(getPagerState({
    autoPagination: true,
    loadedRows: initialLoadedRows,
    filteredRows: totalRows,
    totalRows,
  }).label, 'Rows 1-500 of 3000');

  const bottomScrollTop = initialScrollHeight - viewportHeight;
  assert.equal(getInfiniteScrollState({
    autoPagination: true,
    loadedRows: initialLoadedRows,
    totalRows,
    scrollTop: bottomScrollTop,
    clientHeight: viewportHeight,
    scrollHeight: initialScrollHeight,
  }).shouldLoadMore, true);

  const nextChunk = getInfiniteRowWindow({ loadedRows: initialLoadedRows, pageSize, totalRows });
  const nextLoadedRows = initialLoadedRows + nextChunk.limit;
  const expandedWindow = getGridWindow({
    rowCount: nextLoadedRows,
    scrollTop: bottomScrollTop,
    viewportHeight,
  });
  const expandedScrollHeight = getRenderedWindowHeight(expandedWindow);

  assert.equal(expandedScrollHeight, nextLoadedRows * DEFAULT_GRID_ROW_HEIGHT);
  assert.equal(getInfiniteScrollState({
    autoPagination: true,
    loadedRows: nextLoadedRows,
    totalRows,
    scrollTop: bottomScrollTop,
    clientHeight: viewportHeight,
    scrollHeight: expandedScrollHeight,
  }).shouldLoadMore, false, 'the expanded grid must wait for the next user scroll');
  assert.equal(getPagerState({
    autoPagination: true,
    loadedRows: nextLoadedRows,
    filteredRows: totalRows,
    totalRows,
  }).label, 'Rows 1-1000 of 3000');
});

test('grid render window clamps stale scroll positions after data refresh', () => {
  const viewportHeight = 760;
  const shortTableRows = 4;

  const refreshedWindow = getGridWindow({
    rowCount: shortTableRows,
    scrollTop: 2000 * DEFAULT_GRID_ROW_HEIGHT,
    viewportHeight,
  });

  assert.equal(refreshedWindow.rowIndexes.at(0), 0);
  assert.equal(refreshedWindow.rowIndexes.at(-1), shortTableRows - 1);
  assert.equal(refreshedWindow.topSpacerHeight, 0);
  assert.equal(refreshedWindow.bottomSpacerHeight, 0);
});

function getRenderedWindowHeight(gridWindow) {
  const spacerHeights = [gridWindow.topSpacerHeight, gridWindow.bottomSpacerHeight]
    .filter((height) => height > 0)
    .map((height) => createGridWindowSpacer({ columnCount: 4, height }))
    .map((spacer) => Number.parseFloat(spacer.children[0].style.declarations.get('height')));
  return spacerHeights.reduce((total, height) => total + height, 0)
    + ((gridWindow.rowIndexes.length + gridWindow.pinnedRowIndexes.length) * gridWindow.rowHeight);
}
