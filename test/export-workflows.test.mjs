import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createExportWorkflow,
  createSqlExportState,
  getSqlExportUiState,
  transitionSqlExport,
} from '../media/dialogs/export-workflow.mjs';

test('export workflow coordinates visible CSV and revision-bound SQL requests', () => {
  const messages = [];
  const state = {
    hasDatabase: true,
    databaseName: 'reports.sqlite',
    table: { name: 'people', columns: [{ name: 'id' }, { name: 'name' }] },
    visibleRows: [{ values: { id: 1, name: 'Ada' } }],
    revision: 3,
    hasTables: true,
  };
  let renders = 0;
  const workflow = createExportWorkflow({
    vscode: { postMessage: (message) => messages.push(message) },
    getState: () => state,
    setStatus: () => {},
    onStateChanged: () => { renders += 1; },
  });

  workflow.exportCsv();
  workflow.exportSql();

  assert.equal(messages[0].type, 'saveText');
  assert.equal(messages[0].content, 'id,name\n1,Ada\n');
  assert.deepEqual(messages[1], {
    type: 'exportSql',
    fileName: 'reports.sqlite.sql',
    revision: 3,
    requestId: 'sql-export-1',
  });
  assert.equal(workflow.getUiState().label, 'Exporting SQL…');
  assert.equal(renders, 1);
});

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
