import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import initSqlJs from 'sql.js';

import { executeSqlScript, executeSqlStatements } from '../media/sql-workspace.mjs';

async function createDatabase() {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file),
  });
  return new SQL.Database();
}

test('mutating RETURNING statements finish while retaining only the preview', async () => {
  const db = await createDatabase();
  db.run('CREATE TABLE numbers (value INTEGER)');
  const sql = `WITH RECURSIVE source(value) AS (
    VALUES(1) UNION ALL SELECT value + 1 FROM source WHERE value < 100
  ) INSERT INTO numbers SELECT value FROM source RETURNING value`;

  const [result] = executeSqlStatements(db, [sql], { previewLimit: 5 });

  assert.equal(result.values.length, 5);
  assert.equal(result.rowCount, 100);
  assert.equal(result.truncated, true);
  assert.equal(db.exec('SELECT COUNT(*) FROM numbers')[0].values[0][0], 100);
  db.close();
});

test('BLOB-heavy reads retain only capped result bytes', async () => {
  const db = await createDatabase();
  db.run('CREATE TABLE payloads (value BLOB)');
  const payload = new Uint8Array(64 * 1024).fill(7);
  for (let index = 0; index < 20; index += 1) {
    db.run('INSERT INTO payloads VALUES (?)', [payload]);
  }

  const [result] = executeSqlStatements(db, ['SELECT value FROM payloads'], { previewLimit: 2 });

  assert.equal(result.values.length, 2);
  assert.equal(result.values.reduce((total, row) => total + row[0].byteLength, 0), 128 * 1024);
  assert.equal(result.rowCount, 3);
  assert.equal(result.truncated, true);
  db.close();
});

test('stepped execution checks cancellation between rows', async () => {
  const db = await createDatabase();
  let checks = 0;
  const sql = `WITH RECURSIVE numbers(value) AS (
    VALUES(1) UNION ALL SELECT value + 1 FROM numbers WHERE value < 1000000
  ) SELECT value FROM numbers`;

  assert.throws(
    () => executeSqlStatements(db, [sql], { isCancelled: () => ++checks > 4 }),
    /cancelled/i,
  );
  assert.equal(checks, 5);
  db.close();
});

test('stepped execution enforces its time budget between rows', async () => {
  const db = await createDatabase();
  let now = 0;
  const sql = `WITH RECURSIVE numbers(value) AS (
    VALUES(1) UNION ALL SELECT value + 1 FROM numbers WHERE value < 1000000
  ) SELECT value FROM numbers`;

  assert.throws(
    () => executeSqlStatements(db, [sql], { timeoutMs: 2, now: () => now += 1 }),
    /timed out after 2 ms/i,
  );
  db.close();
});

test('SQLite parses trigger bodies when stepping multi-statement scripts', async () => {
  const db = await createDatabase();
  const sql = `
    CREATE TABLE source (value TEXT);
    CREATE TABLE audit (value TEXT);
    CREATE TRIGGER source_audit AFTER INSERT ON source BEGIN
      INSERT INTO audit VALUES (NEW.value);
      INSERT INTO audit VALUES (upper(NEW.value));
    END;
    INSERT INTO source VALUES ('Ada');
    SELECT value FROM audit ORDER BY rowid;
  `;

  const results = executeSqlScript(db, sql, { previewLimit: 10 });

  assert.deepEqual(results.at(-1).values, [['Ada'], ['ADA']]);
  db.close();
});
