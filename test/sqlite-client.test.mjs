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
  runWrite,
} from '../media/sqlite-client.mjs';

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

async function createDatabase() {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file),
  });
  return new SQL.Database();
}
