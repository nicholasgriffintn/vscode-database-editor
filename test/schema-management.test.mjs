import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';

import {
  buildAddColumn,
  buildCreateTable,
  buildDropColumn,
  buildDropTable,
  buildRenameTable,
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

test('rejects unsafe or incomplete schema management input', () => {
  assert.throws(() => buildCreateTable({ tableName: '', columns: [] }), /Table name is required/);
  assert.throws(() => buildCreateTable({ tableName: 'x', columns: [] }), /At least one column/);
  assert.throws(() => buildAddColumn({ tableName: 'x', column: { name: '', type: 'TEXT' } }), /Column name is required/);
  assert.throws(() => buildAddColumn({ tableName: 'x', column: { name: 'bad', type: 'TEXT); DROP TABLE x; --' } }), /Unsupported column type/);
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
  db.run('INSERT INTO tasks (title) VALUES (?)', ['Ship editor']);
  assert.deepEqual(queryAll(db, 'SELECT title, done FROM tasks'), [{ title: 'Ship editor', done: 0 }]);

  db.run(buildRenameTable({ oldName: 'tasks', newName: 'todo_items' }));
  assert.equal(queryAll(db, 'SELECT COUNT(*) AS count FROM todo_items')[0].count, 1);

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
