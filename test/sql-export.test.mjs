import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import initSqlJs from 'sql.js';

import {
  SqlExportCancelledError,
  exportSqlDatabase,
} from '../dist/sql-export.js';
import { createBufferedSqlExportSink, createFileSqlExportSink } from '../dist/sql-export-sinks.js';

const SQL = await initSqlJs({
  locateFile: (file) => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file),
});

test('streams a fidelity-preserving dump with data before triggers and bounded buffering', async () => {
  const source = new SQL.Database();
  source.run('CREATE TABLE source (id INTEGER PRIMARY KEY, value TEXT NOT NULL, payload BLOB)');
  source.run('CREATE TABLE audit (source_id INTEGER NOT NULL, value TEXT NOT NULL)');
  source.run(`CREATE TRIGGER source_audit AFTER INSERT ON source BEGIN
    INSERT INTO audit (source_id, value) VALUES (NEW.id, NEW.value);
  END`);
  source.run('CREATE INDEX source_value ON source (value)');
  source.run('CREATE VIEW source_values AS SELECT id, value FROM source');
  source.run('CREATE TABLE exact_values (value INTEGER PRIMARY KEY)');
  source.run('INSERT INTO exact_values VALUES (9007199254740993)');
  source.run('CREATE TABLE generated_values (raw TEXT, normalized TEXT GENERATED ALWAYS AS (lower(raw)) VIRTUAL)');
  source.run("INSERT INTO generated_values (raw) VALUES ('MiXeD')");
  for (let index = 1; index <= 2_500; index += 1) {
    source.run('INSERT INTO source (id, value, payload) VALUES (?, ?, ?)', [
      index,
      `value-${index}`,
      new Uint8Array([index % 256, (index + 1) % 256]),
    ]);
  }

  const sink = new RecordingSink();
  const stats = await exportSqlDatabase(source, sink, { chunkTargetBytes: 4_096 });
  const dump = sink.content;

  assert.ok(dump.indexOf('CREATE TABLE source') < dump.indexOf('INSERT INTO "source"'));
  assert.ok(dump.lastIndexOf('INSERT INTO "audit"') < dump.indexOf('CREATE TRIGGER source_audit'));
  assert.ok(dump.lastIndexOf('INSERT INTO "source"') < dump.indexOf('CREATE INDEX source_value'));
  assert.ok(dump.indexOf('CREATE INDEX source_value') < dump.indexOf('CREATE VIEW source_values'));
  assert.ok(sink.largestChunkBytes <= 8_192, 'row batching should remain bounded near the target size');
  assert.equal(stats.rowsExported, 5_002);
  assert.equal(stats.maxBufferedRows < 100, true);
  assert.match(dump, /INSERT INTO "exact_values" \("value"\) VALUES \(9007199254740993\)/);
  assert.doesNotMatch(dump, /INSERT INTO "generated_values" \("raw", "normalized"\)/);

  const restored = new SQL.Database();
  restored.exec(dump);
  assert.deepEqual(rows(restored, 'SELECT * FROM source ORDER BY id'), rows(source, 'SELECT * FROM source ORDER BY id'));
  assert.deepEqual(rows(restored, 'SELECT * FROM audit ORDER BY source_id'), rows(source, 'SELECT * FROM audit ORDER BY source_id'));
  assert.deepEqual(rows(restored, 'SELECT * FROM generated_values'), rows(source, 'SELECT * FROM generated_values'));
  assert.equal(rows(restored, 'SELECT COUNT(*) AS count FROM audit')[0].count, 2_500);

  restored.close();
  source.close();
});

test('cancellation aborts the sink so partial exports can be removed', async () => {
  const source = new SQL.Database();
  source.run('CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT)');
  for (let index = 0; index < 1_000; index += 1) {
    source.run('INSERT INTO entries (value) VALUES (?)', [`entry-${index}`]);
  }
  const cancellation = { isCancellationRequested: false };
  const sink = new RecordingSink(() => {
    cancellation.isCancellationRequested = true;
  });

  await assert.rejects(
    exportSqlDatabase(source, sink, { cancellation, chunkTargetBytes: 512 }),
    SqlExportCancelledError,
  );
  assert.equal(sink.completed, false);
  assert.equal(sink.aborted, true);
  source.close();
});

test('file sinks remove partial output on abort and complete successful streams', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'database-editor-export-'));
  const cancelledPath = path.join(directory, 'cancelled.sql');
  const completedPath = path.join(directory, 'completed.sql');
  try {
    await writeFile(cancelledPath, 'previous export');
    const cancelled = createFileSqlExportSink(cancelledPath);
    await cancelled.write('partial');
    await cancelled.abort();
    await access(cancelledPath);
    assert.equal(await readFile(cancelledPath, 'utf8'), 'previous export');

    const completed = createFileSqlExportSink(completedPath);
    await completed.write('complete');
    await completed.complete();
    assert.equal(await readFile(completedPath, 'utf8'), 'complete');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('non-file sinks enforce a bounded fallback before writing', async () => {
  const writes = [];
  const sink = createBufferedSqlExportSink({
    maxBytes: 8,
    writeFile: async (bytes) => writes.push(bytes),
  });
  await sink.write('1234');
  await assert.rejects(sink.write('56789'), /exceeded the 8 byte non-file limit/i);
  await sink.abort();
  assert.equal(writes.length, 0);
});

class RecordingSink {
  chunks = [];
  completed = false;
  aborted = false;
  largestChunkBytes = 0;

  constructor(onFirstWrite = () => {}) {
    this.onFirstWrite = onFirstWrite;
  }

  get content() {
    return this.chunks.join('');
  }

  async write(chunk) {
    this.chunks.push(chunk);
    this.largestChunkBytes = Math.max(this.largestChunkBytes, Buffer.byteLength(chunk));
    if (this.chunks.length === 1) this.onFirstWrite();
  }

  async complete() {
    this.completed = true;
  }

  async abort() {
    this.aborted = true;
    this.chunks = [];
  }
}

function rows(database, sql) {
  const result = database.exec(sql)[0];
  return result.values.map((values) => Object.fromEntries(result.columns.map((column, index) => [column, values[index]])));
}
