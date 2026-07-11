import { parentPort } from 'node:worker_threads';

import { capRows, isReadOnlyQuery, quoteIdentifier } from './sql-safety';
import { configureDatabase, initializeSqlJs } from './sqljs-host';
import type { SqlJsStatic } from './sqljs-host';
import { getColumns, inferRedactedOutputColumns, compileSensitivePatterns } from './tools/query-redaction';
import { executeRows, getColumnsInfo, getRowCount, getSchemaObjects } from './tools/schema-helpers';
import { getDatabaseMetadataContext } from './tools/database-context';

export type SqlWorkerRequest = { database: Uint8Array } & (
  | { operation: 'query'; query: string; rowLimit: number; sensitiveColumnPatterns: string[] }
  | { operation: 'explain'; query: string }
  | { operation: 'profile'; objectName: string }
  | { operation: 'context'; objectName?: string; offset?: number; limit?: number }
);

export type SqlWorkerQueryResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
};

export type SqlWorkerExplainResult = { plan: Record<string, unknown>[] };
export type SqlWorkerProfileResult = {
  objectName: string;
  rowCount: number | null;
  columns: Array<{ name: string; nullCount: number; distinctCount: number }>;
};
export type SqlWorkerContextResult = Record<string, unknown>;

export type SqlWorkerResult<TRequest extends SqlWorkerRequest> =
  TRequest extends { operation: 'query' } ? SqlWorkerQueryResult
    : TRequest extends { operation: 'explain' } ? SqlWorkerExplainResult
      : TRequest extends { operation: 'profile' } ? SqlWorkerProfileResult
        : SqlWorkerContextResult;

export type SqlWorkerResponse =
  | { ok: true; value: SqlWorkerQueryResult | SqlWorkerExplainResult | SqlWorkerProfileResult | SqlWorkerContextResult }
  | { ok: false; error: string };

if (parentPort) {
  parentPort.once('message', async (message: { extensionPath: string; request: SqlWorkerRequest }) => {
    try {
      const SQL = await initializeSqlJs(message.extensionPath);
      parentPort?.postMessage({ ok: true, value: executeSqlWorkerRequest(SQL, message.request) } satisfies SqlWorkerResponse);
    } catch (error) {
      parentPort?.postMessage({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies SqlWorkerResponse);
    }
  });
}

export function executeSqlWorkerRequest<TRequest extends SqlWorkerRequest>(
  SQL: SqlJsStatic,
  request: TRequest,
): SqlWorkerResult<TRequest> {
  const db = new SQL.Database(request.database);
  try {
    configureDatabase(db);
    switch (request.operation) {
      case 'query': {
        if (!isReadOnlyQuery(request.query)) {
          throw new Error('Only one read-only SELECT or safe WITH query is allowed.');
        }
        const rowLimit = Math.max(1, Math.min(500, Math.floor(request.rowLimit)));
        const patterns = compileSensitivePatterns(request.sensitiveColumnPatterns);
        const rows = executeRows(db, request.query, rowLimit + 1);
        const columns = rows.length > 0 ? Object.keys(rows[0]) : getColumns(db, request.query);
        const redactedColumns = inferRedactedOutputColumns(request.query, columns, patterns, db);
        const capped = capRows(rows, rowLimit, patterns, redactedColumns);
        return { columns, ...capped, rowCount: capped.rows.length } as SqlWorkerResult<TRequest>;
      }
      case 'explain':
        if (!isReadOnlyQuery(request.query)) {
          throw new Error('Only one read-only SELECT or safe WITH query can be explained.');
        }
        return { plan: executeRows(db, `EXPLAIN QUERY PLAN ${request.query}`) } as SqlWorkerResult<TRequest>;
      case 'profile': {
        if (!getSchemaObjects(db, request.objectName)[0]) {
          throw new Error(`SQLite object '${request.objectName}' was not found.`);
        }
        const rowCount = getRowCount(db, request.objectName);
        const columns = getColumnsInfo(db, request.objectName).map((column) => {
          const name = String((column as { name: unknown }).name);
          const quoted = quoteIdentifier(name);
          const stats = executeRows(
            db,
            `SELECT COUNT(*) - COUNT(${quoted}) AS nullCount, COUNT(DISTINCT ${quoted}) AS distinctCount FROM ${quoteIdentifier(request.objectName)}`,
            1,
          )[0] ?? {};
          return { name, nullCount: Number(stats.nullCount ?? 0), distinctCount: Number(stats.distinctCount ?? 0) };
        });
        return { objectName: request.objectName, rowCount, columns } as SqlWorkerResult<TRequest>;
      }
      case 'context':
        return getDatabaseMetadataContext(db, request) as SqlWorkerResult<TRequest>;
    }
  } finally {
    db.close();
  }
}
