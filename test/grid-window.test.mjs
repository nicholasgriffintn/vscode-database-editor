import assert from 'node:assert/strict';
import test from 'node:test';

import { getEvictedGridResources, getGridRenderPlan, getGridWindow } from '../media/grid/window.mjs';

test('50k logical rows retain a bounded bidirectional window with stable spacer geometry', () => {
  const middle = getGridWindow({
    rowCount: 50_000,
    scrollTop: 25_000 * 38,
    viewportHeight: 760,
    rowHeight: 38,
    overscan: 6,
    pinnedIndexes: new Set([2, 40_000]),
  });

  assert.ok(middle.rowIndexes.length <= 32);
  assert.deepEqual(middle.pinnedRowIndexes, [2, 40_000]);
  assert.equal(middle.rowIndexes.includes(2), false);
  assert.equal(middle.rowIndexes.includes(40_000), false);
  assert.equal(middle.topSpacerHeight + middle.bottomSpacerHeight
    + (middle.rowIndexes.length * 38) + (middle.pinnedRowIndexes.length * 38), 50_000 * 38);
  assert.ok(middle.rowIndexes[0] < 25_000);
  assert.ok(middle.rowIndexes.at(-1) > 25_000);

  const upward = getGridWindow({
    rowCount: 50_000,
    scrollTop: 10_000 * 38,
    viewportHeight: 760,
    rowHeight: 38,
    overscan: 6,
    pinnedIndexes: new Set([2, 40_000]),
  });
  assert.ok(upward.rowIndexes[0] < middle.rowIndexes[0]);
  assert.equal(upward.topSpacerHeight + upward.bottomSpacerHeight
    + (upward.rowIndexes.length * 38) + (upward.pinnedRowIndexes.length * 38), 50_000 * 38);
});

test('grid resource eviction keeps retained BLOB URLs and removes only evicted rows', () => {
  const retained = { row: 2 };
  const evicted = { row: 1 };
  assert.deepEqual(
    getEvictedGridResources(new Set([evicted, retained]), new Set([retained])),
    [evicted],
  );
});

test('grid render plans keep absolute pins separate from window positions', () => {
  const plan = getGridRenderPlan({
    rowCount: 100,
    rowOffset: 500,
    scrollTop: 40 * 38,
    viewportHeight: 380,
    pinnedRows: new Set([499, 502, 550, 700]),
    overscan: 2,
  });

  assert.deepEqual(plan.visiblePinnedRows, [502, 550]);
  assert.deepEqual(plan.rows.slice(0, 2), [
    { rowIndex: 2, realRowIndex: 502, isPinned: true, pinnedIndex: 0 },
    { rowIndex: 50, realRowIndex: 550, isPinned: true, pinnedIndex: 1 },
  ]);
  assert.equal(new Set(plan.rows.map((row) => row.rowIndex)).size, plan.rows.length);
  assert.equal(plan.rows.some((row) => row.realRowIndex < 500 || row.realRowIndex >= 600), false);
});
