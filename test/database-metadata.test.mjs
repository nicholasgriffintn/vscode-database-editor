import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRowCountCache,
  createRowCountFilterKey,
  formatRowCount,
  getUnknownCountRowWindow,
  resolveUnknownCountRows,
} from '../media/database-metadata.mjs';

test('row counts are cached by database revision, object, and filter', () => {
  const cache = createRowCountCache();
  let loads = 0;
  const load = () => ++loads * 10;

  assert.equal(cache.get({ revision: 2, objectName: 'people', filterKey: '', load }), 10);
  assert.equal(cache.get({ revision: 2, objectName: 'people', filterKey: '', load }), 10);
  assert.equal(cache.get({ revision: 2, objectName: 'people', filterKey: 'ada', load }), 20);
  assert.equal(cache.get({ revision: 3, objectName: 'people', filterKey: '', load }), 30);
  assert.equal(loads, 3);
});

test('count cache invalidates only the requested object within a revision', () => {
  const cache = createRowCountCache();
  let peopleLoads = 0;
  let teamLoads = 0;
  const people = () => cache.get({ revision: 4, objectName: 'people', load: () => ++peopleLoads });
  const teams = () => cache.get({ revision: 4, objectName: 'teams', load: () => ++teamLoads });

  people();
  teams();
  cache.invalidateObject('people');

  assert.equal(people(), 2);
  assert.equal(teams(), 1);
  assert.deepEqual({ peopleLoads, teamLoads }, { peopleLoads: 2, teamLoads: 1 });
});

test('count filter keys are stable and unknown counts have honest labels', () => {
  assert.equal(
    createRowCountFilterKey(' Ada ', { team: ' Core ', empty: '', name: 'Ada' }),
    createRowCountFilterKey('Ada', { name: 'Ada', team: 'Core' }),
  );
  assert.equal(formatRowCount(null), 'Rows not counted');
  assert.equal(formatRowCount(null, { loading: true }), 'Loading rows…');
  assert.equal(formatRowCount(1), '1 row');
  assert.equal(formatRowCount(2), '2 rows');
});

test('unknown-count views use a limit-plus-one window without exact counts', () => {
  assert.deepEqual(getUnknownCountRowWindow({
    page: 3,
    pageSize: 10,
    autoPagination: false,
    loadedRows: 0,
    maxRows: 0,
  }), { offset: 20, limit: 11, retainedLimit: 10 });
  assert.deepEqual(resolveUnknownCountRows(Array.from({ length: 11 }, (_, index) => index), {
    offset: 20,
    retainedLimit: 10,
  }), {
    rows: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    totalRows: 31,
    hasMore: true,
  });
  assert.deepEqual(resolveUnknownCountRows([0, 1], { offset: 20, retainedLimit: 10 }), {
    rows: [0, 1],
    totalRows: 22,
    hasMore: false,
  });
});
