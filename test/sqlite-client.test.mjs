import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';

import {
  getRowCount,
  getSchemaObjects,
  hasRowid,
  queryAll,
  queryGridRows,
  readTableMetadata,
  runSqlScript,
  runWrite,
  runWriteBatch,
} from '../media/sqlite-client.mjs';
import { analyzeSqlScript, buildDelete, buildTableSelect, buildUpdate } from '../media/sql-utils.mjs';

async function createDatabase() {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file),
  });
  return new SQL.Database();
}

async function createPeopleDatabase() {
  const db = await createDatabase();
  db.run('CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT UNIQUE)');
  db.run("INSERT INTO people (name) VALUES ('Ada')");
  return db;
}

function rows(db, sql) {
  return db.exec(sql)[0]?.values ?? [];
}

test('discovers SQLite objects and table metadata', async () => {
  const db = await createDatabase();

  db.run('CREATE TABLE people (id INTEGER PRIMARY KEY, team_id INTEGER REFERENCES teams(id), name TEXT NOT NULL)');
  db.run('CREATE TABLE teams (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  db.run('CREATE INDEX people_name ON people (name)');
  db.run('CREATE TRIGGER people_name_check BEFORE INSERT ON people WHEN NEW.name = "" BEGIN SELECT RAISE(ABORT, "name required"); END');
  db.run('INSERT INTO teams (name) VALUES (?)', ['Core']);
  db.run('INSERT INTO people (team_id, name) VALUES (?, ?)', [1, 'Ada']);

  const schemaObjects = getSchemaObjects(db);
  const tables = readTableMetadata(db, schemaObjects);
  const people = tables.find((table) => table.name === 'people');

  assert.equal(hasRowid(db, 'people'), true);
  assert.equal(getRowCount(db, 'people', people.columns), 1);
  assert.deepEqual(tables.map((table) => table.name), ['people', 'teams']);
  assert.equal(people.indexes[0].name, 'people_name');
  assert.equal(people.triggers[0].name, 'people_name_check');
  assert.equal(people.foreignKeys[0].table, 'teams');
  assert.deepEqual(people.columns.map((column) => ({
    name: column.name,
    affinity: column.affinity,
    keyKind: column.keyKind,
    indexed: column.indexed,
    foreignKeyTarget: column.foreignKeyTarget,
  })), [
    { name: 'id', affinity: 'INTEGER', keyKind: 'PK', indexed: false, foreignKeyTarget: null },
    { name: 'team_id', affinity: 'INTEGER', keyKind: 'FK', indexed: false, foreignKeyTarget: 'teams.id' },
    { name: 'name', affinity: 'TEXT', keyKind: null, indexed: true, foreignKeyTarget: null },
  ]);
  db.close();
});

test('configures every database connection with enforced foreign keys', async () => {
  const db = await createDatabase();
  const { configureDatabase } = await import('../media/sqlite-client.mjs');

  configureDatabase(db);
  db.run('CREATE TABLE parents (id INTEGER PRIMARY KEY)');
  db.run('CREATE TABLE children (parent_id INTEGER REFERENCES parents(id) ON UPDATE CASCADE ON DELETE RESTRICT)');
  db.run('CREATE TABLE cascade_children (parent_id INTEGER REFERENCES parents(id) ON DELETE CASCADE)');
  db.run('INSERT INTO parents (id) VALUES (1), (2)');
  db.run('INSERT INTO children (parent_id) VALUES (1)');
  db.run('INSERT INTO cascade_children (parent_id) VALUES (2)');

  assert.equal(rows(db, 'PRAGMA foreign_keys')[0][0], 1);
  assert.throws(() => db.run('INSERT INTO children (parent_id) VALUES (999)'), /FOREIGN KEY/);
  db.run('UPDATE parents SET id = 3 WHERE id = 1');
  assert.equal(rows(db, 'SELECT parent_id FROM children')[0][0], 3);
  assert.throws(() => db.run('DELETE FROM parents WHERE id = 3'), /FOREIGN KEY/);
  db.run('DELETE FROM parents WHERE id = 2');
  assert.equal(rows(db, 'SELECT COUNT(*) FROM cascade_children')[0][0], 0);
  db.close();

  const webviewSource = await readFile(new URL('../media/webview.mjs', import.meta.url), 'utf8');
  const toolsSource = await readFile(new URL('../src/sqlite-ai/tools.ts', import.meta.url), 'utf8');
  assert.match(
    webviewSource,
    /const nextDatabase = new SQL\.Database\([^;]+\);\s*configureDatabase\(nextDatabase\);/,
  );
  assert.match(toolsSource, /configureDatabase\(db\);/);
});

test('database configuration fails visibly when foreign keys remain disabled', async () => {
  const { configureDatabase } = await import('../media/sqlite-client.mjs');
  const db = {
    run() {},
    exec() {
      return [{ columns: ['foreign_keys'], values: [[0]] }];
    },
  };

  assert.throws(
    () => configureDatabase(db),
    /could not enable SQLite foreign key enforcement/i,
  );
});

test.todo('discovers virtual and stored generated columns as read-only metadata', async () => {
  const db = await createDatabase();
  db.run(`CREATE TABLE generated_people (
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    full_name TEXT GENERATED ALWAYS AS (first_name || ' ' || last_name) VIRTUAL,
    name_length INTEGER GENERATED ALWAYS AS (length(first_name) + length(last_name)) STORED
  )`);

  const table = readTableMetadata(db, getSchemaObjects(db))
    .find((candidate) => candidate.name === 'generated_people');

  assert.deepEqual(table.columns.map((column) => ({
    name: column.name,
    generated: column.generated,
    readOnly: column.readOnly,
  })), [
    { name: 'first_name', generated: false, readOnly: false },
    { name: 'last_name', generated: false, readOnly: false },
    { name: 'full_name', generated: 'virtual', readOnly: true },
    { name: 'name_length', generated: 'stored', readOnly: true },
  ]);
  db.close();
});

test('orders real WITHOUT ROWID chunks by canonical composite primary-key metadata', async () => {
  const db = await createDatabase();
  db.run('CREATE TABLE memberships (tenant_id INTEGER, user_id INTEGER, label TEXT, PRIMARY KEY (tenant_id, user_id)) WITHOUT ROWID');
  for (let index = 0; index < 12; index += 1) {
    db.run('INSERT INTO memberships VALUES (?, ?, ?)', [Math.floor(index / 4), index % 4, `row ${index}`]);
  }

  const table = readTableMetadata(db, getSchemaObjects(db))
    .find((candidate) => candidate.name === 'memberships');
  const firstQuery = buildTableSelect({
    tableName: table.name,
    columns: table.columns,
    includeRowid: table.hasRowid,
    limit: 5,
    offset: 0,
  });
  const secondQuery = buildTableSelect({
    tableName: table.name,
    columns: table.columns,
    includeRowid: table.hasRowid,
    limit: 5,
    offset: 5,
  });

  assert.match(firstQuery.sql, /ORDER BY "tenant_id" ASC, "user_id" ASC/);
  const combined = [
    ...queryGridRows(db, { table, query: firstQuery, resultScope: 'memberships', offset: 0 }),
    ...queryGridRows(db, { table, query: secondQuery, resultScope: 'memberships', offset: 5 }),
  ];
  assert.equal(new Set(combined.map((row) => `${row.values.tenant_id}:${row.values.user_id}`)).size, 10);
  assert.deepEqual(combined[0].identity, {
    kind: 'primaryKey',
    values: { tenant_id: 0n, user_id: 0n },
  });

  const update = buildUpdate({
    tableName: table.name,
    columnName: 'label',
    identity: combined[0].identity,
    primaryKeyColumns: table.primaryKeyColumns,
  });
  runWrite(db, update.sql, ['updated first chunk', ...update.identityParams], { expectedRowsModified: 1 });
  const deletion = buildDelete({
    tableName: table.name,
    identity: combined[7].identity,
    primaryKeyColumns: table.primaryKeyColumns,
  });
  runWrite(db, deletion.sql, deletion.params, { expectedRowsModified: 1 });
  assert.equal(queryAll(db, "SELECT COUNT(*) AS count FROM memberships WHERE label = 'updated first chunk'")[0].count, 1);
  assert.equal(queryAll(db, 'SELECT COUNT(*) AS count FROM memberships')[0].count, 11);
  db.close();
});

test('preserves rowid identity above Number.MAX_SAFE_INTEGER without rounding', async () => {
  const db = await createDatabase();
  db.run('CREATE TABLE large_rowids (value TEXT)');
  db.run("INSERT INTO large_rowids (rowid, value) VALUES (9007199254740992, 'neighbor'), (9007199254740993, 'target')");
  const table = readTableMetadata(db, getSchemaObjects(db))
    .find((candidate) => candidate.name === 'large_rowids');
  const query = buildTableSelect({
    tableName: table.name,
    columns: table.columns,
    includeRowid: table.hasRowid,
    rowidAlias: table.rowidAlias,
    limit: 10,
    offset: 0,
  });
  const gridRows = queryGridRows(db, { table, query, resultScope: 'large-rowids' });
  const target = gridRows.find((row) => row.values.value === 'target');
  const neighbor = gridRows.find((row) => row.values.value === 'neighbor');

  assert.equal(target.identity.value, 9007199254740993n);
  assert.equal(neighbor.identity.value, 9007199254740992n);

  const update = buildUpdate({
    tableName: table.name,
    columnName: 'value',
    identity: target.identity,
    primaryKeyColumns: table.primaryKeyColumns,
    rowidAlias: table.rowidAlias,
  });
  runWrite(db, update.sql, ['updated', ...update.identityParams], { expectedRowsModified: 1 });
  const deletion = buildDelete({
    tableName: table.name,
    identity: neighbor.identity,
    primaryKeyColumns: table.primaryKeyColumns,
    rowidAlias: table.rowidAlias,
  });
  runWrite(db, deletion.sql, deletion.params, { expectedRowsModified: 1 });

  assert.deepEqual(queryAll(db, 'SELECT value FROM large_rowids'), [{ value: 'updated' }]);
  db.close();
});

test('keeps hidden row identity separate from colliding displayed columns', async () => {
  const db = await createDatabase();
  db.run('CREATE TABLE collisions (rowid TEXT, __database_editor_identity TEXT, value TEXT)');
  db.run("INSERT INTO collisions (rowid, __database_editor_identity, value) VALUES ('declared', 'displayed', 'target')");
  const table = readTableMetadata(db, getSchemaObjects(db))
    .find((candidate) => candidate.name === 'collisions');
  const query = buildTableSelect({
    tableName: table.name,
    columns: table.columns,
    includeRowid: table.hasRowid,
    rowidAlias: table.rowidAlias,
    limit: 10,
    offset: 0,
  });
  const [row] = queryGridRows(db, { table, query, resultScope: 'collisions' });

  assert.equal(table.rowidAlias, '_rowid_');
  assert.equal(row.values.rowid, 'declared');
  assert.equal(row.values.__database_editor_identity, 'displayed');
  assert.equal(row.identity.kind, 'rowid');
  assert.equal(typeof row.identity.value, 'bigint');

  db.run('CREATE TABLE all_aliases (rowid TEXT, _rowid_ TEXT, oid TEXT, id INTEGER PRIMARY KEY)');
  const allAliases = readTableMetadata(db, getSchemaObjects(db))
    .find((candidate) => candidate.name === 'all_aliases');
  assert.equal(allAliases.rowidAlias, null);
  assert.deepEqual(allAliases.primaryKeyColumns, ['id']);
  db.close();
});

test('assigns result-scoped positional identities to browse-only duplicate rows', async () => {
  const db = await createDatabase();
  db.run('CREATE TABLE source (value TEXT)');
  db.run("INSERT INTO source VALUES ('duplicate'), ('duplicate')");
  db.run('CREATE VIEW duplicate_view AS SELECT value FROM source');
  const table = readTableMetadata(db, getSchemaObjects(db))
    .find((candidate) => candidate.name === 'duplicate_view');
  const query = buildTableSelect({
    tableName: table.name,
    columns: table.columns,
    includeRowid: false,
    limit: 10,
    offset: 0,
  });
  const resultRows = queryGridRows(db, { table, query, resultScope: 'duplicate-view:1' });

  assert.deepEqual(resultRows.map((row) => row.values.value), ['duplicate', 'duplicate']);
  assert.deepEqual(resultRows.map((row) => row.identity), [
    { kind: 'visiblePosition', resultId: 'duplicate-view:1', position: 0 },
    { kind: 'visiblePosition', resultId: 'duplicate-view:1', position: 1 },
  ]);
  assert.throws(() => buildDelete({
    tableName: table.name,
    identity: resultRows[0].identity,
    primaryKeyColumns: [],
  }), /browse-only row cannot be edited/i);
  db.close();
});

test('rolls back failed writes', async () => {
  const db = await createDatabase();

  db.run('CREATE TABLE people (name TEXT NOT NULL)');
  assert.throws(() => runWrite(db, 'INSERT INTO people (name) VALUES (?)', [null]), /NOT NULL/);
  assert.deepEqual(queryAll(db, 'SELECT * FROM people'), []);
  db.close();
});

test('constraint and duplicate-schema failures leave the existing database unchanged', async () => {
  const db = await createDatabase();
  db.run('CREATE TABLE unique_names (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)');
  db.run("INSERT INTO unique_names (name) VALUES ('existing')");

  assert.throws(
    () => runWrite(db, 'INSERT INTO unique_names (name) VALUES (?)', ['existing']),
    /UNIQUE constraint failed/,
  );
  assert.deepEqual(queryAll(db, 'SELECT name FROM unique_names'), [{ name: 'existing' }]);

  assert.throws(
    () => runWrite(db, 'CREATE TABLE unique_names (id INTEGER PRIMARY KEY)'),
    /already exists/,
  );
  assert.deepEqual(queryAll(db, 'PRAGMA table_info("unique_names")').map((column) => column.name), ['id', 'name']);
  db.close();
});

test('runs multiple generated writes in one transaction', async () => {
  const db = await createDatabase();
  db.run('CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  db.run('INSERT INTO people (name) VALUES (?), (?), (?)', ['Ada', 'Grace', 'Katherine']);

  runWriteBatch(db, [
    { sql: 'DELETE FROM people WHERE name = ?', params: ['Ada'] },
    { sql: 'DELETE FROM people WHERE name = ?', params: ['Grace'] },
  ]);

  assert.deepEqual(queryAll(db, 'SELECT name FROM people ORDER BY id').map((row) => row.name), ['Katherine']);
  db.close();
});

test('rolls back batch writes when any statement fails', async () => {
  const db = await createDatabase();
  db.run('CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)');
  db.run('INSERT INTO people (name) VALUES (?), (?)', ['Ada', 'Grace']);

  assert.throws(() => runWriteBatch(db, [
    { sql: 'DELETE FROM people WHERE name = ?', params: ['Ada'] },
    { sql: 'INSERT INTO people (name) VALUES (?)', params: ['Grace'] },
  ]), /UNIQUE/);

  assert.deepEqual(queryAll(db, 'SELECT name FROM people ORDER BY id').map((row) => row.name), ['Ada', 'Grace']);
  db.close();
});

test('queryAll enforces soft timeout between stepped rows', async () => {
  const db = await createDatabase();
  db.run('CREATE TABLE numbers (value INTEGER)');
  db.run('INSERT INTO numbers (value) VALUES (1), (2), (3)');
  let now = 0;

  assert.throws(
    () => queryAll(db, 'SELECT value FROM numbers ORDER BY value', [], {
      timeoutMs: 1,
      now: () => now += 1,
    }),
    /timed out after 1 ms/,
  );
  db.close();
});

test('runs read-only SQL scripts and reports unchanged result sets', async () => {
  const db = await createPeopleDatabase();

  const result = runSqlScript(db, 'SELECT name FROM people', analyzeSqlScript('SELECT name FROM people'));

  assert.equal(result.changed, false);
  assert.deepEqual(result.results, [{ columns: ['name'], values: [['Ada']] }]);
  db.close();
});

test('runs successful mutating SQL scripts inside an automatic transaction', async () => {
  const db = await createPeopleDatabase();

  const result = runSqlScript(db, "INSERT INTO people (name) VALUES ('Grace')", analyzeSqlScript("INSERT INTO people (name) VALUES ('Grace')"));

  assert.equal(result.changed, true);
  assert.deepEqual(result.results, []);
  assert.deepEqual(rows(db, 'SELECT name FROM people ORDER BY id'), [['Ada'], ['Grace']]);
  db.close();
});

test('returns result sets from mixed mutating SQL scripts', async () => {
  const db = await createPeopleDatabase();
  const sql = "INSERT INTO people (name) VALUES ('Grace'); SELECT name FROM people ORDER BY id;";

  const result = runSqlScript(db, sql, analyzeSqlScript(sql));

  assert.equal(result.changed, true);
  assert.deepEqual(result.results, [{ columns: ['name'], values: [['Ada'], ['Grace']] }]);
  db.close();
});

test('rolls back automatic transaction when a mutating SQL script fails', async () => {
  const db = await createPeopleDatabase();
  const sql = "INSERT INTO people (name) VALUES ('Grace'); INSERT INTO people (name) VALUES ('Ada');";

  assert.throws(() => runSqlScript(db, sql, analyzeSqlScript(sql)), /UNIQUE constraint failed/);
  assert.deepEqual(rows(db, 'SELECT name FROM people ORDER BY id'), [['Ada']]);
  db.close();
});

test('does not wrap scripts that provide explicit transaction control', async () => {
  const db = await createPeopleDatabase();
  const sql = "BEGIN; INSERT INTO people (name) VALUES ('Grace'); COMMIT;";

  const result = runSqlScript(db, sql, analyzeSqlScript(sql));

  assert.equal(result.changed, true);
  assert.deepEqual(rows(db, 'SELECT name FROM people ORDER BY id'), [['Ada'], ['Grace']]);
  db.close();
});

test('rejects explicit SQL scripts that leave a transaction open', async () => {
  const db = await createPeopleDatabase();
  const sql = "BEGIN; INSERT INTO people (name) VALUES ('Grace');";

  assert.throws(
    () => runSqlScript(db, sql, analyzeSqlScript(sql)),
    /must include COMMIT, ROLLBACK, or matching RELEASE/i,
  );
  assert.equal(rows(db, 'PRAGMA transaction_state')[0]?.[0] ?? 'NONE', 'NONE');
  db.close();
});

test('rejects explicit SQL scripts that leave nested savepoints open', async () => {
  const db = await createPeopleDatabase();
  const sql = "SAVEPOINT outer; SAVEPOINT inner; INSERT INTO people (name) VALUES ('Grace'); RELEASE inner;";

  assert.throws(
    () => runSqlScript(db, sql, analyzeSqlScript(sql)),
    /matching RELEASE/i,
  );
  db.close();
});

test('rejects unmatched transaction closes before executing the script', async () => {
  const db = await createPeopleDatabase();
  const sql = "COMMIT; INSERT INTO people (name) VALUES ('Grace');";

  assert.throws(
    () => runSqlScript(db, sql, analyzeSqlScript(sql)),
    /unmatched transaction close/i,
  );
  assert.deepEqual(rows(db, 'SELECT name FROM people ORDER BY id'), [['Ada']]);
  db.close();
});

test('complete explicit rollback and savepoint scripts leave no pending changes', async () => {
  const db = await createPeopleDatabase();
  const rollbackSql = "BEGIN; INSERT INTO people (name) VALUES ('Grace'); ROLLBACK;";
  const savepointSql = "SAVEPOINT outer; INSERT INTO people (name) VALUES ('Katherine'); SAVEPOINT inner; RELEASE inner; RELEASE outer;";

  runSqlScript(db, rollbackSql, analyzeSqlScript(rollbackSql));
  assert.deepEqual(rows(db, 'SELECT name FROM people ORDER BY id'), [['Ada']]);

  runSqlScript(db, savepointSql, analyzeSqlScript(savepointSql));
  assert.deepEqual(rows(db, 'SELECT name FROM people ORDER BY id'), [['Ada'], ['Katherine']]);
  db.close();
});

test('flags failed explicit transaction scripts when a prior commit may have changed the database', async () => {
  const db = await createPeopleDatabase();
  const sql = "BEGIN; INSERT INTO people (name) VALUES ('Grace'); COMMIT; SELECT * FROM missing_table;";

  assert.throws(
    () => runSqlScript(db, sql, analyzeSqlScript(sql)),
    (error) => {
      assert.match(error.message, /no such table: missing_table/);
      assert.equal(error.databaseChanged, true);
      return true;
    },
  );
  assert.deepEqual(rows(db, 'SELECT name FROM people ORDER BY id'), [['Ada'], ['Grace']]);
  db.close();
});
