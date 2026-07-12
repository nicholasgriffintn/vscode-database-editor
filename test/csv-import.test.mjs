import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';

import { importCsvRows, parseCsv, convertCsvValue } from '../media/csv-import.mjs';
import { queryAll } from '../media/sqlite-client.mjs';

test('parses BOM, CRLF, quoted commas, quotes, newlines, and empty fields', () => {
  assert.deepEqual(parseCsv('\uFEFFid,name,note,empty\r\n1,"Ada, A.","said ""hello""\nagain",\r\n').rows, [
    ['id', 'name', 'note', 'empty'],
    ['1', 'Ada, A.', 'said "hello"\nagain', ''],
  ]);
  assert.throws(() => parseCsv('id,name\n1,"broken'), /line 2.*unterminated/i);
});

test('conversion is explicit and supports NULL text without destructive guessing', () => {
  assert.equal(convertCsvValue('', { type: 'INTEGER' }, { convertTypes: false, nullText: 'NULL' }), '');
  assert.equal(convertCsvValue('NULL', { type: 'TEXT' }, { convertTypes: false, nullText: 'NULL' }), null);
  assert.equal(convertCsvValue('42', { type: 'INTEGER' }, { convertTypes: true }), 42);
  assert.equal(convertCsvValue('3.5', { type: 'REAL' }, { convertTypes: true }), 3.5);
  assert.throws(() => convertCsvValue('nope', { type: 'INTEGER' }, { convertTypes: true }), /INTEGER/);
});

test('imports as one transaction and rolls back constraints and cancellation', async () => {
  const SQL = await initSqlJs({ locateFile: (file) => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file) });
  const db = new SQL.Database();
  db.run('CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)');
  const columns = [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'TEXT' }];
  const mapping = [{ csvIndex: 0, tableColumn: 'id' }, { csvIndex: 1, tableColumn: 'name' }];

  assert.deepEqual(importCsvRows(db, { tableName: 'people', columns, mapping, rows: [['1', 'Ada'], ['2', 'Grace']], lineNumbers: [2, 3], convertTypes: true }), { inserted: 2 });
  assert.equal(queryAll(db, 'SELECT COUNT(*) AS count FROM people')[0].count, 2);
  assert.throws(() => importCsvRows(db, { tableName: 'people', columns, mapping, rows: [['3', 'Lin'], ['4', 'Lin']], lineNumbers: [4, 5], convertTypes: true }), /line 5/);
  assert.equal(queryAll(db, 'SELECT COUNT(*) AS count FROM people')[0].count, 2);
  assert.throws(() => importCsvRows(db, { tableName: 'people', columns, mapping, rows: [['5', 'A'], ['6', 'B']], lineNumbers: [6, 7], convertTypes: true, isCancelled: () => true }), /cancelled/i);
  assert.equal(queryAll(db, 'SELECT COUNT(*) AS count FROM people')[0].count, 2);
  db.close();
});
