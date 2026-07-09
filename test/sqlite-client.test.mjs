import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';

import {
  getRowCount,
  getSchemaObjects,
  hasRowid,
  queryAll,
  readTableMetadata,
  runSqlScript,
  runWrite,
  runWriteBatch,
} from '../media/sqlite-client.mjs';
import { analyzeSqlScript } from '../media/sql-utils.mjs';

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

test('rolls back failed writes', async () => {
  const db = await createDatabase();

  db.run('CREATE TABLE people (name TEXT NOT NULL)');
  assert.throws(() => runWrite(db, 'INSERT INTO people (name) VALUES (?)', [null]), /NOT NULL/);
  assert.deepEqual(queryAll(db, 'SELECT * FROM people'), []);
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
