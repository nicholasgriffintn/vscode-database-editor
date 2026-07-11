import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';

import {
  buildAddColumn,
  buildCreateIndex,
  buildCreateTable,
  buildDropColumn,
  buildDropIndex,
  buildDropTable,
  buildRenameTable,
  parseIndexColumnNames,
} from '../media/schema-management.mjs';
import { queryAll } from '../media/sqlite-client.mjs';

test('builds schema management statements with quoted identifiers', () => {
  assert.equal(
    buildCreateTable({
      tableName: 'project tasks',
      columns: [{ name: 'id', type: 'INTEGER', primaryKey: true }, { name: 'title', type: 'TEXT', notNull: true }],
    }),
    'CREATE TABLE "project tasks" ("id" INTEGER PRIMARY KEY, "title" TEXT NOT NULL)',
  );
  assert.equal(buildRenameTable({ oldName: 'project tasks', newName: 'tasks' }), 'ALTER TABLE "project tasks" RENAME TO "tasks"');
  assert.equal(buildDropTable({ tableName: 'tasks' }), 'DROP TABLE "tasks"');
  assert.equal(buildAddColumn({ tableName: 'tasks', column: { name: 'done', type: 'INTEGER', notNull: true, defaultValue: '0' } }), 'ALTER TABLE "tasks" ADD COLUMN "done" INTEGER NOT NULL DEFAULT 0');
  assert.equal(buildDropColumn({ tableName: 'tasks', columnName: 'done' }), 'ALTER TABLE "tasks" DROP COLUMN "done"');
});

test('builds composite and unique indexes with quoted identifiers and optional sort direction', () => {
  assert.equal(buildCreateIndex({
    indexName: 'people "lookup"',
    tableName: 'people records',
    columns: [
      { name: 'last name', direction: 'DESC' },
      { name: 'first name' },
    ],
    unique: true,
  }), 'CREATE UNIQUE INDEX "people ""lookup""" ON "people records" ("last name" DESC, "first name")');
  assert.equal(buildDropIndex({ indexName: 'people "lookup"' }), 'DROP INDEX "people ""lookup"""');
  assert.deepEqual(parseIndexColumnNames('last name, first name', 'desc'), [
    { name: 'last name', direction: 'DESC' },
    { name: 'first name', direction: 'DESC' },
  ]);
});

test('rejects unsafe or incomplete schema management input', () => {
  assert.throws(() => buildCreateTable({ tableName: '', columns: [] }), /Table name is required/);
  assert.throws(() => buildCreateTable({ tableName: 'x', columns: [] }), /At least one column/);
  assert.throws(() => buildAddColumn({ tableName: 'x', column: { name: '', type: 'TEXT' } }), /Column name is required/);
  assert.throws(() => buildAddColumn({ tableName: 'x', column: { name: 'bad', type: 'TEXT); DROP TABLE x; --' } }), /Unsupported column type/);
  assert.throws(() => buildCreateIndex({ indexName: '', tableName: 'x', columns: ['id'] }), /Index name is required/);
  assert.throws(() => buildCreateIndex({ indexName: 'x_id', tableName: 'x', columns: [] }), /At least one index column/);
  assert.throws(() => buildCreateIndex({ indexName: 'x_id', tableName: 'x', columns: [{ name: 'id', direction: 'SIDEWAYS' }] }), /sort direction/);
  assert.throws(() => buildDropIndex({ indexName: 'sqlite_autoindex_x_1' }), /managed by SQLite/);
});

test('generated schema management statements work against SQLite', async () => {
  const db = await createDatabase();

  db.run(buildCreateTable({
    tableName: 'tasks',
    columns: [
      { name: 'id', type: 'INTEGER', primaryKey: true },
      { name: 'title', type: 'TEXT', notNull: true },
    ],
  }));
  db.run(buildAddColumn({ tableName: 'tasks', column: { name: 'done', type: 'INTEGER', defaultValue: '0' } }));
  db.run(buildCreateIndex({
    indexName: 'tasks title lookup',
    tableName: 'tasks',
    columns: [{ name: 'title', direction: 'DESC' }, { name: 'done' }],
    unique: true,
  }));
  assert.throws(() => db.run(buildCreateIndex({
    indexName: 'tasks title lookup',
    tableName: 'tasks',
    columns: ['title'],
  })), /already exists/);
  assert.equal(queryAll(db, "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'index' AND name = 'tasks title lookup'")[0].count, 1);
  db.run('INSERT INTO tasks (title) VALUES (?)', ['Ship editor']);
  assert.deepEqual(queryAll(db, 'SELECT title, done FROM tasks'), [{ title: 'Ship editor', done: 0 }]);

  db.run(buildRenameTable({ oldName: 'tasks', newName: 'todo_items' }));
  assert.equal(queryAll(db, 'SELECT COUNT(*) AS count FROM todo_items')[0].count, 1);

  db.run(buildDropIndex({ indexName: 'tasks title lookup' }));

  db.run(buildDropColumn({ tableName: 'todo_items', columnName: 'done' }));
  assert.deepEqual(queryAll(db, 'PRAGMA table_info("todo_items")').map((column) => column.name), ['id', 'title']);

  db.run(buildDropTable({ tableName: 'todo_items' }));
  assert.deepEqual(queryAll(db, "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'todo_items'"), []);
  db.close();
});

async function createDatabase() {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file),
  });
  return new SQL.Database();
}
