import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';

import {
  analyzeSqlScript,
  buildRowCopyContent,
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
    'SELECT rowid AS __database_editor_rowid, "id", "display name", "score" FROM "people" WHERE CAST("id" AS TEXT) LIKE ? OR CAST("display name" AS TEXT) LIKE ? OR CAST("score" AS TEXT) LIKE ? ORDER BY "display name" DESC, rowid ASC LIMIT ? OFFSET ?',
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

test('builds table queries with global and per-column filters', () => {
  const query = buildTableSelect({
    tableName: 'people',
    columns,
    filter: 'ada',
    columnFilters: {
      id: '>= 10',
      'display name': 'hopper',
      score: 'not null',
    },
    sortColumn: null,
    sortDirection: 'asc',
    limit: 25,
    offset: 0,
  });

  assert.equal(
    query.sql,
    'SELECT rowid AS __database_editor_rowid, "id", "display name", "score" FROM "people" WHERE (CAST("id" AS TEXT) LIKE ? OR CAST("display name" AS TEXT) LIKE ? OR CAST("score" AS TEXT) LIKE ?) AND "id" >= ? AND CAST("display name" AS TEXT) LIKE ? AND "score" IS NOT NULL ORDER BY rowid ASC LIMIT ? OFFSET ?',
  );
  assert.deepEqual(query.params, ['%ada%', '%ada%', '%ada%', '10', '%hopper%', 25, 0]);
});

test.todo('orders without-rowid table chunks by canonical primary-key metadata', () => {
  const query = buildTableSelect({
    tableName: 'memberships',
    columns: [
      { name: 'tenant_id', type: 'INTEGER', primaryKeyOrder: 1 },
      { name: 'user_id', type: 'INTEGER', primaryKeyOrder: 2 },
    ],
    includeRowid: false,
    limit: 50,
    offset: 0,
  });

  assert.equal(
    query.sql,
    'SELECT "tenant_id", "user_id" FROM "memberships" ORDER BY "tenant_id" ASC, "user_id" ASC LIMIT ? OFFSET ?',
  );
});

test.todo('keeps hidden row identity separate from a displayed alias-collision column', () => {
  const query = buildTableSelect({
    tableName: 'alias_collision',
    columns: [
      { name: 'id', type: 'INTEGER', primaryKeyOrder: 1 },
      { name: '__database_editor_rowid', type: 'TEXT', primaryKeyOrder: 0 },
    ],
    includeRowid: true,
    limit: 50,
    offset: 0,
  });

  assert.doesNotMatch(query.sql, /rowid AS __database_editor_rowid/i);
  assert.match(query.sql, /"alias_collision"\.(?:rowid|oid|_rowid_)/i);
});

test.todo('qualifies hidden identity so a declared rowid column cannot shadow it', () => {
  const query = buildTableSelect({
    tableName: 'declared_rowid',
    columns: [
      { name: 'rowid', type: 'TEXT', primaryKeyOrder: 0 },
      { name: 'value', type: 'TEXT', primaryKeyOrder: 0 },
    ],
    includeRowid: true,
    limit: 50,
    offset: 0,
  });

  assert.doesNotMatch(query.sql, /SELECT rowid AS/i);
  assert.match(query.sql, /"declared_rowid"\.(?:oid|_rowid_)/i);
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

test('analyzes read-only SQL scripts without mutating flags', () => {
  assert.deepEqual(analyzeSqlScript('SELECT * FROM people'), {
    statements: ['SELECT * FROM people'],
    statementCount: 1,
    isEmpty: false,
    isReadOnly: true,
    mutates: false,
    hasTransactionControl: false,
    isMultiStatement: false,
    transactionControl: [],
    leavesTransactionOpen: false,
    hasUnmatchedTransactionClose: false,
    openSavepointCount: 0,
  });
  assert.equal(analyzeSqlScript('/* inspect */ WITH visible AS (SELECT * FROM people) SELECT * FROM visible').isReadOnly, true);
  assert.equal(analyzeSqlScript('-- comment\nSELECT 1').isReadOnly, true);
  assert.equal(analyzeSqlScript('PRAGMA table_info(people)').isReadOnly, true);
});

test('analyzes mutating and transaction-controlled SQL scripts', () => {
  assert.equal(analyzeSqlScript('UPDATE people SET name = "Ada"').mutates, true);

  const mixed = analyzeSqlScript("INSERT INTO people(name) VALUES ('Ada'); SELECT * FROM people;");
  assert.deepEqual(mixed.statements, ["INSERT INTO people(name) VALUES ('Ada')", 'SELECT * FROM people']);
  assert.equal(mixed.mutates, true);
  assert.equal(mixed.isMultiStatement, true);

  const ddl = analyzeSqlScript('CREATE TABLE notes(id INTEGER); INSERT INTO notes VALUES (1);');
  assert.equal(ddl.mutates, true);
  assert.equal(ddl.statementCount, 2);

  const explicitTransaction = analyzeSqlScript("BEGIN; UPDATE people SET name = 'Ada'; COMMIT;");
  assert.equal(explicitTransaction.mutates, true);
  assert.equal(explicitTransaction.hasTransactionControl, true);
});

test('reports transaction and savepoint balance for incomplete scripts', () => {
  const openTransaction = analyzeSqlScript('BEGIN; INSERT INTO notes VALUES (1);');
  assert.equal(openTransaction.leavesTransactionOpen, true);
  assert.equal(openTransaction.hasUnmatchedTransactionClose, false);
  assert.deepEqual(openTransaction.transactionControl, ['begin']);

  const nestedSavepoint = analyzeSqlScript('SAVEPOINT outer; SAVEPOINT inner; RELEASE inner;');
  assert.equal(nestedSavepoint.leavesTransactionOpen, true);
  assert.equal(nestedSavepoint.openSavepointCount, 1);
  assert.deepEqual(nestedSavepoint.transactionControl, ['savepoint', 'savepoint', 'release']);
});

test('reports unmatched transaction closes without treating complete scripts as open', () => {
  const unmatched = analyzeSqlScript('COMMIT; SELECT 1;');
  assert.equal(unmatched.hasUnmatchedTransactionClose, true);
  assert.equal(unmatched.leavesTransactionOpen, false);

  const complete = analyzeSqlScript('BEGIN; SAVEPOINT inner; RELEASE inner; COMMIT;');
  assert.equal(complete.hasUnmatchedTransactionClose, false);
  assert.equal(complete.leavesTransactionOpen, false);

  const explicitStillOpen = analyzeSqlScript('BEGIN; SAVEPOINT inner; RELEASE inner;');
  assert.equal(explicitStillOpen.hasUnmatchedTransactionClose, false);
  assert.equal(explicitStillOpen.leavesTransactionOpen, true);

  const rollbackTo = analyzeSqlScript('SAVEPOINT outer; SAVEPOINT inner; ROLLBACK TO outer; RELEASE outer;');
  assert.equal(rollbackTo.hasUnmatchedTransactionClose, false);
  assert.equal(rollbackTo.leavesTransactionOpen, false);
});

test('analyzes SQL scripts without splitting comments or quoted semicolons', () => {
  const analysis = analyzeSqlScript("-- comment ;\nINSERT INTO notes(body) VALUES ('hello; still one statement'); SELECT 'done; ok';");
  assert.deepEqual(analysis.statements, [
    "INSERT INTO notes(body) VALUES ('hello; still one statement')",
    "SELECT 'done; ok'",
  ]);
  assert.equal(analysis.statementCount, 2);
  assert.equal(analysis.mutates, true);
});

test('keeps read-only query compatibility wrapper for Copilot/tool callers', () => {
  assert.equal(isReadOnlyQuery('SELECT * FROM people'), true);
  assert.equal(isReadOnlyQuery('WITH deleted AS (DELETE FROM people RETURNING *) SELECT * FROM deleted'), false);
  assert.equal(isReadOnlyQuery('SELECT * FROM people; SELECT 1'), false);
});

test('exports visible rows as standards-compatible CSV', () => {
  const csv = toCsv(['id', 'name', 'notes'], [
    { id: 1, name: 'Ada', notes: 'comma, quote " and newline\ninside' },
    { id: 2, name: null, notes: new Uint8Array([1, 2, 3]) },
  ]);

  assert.equal(csv, 'id,name,notes\n1,Ada,"comma, quote "" and newline\ninside"\n2,,[BLOB 3 bytes]\n');
});

test('copies selected rows in viewer-friendly formats', () => {
  const copyColumns = ['id', 'display name', 'notes'];
  const rows = [
    { id: 1, 'display name': 'Ada Lovelace', notes: 'first programmer' },
    { id: 2, 'display name': 'Grace Hopper', notes: 'comma, quote " and pipe |' },
    { id: 3, 'display name': null, notes: new Uint8Array([1, 2, 3]) },
  ];

  assert.equal(
    buildRowCopyContent({ format: 'tsv', columns: copyColumns, rows }),
    'id\tdisplay name\tnotes\n1\tAda Lovelace\tfirst programmer\n2\tGrace Hopper\tcomma, quote " and pipe |\n3\t\t[BLOB 3 bytes]\n',
  );
  assert.equal(
    buildRowCopyContent({ format: 'csv', columns: copyColumns, rows }),
    'id,display name,notes\n1,Ada Lovelace,first programmer\n2,Grace Hopper,"comma, quote "" and pipe |"\n3,,[BLOB 3 bytes]\n',
  );
  assert.equal(
    buildRowCopyContent({ format: 'sqlite-inserts', tableName: 'people', columns: copyColumns, rows }),
    'INSERT INTO "people" ("id", "display name", "notes") VALUES (1, \'Ada Lovelace\', \'first programmer\');\nINSERT INTO "people" ("id", "display name", "notes") VALUES (2, \'Grace Hopper\', \'comma, quote " and pipe |\');\nINSERT INTO "people" ("id", "display name", "notes") VALUES (3, NULL, X\'010203\');\n',
  );
  assert.equal(
    buildRowCopyContent({ format: 'json-objects', columns: copyColumns, rows }),
    '[\n  {\n    "id": 1,\n    "display name": "Ada Lovelace",\n    "notes": "first programmer"\n  },\n  {\n    "id": 2,\n    "display name": "Grace Hopper",\n    "notes": "comma, quote \\" and pipe |"\n  },\n  {\n    "id": 3,\n    "display name": null,\n    "notes": "[BLOB 3 bytes]"\n  }\n]',
  );
  assert.equal(
    buildRowCopyContent({ format: 'json-arrays', columns: copyColumns, rows }),
    '[\n  [\n    1,\n    "Ada Lovelace",\n    "first programmer"\n  ],\n  [\n    2,\n    "Grace Hopper",\n    "comma, quote \\" and pipe |"\n  ],\n  [\n    3,\n    null,\n    "[BLOB 3 bytes]"\n  ]\n]',
  );
  assert.equal(
    buildRowCopyContent({ format: 'html', columns: copyColumns, rows }),
    '<table>\n  <thead><tr><th>id</th><th>display name</th><th>notes</th></tr></thead>\n  <tbody>\n    <tr><td>1</td><td>Ada Lovelace</td><td>first programmer</td></tr>\n    <tr><td>2</td><td>Grace Hopper</td><td>comma, quote &quot; and pipe |</td></tr>\n    <tr><td>3</td><td></td><td>[BLOB 3 bytes]</td></tr>\n  </tbody>\n</table>\n',
  );
  assert.equal(
    buildRowCopyContent({ format: 'markdown', columns: copyColumns, rows }),
    '| id | display name | notes |\n| --- | --- | --- |\n| 1 | Ada Lovelace | first programmer |\n| 2 | Grace Hopper | comma, quote " and pipe \\| |\n| 3 |  | [BLOB 3 bytes] |\n',
  );
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

test.todo('restores trigger-backed dumps without duplicating trigger-generated rows', async () => {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file),
  });
  const dump = buildSqlDump({
    schema: [
      'CREATE TABLE source (id INTEGER PRIMARY KEY, value TEXT NOT NULL)',
      'CREATE TABLE audit (source_id INTEGER NOT NULL, value TEXT NOT NULL)',
      `CREATE TRIGGER source_audit AFTER INSERT ON source BEGIN
        INSERT INTO audit (source_id, value) VALUES (NEW.id, NEW.value);
      END`,
    ],
    tables: [
      { name: 'source', columns: ['id', 'value'], rows: [{ id: 1, value: 'created once' }] },
      { name: 'audit', columns: ['source_id', 'value'], rows: [{ source_id: 1, value: 'created once' }] },
    ],
  });
  const restored = new SQL.Database();

  restored.exec(dump);

  assert.equal(executeRows(restored, 'SELECT COUNT(*) AS count FROM audit')[0].count, 1);
  restored.close();
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
