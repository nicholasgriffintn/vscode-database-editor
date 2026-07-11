import assert from 'node:assert/strict';
import test from 'node:test';

import { getEvictedGridResources, getGridWindow } from '../media/grid-window.mjs';

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
