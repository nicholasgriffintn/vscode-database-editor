import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSqlExportState,
  getSqlExportUiState,
  transitionSqlExport,
} from '../media/dialogs/export-workflow.mjs';

test('SQL export requests are revision-bound and filesystem-safe', () => {
  const started = transitionSqlExport(createSqlExportState(), {
    type: 'start',
    databaseName: 'reports/July: final.sqlite',
    revision: 7,
  });
  assert.deepEqual(started.message, {
    type: 'exportSql',
    fileName: 'reports-July-final.sqlite.sql',
    revision: 7,
    requestId: 'sql-export-1',
  });
  assert.deepEqual(getSqlExportUiState(started.state, { hasTables: true }), {
    disabled: true,
    label: 'Exporting SQL…',
  });

  const ignored = transitionSqlExport(started.state, {
    type: 'finish',
    requestId: 'stale-export',
    status: 'failed',
    message: 'stale failure',
  });
  assert.equal(ignored.handled, false);
  assert.deepEqual(ignored.state, started.state);

  const finished = transitionSqlExport(started.state, {
    type: 'finish',
    requestId: 'sql-export-1',
    status: 'failed',
    message: 'disk full',
  });
  assert.equal(finished.handled, true);
  assert.equal(finished.statusMessage, 'SQL export failed: disk full');
  assert.deepEqual(getSqlExportUiState(finished.state, { hasTables: true }), {
    disabled: false,
    label: 'Export SQL',
  });
});
