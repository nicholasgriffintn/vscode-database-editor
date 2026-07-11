import { getDumpSchemaObjects, getInsertableColumnNames } from './sqlite-schema';
import type { SqlJsDatabase, SqlJsStatement } from './sqljs-host';
import { throwIfCancellationRequested, type CancellationState } from './utilities/cancellation';
import { quoteIdentifier, serializeSqlLiteral, terminateSqlStatement } from './utilities/sql';
import { TextChunkBuffer } from './utilities/text-chunk-buffer';

export interface SqlExportSink {
  write(chunk: string): Promise<void>;
  complete(): Promise<void>;
  abort(): Promise<void>;
}

export type SqlExportCancellation = CancellationState;

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
  const buffer = new TextChunkBuffer(sink, options.chunkTargetBytes);
  let rowsExported = 0;
  let maxBufferedRows = 0;

  try {
    assertSqlExportActive(cancellation);
    const objects = getDumpSchemaObjects(database);
    const tables = objects.filter((object) => object.type === 'table');
    await buffer.append('PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n');
    for (const table of tables) {
      assertSqlExportActive(cancellation);
      await buffer.append(`${terminateSqlStatement(table.sql)}\n`);
    }
    await buffer.flush();

    for (const table of tables) {
      const columns = getInsertableColumnNames(database, table.name);
      if (columns.length === 0) {
        continue;
      }
      const statement = database.prepare(
        `SELECT ${columns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(table.name)}`,
      );
      try {
        let bufferedRows = 0;
        while (statement.step()) {
          assertSqlExportActive(cancellation);
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
        assertSqlExportActive(cancellation);
        await buffer.append(`${terminateSqlStatement(object.sql)}\n`);
      }
    }
    await buffer.append('COMMIT;\n');
    await buffer.flush();
    assertSqlExportActive(cancellation);
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

function getExactRow(statement: SqlJsStatement): unknown[] {
  return statement.get?.(null, { useBigInt: true }) ?? Object.values(statement.getAsObject());
}

function buildInsert(tableName: string, columns: string[], values: unknown[]): string {
  return `INSERT INTO ${quoteIdentifier(tableName)} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${values.map(serializeSqlLiteral).join(', ')});\n`;
}

function assertSqlExportActive(cancellation?: SqlExportCancellation): void {
  throwIfCancellationRequested(cancellation, () => new SqlExportCancelledError());
}
