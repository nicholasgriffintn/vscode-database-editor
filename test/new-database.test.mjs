import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import initSqlJs from 'sql.js';

import {
  NEW_DATABASE_SAVE_OPTIONS,
  createEmptySqliteBytes,
  createNewDatabase,
} from '../dist/new-database.js';

const SQL = await initSqlJs({
  locateFile: (file) => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file),
});

test('creates valid empty SQLite bytes', () => {
  const bytes = createEmptySqliteBytes(SQL);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 16)), 'SQLite format 3\0');

  const database = new SQL.Database(bytes);
  assert.deepEqual(database.exec("SELECT COUNT(*) AS count FROM sqlite_schema")[0].values, [[0]]);
  database.close();
});

test('new database workflow writes and opens file and non-file destinations', async () => {
  for (const destination of [
    { scheme: 'file', path: '/tmp/example.sqlite' },
    { scheme: 'database-test', path: '/workspace/example.sqlite' },
  ]) {
    const writes = [];
    const opens = [];
    const result = await createNewDatabase({
      showSaveDialog: async (options) => {
        assert.deepEqual(options, NEW_DATABASE_SAVE_OPTIONS);
        return destination;
      },
      createDatabaseBytes: async () => createEmptySqliteBytes(SQL),
      writeFile: async (uri, bytes) => writes.push({ uri, bytes }),
      openDatabase: async (uri) => opens.push(uri),
    });

    assert.equal(result, destination);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].uri, destination);
    assert.equal(new TextDecoder().decode(writes[0].bytes.slice(0, 16)), 'SQLite format 3\0');
    assert.deepEqual(opens, [destination]);
  }
});

test('cancelled save dialog creates nothing and failed writes never open an editor', async () => {
  let byteCreations = 0;
  const cancelled = await createNewDatabase({
    showSaveDialog: async () => undefined,
    createDatabaseBytes: async () => {
      byteCreations += 1;
      return new Uint8Array();
    },
    writeFile: async () => assert.fail('cancelled workflow must not write'),
    openDatabase: async () => assert.fail('cancelled workflow must not open'),
  });
  assert.equal(cancelled, undefined);
  assert.equal(byteCreations, 0);

  await assert.rejects(createNewDatabase({
    showSaveDialog: async () => ({ scheme: 'file', path: '/tmp/failure.sqlite' }),
    createDatabaseBytes: async () => createEmptySqliteBytes(SQL),
    writeFile: async () => { throw new Error('write failed'); },
    openDatabase: async () => assert.fail('failed writes must not open'),
  }), /write failed/);
});
