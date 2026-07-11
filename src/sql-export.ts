import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import { finished } from 'node:stream/promises';

import type { SqlJsDatabase, SqlJsStatement } from './sqlite-ai/sqljs-host';

export interface SqlExportSink {
  write(chunk: string): Promise<void>;
  complete(): Promise<void>;
  abort(): Promise<void>;
}

export interface SqlExportCancellation {
  readonly isCancellationRequested: boolean;
}

export type SqlExportProgress = {
  tableName: string;
  rowsExported: number;
};

export type SqlExportStats = {
  rowsExported: number;
  maxBufferedRows: number;
};

export class SqlExportCancelledError extends Error {
  constructor() {
    super('SQL export was cancelled.');
    this.name = 'SqlExportCancelledError';
  }
}

export function createFileSqlExportSink(filePath: string): SqlExportSink {
  const partialPath = `${filePath}.database-editor-partial-${randomUUID()}`;
  const stream = createWriteStream(partialPath, { encoding: 'utf8' });
  let completed = false;
  return {
    write: async (chunk) => {
      await new Promise<void>((resolve, reject) => {
        stream.write(chunk, 'utf8', (error) => error ? reject(error) : resolve());
      });
    },
    complete: async () => {
      stream.end();
      await finished(stream);
      await rename(partialPath, filePath);
      completed = true;
    },
    abort: async () => {
      if (!completed && !stream.closed) {
        await new Promise<void>((resolve) => {
          stream.once('close', resolve);
          stream.destroy();
        });
      }
      await rm(partialPath, { force: true });
    },
  };
}

export function createBufferedSqlExportSink({
  maxBytes,
  writeFile,
}: {
  maxBytes: number;
  writeFile: (content: Uint8Array) => Promise<void>;
}): SqlExportSink {
  const limit = Math.max(1, Math.floor(maxBytes));
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  return {
    write: async (chunk) => {
      const bytes = Buffer.from(chunk, 'utf8');
      if (totalBytes + bytes.byteLength > limit) {
        throw new Error(`SQL export exceeded the ${limit} byte non-file limit.`);
      }
      chunks.push(bytes);
      totalBytes += bytes.byteLength;
    },
    complete: async () => {
      const content = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        content.set(chunk, offset);
        offset += chunk.byteLength;
      }
      await writeFile(content);
      chunks.length = 0;
      totalBytes = 0;
    },
    abort: async () => {
      chunks.length = 0;
      totalBytes = 0;
    },
  };
}

type SchemaObject = {
  type: 'table' | 'index' | 'trigger' | 'view';
  name: string;
  tableName: string;
  sql: string;
};

export async function exportSqlDatabase(
  database: SqlJsDatabase,
  sink: SqlExportSink,
  options: {
    cancellation?: SqlExportCancellation;
    chunkTargetBytes?: number;
    onProgress?: (progress: SqlExportProgress) => void;
  } = {},
): Promise<SqlExportStats> {
  const cancellation = options.cancellation;
  const buffer = new SqlChunkBuffer(sink, options.chunkTargetBytes);
  let rowsExported = 0;
  let maxBufferedRows = 0;

  try {
    throwIfCancelled(cancellation);
    const objects = readSchemaObjects(database);
    const tables = objects.filter((object) => object.type === 'table');
    await buffer.append('PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n');
    for (const table of tables) {
      throwIfCancelled(cancellation);
      await buffer.append(`${terminateStatement(table.sql)}\n`);
    }
    await buffer.flush();

    for (const table of tables) {
      const columns = readInsertableColumns(database, table.name);
      if (columns.length === 0) {
        continue;
      }
      const statement = database.prepare(
        `SELECT ${columns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(table.name)}`,
      );
      try {
        let bufferedRows = 0;
        while (statement.step()) {
          throwIfCancelled(cancellation);
          const values = getExactRow(statement);
          const flushed = await buffer.append(buildInsert(table.name, columns, values));
          bufferedRows = flushed ? 1 : bufferedRows + 1;
          rowsExported += 1;
          maxBufferedRows = Math.max(maxBufferedRows, bufferedRows);
          if (rowsExported % 500 === 0) {
            options.onProgress?.({ tableName: table.name, rowsExported });
          }
        }
      } finally {
        statement.free();
      }
      await buffer.flush();
      options.onProgress?.({ tableName: table.name, rowsExported });
    }

    for (const type of ['index', 'trigger', 'view'] as const) {
      for (const object of objects.filter((candidate) => candidate.type === type)) {
        throwIfCancelled(cancellation);
        await buffer.append(`${terminateStatement(object.sql)}\n`);
      }
    }
    await buffer.append('COMMIT;\n');
    await buffer.flush();
    throwIfCancelled(cancellation);
    await sink.complete();
    return { rowsExported, maxBufferedRows };
  } catch (error) {
    try {
      await sink.abort();
    } catch {
      // Preserve the export error; sinks perform best-effort partial cleanup.
    }
    throw error;
  }
}

class SqlChunkBuffer {
  private chunks: string[] = [];
  private bytes = 0;
  private readonly targetBytes: number;

  constructor(private readonly sink: SqlExportSink, targetBytes = 64 * 1024) {
    this.targetBytes = Math.max(256, Math.floor(targetBytes));
  }

  async append(chunk: string): Promise<boolean> {
    const chunkBytes = Buffer.byteLength(chunk);
    let flushed = false;
    if (this.bytes > 0 && this.bytes + chunkBytes > this.targetBytes) {
      await this.flush();
      flushed = true;
    }
    this.chunks.push(chunk);
    this.bytes += chunkBytes;
    return flushed;
  }

  async flush(): Promise<void> {
    if (this.chunks.length === 0) {
      return;
    }
    const content = this.chunks.join('');
    this.chunks = [];
    this.bytes = 0;
    await this.sink.write(content);
  }
}

function readSchemaObjects(database: SqlJsDatabase): SchemaObject[] {
  const shadowTables = readShadowTableNames(database);
  const statement = database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE sql IS NOT NULL
      AND name NOT LIKE 'sqlite_%'
      AND type IN ('table', 'index', 'trigger', 'view')
    ORDER BY rowid
  `);
  const objects: SchemaObject[] = [];
  try {
    while (statement.step()) {
      const row = statement.getAsObject();
      const name = String(row.name);
      const tableName = String(row.tbl_name);
      if (isSchemaObjectType(row.type) && !shadowTables.has(name) && !shadowTables.has(tableName)) {
        objects.push({ type: row.type, name, tableName, sql: String(row.sql) });
      }
    }
  } finally {
    statement.free();
  }
  return objects;
}

function readShadowTableNames(database: SqlJsDatabase): Set<string> {
  const names = new Set<string>();
  let statement: SqlJsStatement | undefined;
  try {
    statement = database.prepare('PRAGMA table_list');
    while (statement.step()) {
      const row = statement.getAsObject();
      if (row.type === 'shadow') {
        names.add(String(row.name));
      }
    }
  } catch {
    // Older SQLite builds do not expose table_list; their virtual-table handling remains unchanged.
  } finally {
    statement?.free();
  }
  return names;
}

function readInsertableColumns(database: SqlJsDatabase, tableName: string): string[] {
  const statement = database.prepare(`PRAGMA table_xinfo(${quoteIdentifier(tableName)})`);
  const columns: string[] = [];
  try {
    while (statement.step()) {
      const row = statement.getAsObject();
      if (Number(row.hidden ?? 0) === 0) {
        columns.push(String(row.name));
      }
    }
  } finally {
    statement.free();
  }
  return columns;
}

function getExactRow(statement: SqlJsStatement): unknown[] {
  return statement.get?.(null, { useBigInt: true }) ?? Object.values(statement.getAsObject());
}

function buildInsert(tableName: string, columns: string[], values: unknown[]): string {
  return `INSERT INTO ${quoteIdentifier(tableName)} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${values.map(serializeSqlLiteral).join(', ')});\n`;
}

function serializeSqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function terminateStatement(sql: string): string {
  const trimmed = sql.trim();
  return trimmed.endsWith(';') ? trimmed : `${trimmed};`;
}

function throwIfCancelled(cancellation?: SqlExportCancellation): void {
  if (cancellation?.isCancellationRequested) {
    throw new SqlExportCancelledError();
  }
}

function isSchemaObjectType(value: unknown): value is SchemaObject['type'] {
  return value === 'table' || value === 'index' || value === 'trigger' || value === 'view';
}
