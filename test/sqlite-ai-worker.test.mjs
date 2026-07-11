import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import initSqlJs from 'sql.js';

import { runSqlWorkerRequest } from '../dist/sqlite-ai/sql-worker-client.js';

const SQL = await initSqlJs({
  locateFile: (file) => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file),
});

test('worker timeout terminates a query blocked inside its first SQLite step', async () => {
  const database = new SQL.Database();
  const bytes = database.export();
  database.close();
  const startedAt = Date.now();

  await assert.rejects(
    runSqlWorkerRequest({
      extensionPath: process.cwd(),
      timeoutMs: 250,
      request: {
        operation: 'query',
        database: bytes,
        query: `WITH RECURSIVE sequence(value) AS (
          VALUES(1) UNION ALL SELECT value + 1 FROM sequence WHERE value < 1000000000
        ) SELECT sum(value) AS total FROM sequence`,
        rowLimit: 10,
        sensitiveColumnPatterns: [],
      },
    }),
    /timed out after 250 ms/i,
  );
  assert.ok(Date.now() - startedAt < 1_000, 'worker termination should enforce a hard wall-clock bound');
});

test('failed worker initialization does not poison the next request', async () => {
  const database = new SQL.Database();
  const bytes = database.export();
  database.close();
  const request = {
    operation: 'query',
    database: bytes,
    query: 'SELECT 1 AS value',
    rowLimit: 10,
    sensitiveColumnPatterns: [],
  };

  await assert.rejects(runSqlWorkerRequest({
    extensionPath: path.join(process.cwd(), 'missing-extension'),
    timeoutMs: 1_000,
    request,
  }), /cannot find module/i);

  const result = await runSqlWorkerRequest({
    extensionPath: process.cwd(),
    timeoutMs: 1_000,
    request,
  });
  assert.deepEqual(result.rows, [{ value: 1 }]);
});

test('worker independently rejects mutating query requests', async () => {
  const database = new SQL.Database();
  database.run('CREATE TABLE values_table (value INTEGER)');
  const bytes = database.export();
  database.close();

  await assert.rejects(runSqlWorkerRequest({
    extensionPath: process.cwd(),
    timeoutMs: 1_000,
    request: {
      operation: 'query',
      database: bytes,
      query: 'DELETE FROM values_table',
      rowLimit: 10,
      sensitiveColumnPatterns: [],
    },
  }), /only one read-only/i);
});
