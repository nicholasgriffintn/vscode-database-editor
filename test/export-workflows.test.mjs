import assert from 'node:assert/strict';
import test from 'node:test';

import { createSqlExportRequest } from '../media/export-workflows.mjs';

test('SQL export requests are revision-bound and filesystem-safe', () => {
  assert.deepEqual(createSqlExportRequest({
    databaseName: 'reports/July: final.sqlite',
    revision: 7,
    requestId: 'sql-export-1',
  }), {
    type: 'exportSql',
    fileName: 'reports-July-final.sqlite.sql',
    revision: 7,
    requestId: 'sql-export-1',
  });
});
