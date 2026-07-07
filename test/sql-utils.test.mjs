import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';

import {
  buildSqlDump,
  buildDelete,
  buildInsert,
  buildTableCount,
  buildTableSelect,
  buildUpdate,
  isReadOnlyQuery,
  parseCellInput,
  quoteIdentifier,
  toCsv,
} from '../media/sql-utils.mjs';

const columns = [
  { name: 'id', type: 'INTEGER' },
  { name: 'display name', type: 'TEXT' },
  { name: 'score', type: 'REAL' },
];

test('quotes SQLite identifiers safely', () => {
  assert.equal(quoteIdentifier('plain'), '"plain"');
  assert.equal(quoteIdentifier('has " quote'), '"has "" quote"');
});

test('builds filtered, sorted, paged table selects with bound parameters', () => {
  const query = buildTableSelect({
    tableName: 'people',
    columns,
    filter: 'ada',
    sortColumn: 'display name',
    sortDirection: 'desc',
    limit: 50,
    offset: 100,
  });

  assert.equal(
    query.sql,
    'SELECT rowid AS __database_editor_rowid, "id", "display name", "score" FROM "people" WHERE CAST("id" AS TEXT) LIKE ? OR CAST("display name" AS TEXT) LIKE ? OR CAST("score" AS TEXT) LIKE ? ORDER BY "display name" DESC LIMIT ? OFFSET ?',
  );
  assert.deepEqual(query.params, ['%ada%', '%ada%', '%ada%', 50, 100]);
});

test('builds count query with the same filtering rules', () => {
  const query = buildTableCount({ tableName: 'people', columns, filter: 'ada' });

  assert.equal(
    query.sql,
    'SELECT COUNT(*) AS count FROM "people" WHERE CAST("id" AS TEXT) LIKE ? OR CAST("display name" AS TEXT) LIKE ? OR CAST("score" AS TEXT) LIKE ?',
  );
  assert.deepEqual(query.params, ['%ada%', '%ada%', '%ada%']);
});

test('builds write statements without interpolating values', () => {
  assert.deepEqual(buildInsert({ tableName: 'people', values: { id: 1, 'display name': 'Ada' } }), {
    sql: 'INSERT INTO "people" ("id", "display name") VALUES (?, ?)',
    params: [1, 'Ada'],
  });

  assert.deepEqual(buildUpdate({
    tableName: 'people',
    columnName: 'display name',
    identity: { rowid: 9, primaryKey: {} },
    primaryKeyColumns: [],
  }), {
    sql: 'UPDATE "people" SET "display name" = ? WHERE rowid = ?',
    identityParams: [9],
  });

  assert.deepEqual(buildDelete({
    tableName: 'people',
    identity: { rowid: null, primaryKey: { id: 1 } },
    primaryKeyColumns: ['id'],
  }), {
    sql: 'DELETE FROM "people" WHERE "id" IS ?',
    params: [1],
  });
});

test('parses edited values using declared column types', () => {
  assert.equal(parseCellInput('42', { name: 'id', type: 'INTEGER' }, ''), 42);
  assert.equal(parseCellInput('4.5', { name: 'score', type: 'REAL' }, ''), 4.5);
  assert.equal(parseCellInput('Ada', { name: 'display name', type: 'TEXT' }, ''), 'Ada');
  assert.equal(parseCellInput(null, { name: 'display name', type: 'TEXT' }, ''), null);
  assert.throws(() => parseCellInput('Ada', { name: 'id', type: 'INTEGER' }, ''), /expects an integer/);
  assert.throws(() => parseCellInput('12abc', { name: 'id', type: 'INTEGER' }, ''), /expects an integer/);
  assert.throws(() => parseCellInput('4.5ms', { name: 'score', type: 'REAL' }, ''), /expects a numeric/);
});

test('allows only SELECT statements in the query runner', () => {
  assert.equal(isReadOnlyQuery('SELECT * FROM people'), true);
  assert.equal(isReadOnlyQuery('/* inspect */ WITH visible AS (SELECT * FROM people) SELECT * FROM visible'), true);
  assert.equal(isReadOnlyQuery('-- comment\nSELECT 1'), true);
  assert.equal(isReadOnlyQuery('WITH deleted AS (DELETE FROM people RETURNING *) SELECT * FROM deleted'), false);
  assert.equal(isReadOnlyQuery('UPDATE people SET name = "Ada"'), false);
  assert.equal(isReadOnlyQuery('SELECT * FROM people; DROP TABLE people'), false);
});

test('exports visible rows as standards-compatible CSV', () => {
  const csv = toCsv(['id', 'name', 'notes'], [
    { id: 1, name: 'Ada', notes: 'comma, quote " and newline\ninside' },
    { id: 2, name: null, notes: new Uint8Array([1, 2, 3]) },
  ]);

  assert.equal(csv, 'id,name,notes\n1,Ada,"comma, quote "" and newline\ninside"\n2,,[BLOB 3 bytes]\n');
});

test('exports schema and table data as a SQL dump', () => {
  const dump = buildSqlDump({
    schema: [
      'CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT)',
      'CREATE INDEX people_name ON people (name)',
    ],
    tables: [
      {
        name: 'people',
        columns: ['id', 'name'],
        rows: [
          { id: 1, name: 'Ada' },
          { id: 2, name: "Grace O'Connor" },
          { id: 3, name: null },
        ],
      },
    ],
  });

  assert.equal(dump, [
    'BEGIN TRANSACTION;',
    'CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT);',
    'CREATE INDEX people_name ON people (name);',
    'INSERT INTO "people" ("id", "name") VALUES (1, \'Ada\');',
    'INSERT INTO "people" ("id", "name") VALUES (2, \'Grace O\'\'Connor\');',
    'INSERT INTO "people" ("id", "name") VALUES (3, NULL);',
    'COMMIT;',
    '',
  ].join('\n'));
});

test('generated statements work against SQLite', async () => {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file),
  });
  const db = new SQL.Database();

  db.run('CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL)');
  db.run('INSERT INTO people (name, score) VALUES (?, ?), (?, ?)', ['Ada', 9.5, 'Grace', 8]);

  const select = buildTableSelect({
    tableName: 'people',
    columns: [
      { name: 'id', type: 'INTEGER' },
      { name: 'name', type: 'TEXT' },
      { name: 'score', type: 'REAL' },
    ],
    filter: 'Ada',
    sortColumn: 'score',
    sortDirection: 'desc',
    limit: 10,
    offset: 0,
  });
  const rows = executeRows(db, select.sql, select.params);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Ada');

  const update = buildUpdate({
    tableName: 'people',
    columnName: 'score',
    identity: { rowid: rows[0].__database_editor_rowid, primaryKey: {} },
    primaryKeyColumns: [],
  });
  db.run(update.sql, [10, ...update.identityParams]);
  assert.equal(executeRows(db, 'SELECT score FROM people WHERE name = ?', ['Ada'])[0].score, 10);

  const insertion = buildInsert({ tableName: 'people', values: { name: 'Katherine', score: 9.8 } });
  db.run(insertion.sql, insertion.params);
  assert.equal(executeRows(db, 'SELECT COUNT(*) AS count FROM people')[0].count, 3);

  const deletion = buildDelete({
    tableName: 'people',
    identity: { rowid: null, primaryKey: { id: 2 } },
    primaryKeyColumns: ['id'],
  });
  db.run(deletion.sql, deletion.params);
  assert.deepEqual(executeRows(db, 'SELECT name FROM people ORDER BY id').map((row) => row.name), ['Ada', 'Katherine']);
  db.close();
});

function executeRows(db, sql, params = []) {
  const statement = db.prepare(sql);
  try {
    statement.bind(params);
    const rows = [];
    while (statement.step()) {
      rows.push(statement.getAsObject());
    }
    return rows;
  } finally {
    statement.free();
  }
}
