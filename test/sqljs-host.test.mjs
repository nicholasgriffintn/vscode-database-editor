import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { initializeSqlJs, loadSqlJs } from '../dist/sqljs-host.js';
import { getSchemaObjects, readTableMetadata } from '../media/database/client.mjs';

test('the shipped SQLite runtime supports FTS5 databases', async () => {
  const SQL = await initializeSqlJs(process.cwd());
  const db = new SQL.Database();
  try {
    db.run('CREATE VIRTUAL TABLE documents USING fts5(title, body)');
    db.run('INSERT INTO documents (title, body) VALUES (?, ?)', ['Release notes', 'Search databases from VS Code']);

    assert.deepEqual(db.exec("SELECT title FROM documents WHERE documents MATCH 'databases'")[0]?.values, [
      ['Release notes'],
    ]);

    const reopened = new SQL.Database(db.export());
    try {
      const tables = readTableMetadata(reopened, getSchemaObjects(reopened));
      const documents = tables.find(({ name }) => name === 'documents');

      assert.deepEqual(documents.columns.map(({ name }) => name), ['title', 'body']);
      assert.deepEqual(documents.hiddenColumns.map(({ name }) => name), ['documents', 'rank']);
    } finally {
      reopened.close();
    }
  } finally {
    db.close();
  }
});

test('a rejected sql.js initialization can be retried', async () => {
  const extensionPath = path.join(process.cwd(), '.tmp', 'sqljs-host-retry');
  const vendorPath = path.join(extensionPath, 'media', 'vendor', 'sqljs');
  await mkdir(vendorPath, { recursive: true });
  await writeFile(path.join(vendorPath, 'sql-wasm.js'), `
    let attempts = 0;
    module.exports = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('simulated initialization failure');
      return { Database: class {} };
    };
  `);

  const extensionUri = { fsPath: extensionPath };
  await assert.rejects(loadSqlJs(extensionUri), /simulated initialization failure/);
  const SQL = await loadSqlJs(extensionUri);

  assert.equal(typeof SQL.Database, 'function');
});
