import assert from 'node:assert/strict';
import test from 'node:test';

import {
  capRows,
  isAllowedModification,
  isReadOnlyQuery,
  isSingleStatement,
  jsonSafeValue,
} from '../dist/sqlite-ai/sql-safety.js';

test('host-side read-only guard accepts a single select or safe with query', () => {
  assert.equal(isReadOnlyQuery('SELECT * FROM people'), true);
  assert.equal(isReadOnlyQuery('/* inspect */ WITH visible AS (SELECT * FROM people) SELECT * FROM visible'), true);
  assert.equal(isReadOnlyQuery('-- comment\nSELECT 1'), true);
});

test('host-side read-only guard rejects mutating and multi-statement queries', () => {
  assert.equal(isReadOnlyQuery('PRAGMA table_info(users)'), false);
  assert.equal(isReadOnlyQuery('SELECT 1; SELECT 2'), false);
  assert.equal(isReadOnlyQuery('WITH deleted AS (DELETE FROM people RETURNING *) SELECT * FROM deleted'), false);
  assert.equal(isReadOnlyQuery('UPDATE people SET name = "Ada"'), false);
  assert.equal(isReadOnlyQuery('SELECT * FROM people; DROP TABLE people'), false);
});

test('host-side read-only guard ignores write words inside string literals', () => {
  assert.equal(isReadOnlyQuery("SELECT 'delete from people' AS text"), true);
  assert.equal(isReadOnlyQuery('SELECT "update users" AS text'), true);
});

test('single statement detection ignores trailing semicolons and quoted semicolons', () => {
  assert.equal(isSingleStatement("SELECT ';';"), true);
  assert.equal(isSingleStatement('SELECT 1; SELECT 2'), false);
});

test('modification guard allows one database-changing statement and rejects transaction wrappers', () => {
  assert.equal(isAllowedModification('INSERT INTO people (name) VALUES ("Ada")'), true);
  assert.equal(isAllowedModification('CREATE TABLE people (id INTEGER PRIMARY KEY)'), true);
  assert.equal(isAllowedModification('BEGIN; INSERT INTO people (name) VALUES ("Ada"); COMMIT;'), false);
  assert.equal(isAllowedModification('ROLLBACK'), false);
});

test('row capping reports truncation and converts values to JSON-safe shapes', () => {
  const blob = new Uint8Array([1, 2, 3]);
  const result = capRows([
    { id: 1, payload: blob, score: Number.POSITIVE_INFINITY },
    { id: 2, payload: null, score: 10n },
  ], 1);

  assert.deepEqual(result, {
    rows: [{ id: 1, payload: '[BLOB 3 bytes]', score: null }],
    truncated: true,
    rowCount: 2,
  });
  assert.equal(jsonSafeValue(undefined), null);
});
